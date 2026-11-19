import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import { HttpError } from './security.js';
import { brisbaneToday } from './util.js';

// Licence photos are processed in memory only. Nothing in this module writes raw images anywhere;
// the front and back buffers are passed to Google Gemini for a single verification request and then released.

const ai = config.licenceAiEnabled ? new GoogleGenAI({ apiKey: config.geminiApiKey }) : null;

export const LicenceSchema = {
  type: 'object',
  properties: {
    is_drivers_licence: { type: 'boolean', description: 'True only if the front image shows a government-issued driver licence card.' },
    back_image_valid: { type: 'boolean', description: 'True if the back image shows the reverse of a driver licence card (or no back image required).' },
    image_quality_ok: { type: 'boolean', description: 'True if the name, date of birth, licence number, expiry date, and printed licence text are clearly legible.' },
    tampering_suspected: { type: 'boolean', description: 'True if either image shows signs of digital editing, mismatched fonts, portrait halos, a screen photo of a card, or baseline drift.' },
    tampering_indicators: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of visual tampering or spoofing anomalies observed, or empty array if clean.',
    },
    issuing_state: { type: 'string', enum: ['QLD', 'NSW', 'VIC', 'SA', 'WA', 'TAS', 'NT', 'ACT', 'OTHER', 'UNKNOWN'] },
    issuing_authority: { type: 'string', description: 'Issuing authority printed on card, e.g. Department of Transport and Main Roads QLD or Transport for NSW. Empty string if not visible.' },
    licence_type: { type: 'string', enum: ['open', 'provisional', 'learner', 'probationary', 'unknown'] },
    licence_class: { type: 'string', description: 'All vehicle class code(s) shown on front or back, e.g. "C", "C, RE". Empty string if not visible.' },
    full_name: { type: 'string', description: 'Full name exactly as printed on front. Empty string if not legible.' },
    date_of_birth: { type: 'string', description: 'YYYY-MM-DD, or empty string if not legible.' },
    licence_number: { type: 'string', description: 'Licence number as printed, or empty string if not legible.' },
    card_number: { type: 'string', description: 'Card number (front or back), or empty string if not legible.' },
    issue_date: { type: 'string', description: 'YYYY-MM-DD issue or effective date if shown, else empty string.' },
    expiry_date: { type: 'string', description: 'YYYY-MM-DD, or empty string if not legible.' },
    address_front: { type: 'string', description: 'Full residential address printed on front of card, or empty string if not shown.' },
    address_back: { type: 'string', description: 'Updated address sticker or address printed on the back of card, or empty string if none.' },
    conditions: { type: 'string', description: 'All licence conditions, restrictions, or codes printed on front or back (e.g. A, S, None). Empty string if none visible.' },
    automatic_only: { type: 'boolean', description: 'True if condition code "A" or "Automatic vehicles only" restriction is present on front or back.' },
    has_barcode: { type: 'boolean', description: 'True if a 2D PDF417 barcode or magnetic stripe is visible on the back of the card.' },
    security_features: {
      type: 'array',
      items: { type: 'string' },
      description: 'Observed anti-fraud features (e.g. holographic emblem, fine guilloche line pattern, laser-engraved portrait/DOB, PDF417 barcode).',
    },
    back_text_summary: { type: 'string', description: 'Summary of all printed text, endorsements, condition definitions, card number, or stickers on the back of the licence.' },
    brief_description: { type: 'string', description: 'Concise 1-2 sentence forensic summary citing document class, full name, issuing authority, expiry/validity, and security features.' },
    notes: { type: 'string', description: 'One short sentence about anything a human reviewer should check.' },
  },
  required: [
    'is_drivers_licence', 'back_image_valid', 'image_quality_ok', 'tampering_suspected', 'tampering_indicators',
    'issuing_state', 'issuing_authority', 'licence_type', 'licence_class', 'full_name', 'date_of_birth',
    'licence_number', 'card_number', 'issue_date', 'expiry_date', 'address_front', 'address_back',
    'conditions', 'automatic_only', 'has_barcode', 'security_features', 'back_text_summary',
    'brief_description', 'notes',
  ],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You inspect photos of BOTH the FRONT and BACK of Australian driver licences for a 6-speed manual van rental business on the Gold Coast, Queensland.
Extract every printed detail verbatim across both sides of the card: full name, date of birth, licence number, card number (front or back), issuing state & authority, licence type (open, provisional, learner, probationary), all vehicle classes (e.g. C, R), all conditions/restrictions (especially Condition A / automatic-only, Condition S / spectacles), issue date, expiry date, front address, any back change-of-address sticker, endorsements/notes, and back 2D PDF417 barcode presence.
Do not guess: if a field is unreadable or not present, return an empty string (or false for booleans, [] for arrays).
Dates must be returned as YYYY-MM-DD (Australian licences print dates as DD/MM/YYYY or DD MMM YYYY).
Forensically inspect both images for font inconsistencies, JPEG splicing, baseline drift, portrait halos, screen glare, or photographs of screens, and list any indicators.
Provide a concise 1-2 sentence factual brief_description summarizing the document class, full name, issuing authority, validity/expiry, and confirmed security features.
Your extracted details are matched automatically against what the customer typed and stored on their customer profile for Superadmin review.`;

export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length > 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

const nameTokens = (s) => String(s || '').toUpperCase().replace(/[^A-Z\s'-]/g, ' ').split(/[\s-]+/).filter(Boolean);
const normId = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function namesMatch(entered, extracted) {
  const a = nameTokens(entered);
  const b = new Set(nameTokens(extracted));
  if (a.length === 0 || b.size === 0) return false;
  // Every name the customer typed must appear on the card; middle names may be omitted.
  return a.every((t) => b.has(t)) && a.length >= Math.min(2, b.size);
}

/**
 * Evaluates extracted Gemini front + back licence data against the customer's submitted details.
 * Exported pure function so verification logic can be unit-tested deterministically.
 */
export function evaluateExtractedLicence(x, person, { hasBack = true, model = config.licenceModel } = {}) {
  if (!x || typeof x !== 'object') {
    return {
      status: 'pending',
      method: 'ai',
      model,
      notes: 'The licence could not be read automatically. An admin will review it.',
      extracted: null,
    };
  }
  if (!x.is_drivers_licence) {
    return {
      status: 'rejected',
      method: 'ai',
      model,
      notes: 'The front photo does not appear to be a driver licence. Please upload a clear photo of the front of your licence.',
      extracted: x,
    };
  }
  if (hasBack && x.back_image_valid === false) {
    return {
      status: 'rejected',
      method: 'ai',
      model,
      notes: 'The back photo does not appear to be the reverse side of a driver licence. Please upload both the front and back clearly.',
      extracted: x,
    };
  }
  if (!x.image_quality_ok) {
    return {
      status: 'rejected',
      method: 'ai',
      model,
      notes: 'The front or back photo is not clear enough. Please retake both in good light with all four corners visible.',
      extracted: x,
    };
  }
  if (x.licence_type === 'learner') {
    return { status: 'rejected', method: 'ai', model, notes: 'Learner licences cannot be used to hire a vehicle.', extracted: x };
  }
  if (x.expiry_date && x.expiry_date < brisbaneToday()) {
    return { status: 'rejected', method: 'ai', model, notes: 'This licence has expired.', extracted: x };
  }

  const problems = [];
  if (!namesMatch(person.fullName, x.full_name)) problems.push('name does not match');
  if (person.dob && x.date_of_birth !== person.dob) problems.push('date of birth does not match');
  if (normId(x.licence_number) !== normId(person.licenceNumber)) problems.push('licence number does not match');
  if (x.issuing_state !== person.licenceState) problems.push('issuing state does not match');
  if (!x.expiry_date) problems.push('expiry date not legible');

  if (problems.length) {
    return {
      status: 'rejected',
      method: 'ai',
      model,
      notes: `Details on the licence did not match what you entered (${problems.join(', ')}). Check your details and upload again.`,
      extracted: x,
    };
  }
  if (x.tampering_suspected) {
    return {
      status: 'pending',
      method: 'ai',
      model,
      notes: 'Your licence needs a quick manual check by our team.',
      extracted: x,
    };
  }
  if (x.automatic_only) {
    return {
      status: 'pending',
      method: 'ai',
      model,
      notes: 'An automatic-only condition (Code A) was detected on your licence. Because the Kangoo MAXI is a 6-speed manual, our team must review this manually.',
      extracted: x,
    };
  }
  if (x.licence_type === 'provisional' || x.licence_type === 'probationary') {
    return {
      status: 'pending',
      method: 'ai',
      model,
      notes: 'Provisional and probationary licences are reviewed manually by our team.',
      extracted: x,
    };
  }
  return { status: 'verified', method: 'ai', model, notes: 'Licence (front and back) verified automatically.', extracted: x };
}

/**
 * Verifies front (and back) licence photos against the customer's typed details.
 * Returns { status: 'verified'|'pending'|'rejected', method, model, notes, extracted }.
 */
export async function verifyLicence(frontBuffer, backBufferOrPerson, maybePerson) {
  const hasSeparateBack = Buffer.isBuffer(backBufferOrPerson) || backBufferOrPerson === null;
  const backBuffer = Buffer.isBuffer(backBufferOrPerson) ? backBufferOrPerson : null;
  const person = (hasSeparateBack ? maybePerson : backBufferOrPerson) || {};

  const frontType = detectImageType(frontBuffer);
  if (!frontType) throw new HttpError(400, 'Front licence photo must be a JPEG, PNG or WebP image.');
  const backType = backBuffer ? detectImageType(backBuffer) : null;
  if (backBuffer && !backType) throw new HttpError(400, 'Back licence photo must be a JPEG, PNG or WebP image.');

  if (!ai) {
    return {
      status: 'pending',
      method: 'manual',
      model: null,
      notes: 'Automatic verification is not configured. An admin will review your licence details.',
      extracted: null,
    };
  }

  const contents = [
    'FRONT OF DRIVER LICENCE:',
    { inlineData: { mimeType: frontType, data: frontBuffer.toString('base64') } },
    ...(backBuffer && backType
      ? ['BACK OF DRIVER LICENCE:', { inlineData: { mimeType: backType, data: backBuffer.toString('base64') } }]
      : []),
    backBuffer
      ? 'Extract every printed detail from both the front and back of this Australian driver licence.'
      : 'Extract every printed detail from this Australian driver licence.',
  ];

  const models = [...new Set([config.licenceModel, 'gemini-3.5-flash-lite'].filter(Boolean))];
  let response = null;
  let usedModel = null;
  let lastErr = null;

  for (const model of models) {
    try {
      response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseJsonSchema: LicenceSchema,
        },
      });
      usedModel = model;
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`[licence] Gemini AI model ${model} failed:`, err?.message || err);
    }
  }

  if (!response) {
    console.error('[licence] All Gemini AI models failed:', lastErr?.message || lastErr);
    return {
      status: 'pending',
      method: 'manual',
      model: null,
      notes: 'Automatic verification was unavailable. An admin will review your licence details.',
      extracted: null,
    };
  }

  let x = null;
  try {
    x = JSON.parse(response.text);
  } catch {
    return {
      status: 'pending',
      method: 'ai',
      model: usedModel,
      notes: 'The licence could not be read automatically. An admin will review it.',
      extracted: null,
    };
  }

  return evaluateExtractedLicence(x, person, { hasBack: Boolean(backBuffer), model: usedModel });
}
