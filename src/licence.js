import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { config } from './config.js';
import { HttpError } from './security.js';
import { brisbaneToday } from './util.js';

// Licence photos are processed in memory only. Nothing in this module writes the image anywhere;
// the buffer is passed to the AI provider for a single verification request and then released.

const client = config.licenceAiEnabled ? new Anthropic() : null;

const LicenceSchema = {
  type: 'object',
  properties: {
    is_drivers_licence: { type: 'boolean', description: 'True only if the image shows the front of a government-issued driver licence card.' },
    image_quality_ok: { type: 'boolean', description: 'True if the name, date of birth, licence number and expiry are all clearly legible.' },
    tampering_suspected: { type: 'boolean', description: 'True if the card shows signs of editing, a screen photo of a photo, or mismatched fonts.' },
    issuing_state: { type: 'string', enum: ['QLD', 'NSW', 'VIC', 'SA', 'WA', 'TAS', 'NT', 'ACT', 'OTHER', 'UNKNOWN'] },
    licence_type: { type: 'string', enum: ['open', 'provisional', 'learner', 'probationary', 'unknown'] },
    licence_class: { type: 'string', description: 'Vehicle class code(s) shown, e.g. "C". Empty string if not visible.' },
    full_name: { type: 'string', description: 'Full name exactly as printed. Empty string if not legible.' },
    date_of_birth: { type: 'string', description: 'YYYY-MM-DD, or empty string if not legible.' },
    licence_number: { type: 'string', description: 'Licence number as printed, or empty string if not legible.' },
    expiry_date: { type: 'string', description: 'YYYY-MM-DD, or empty string if not legible.' },
    notes: { type: 'string', description: 'One short sentence about anything a human reviewer should know.' },
  },
  required: [
    'is_drivers_licence', 'image_quality_ok', 'tampering_suspected', 'issuing_state', 'licence_type',
    'licence_class', 'full_name', 'date_of_birth', 'licence_number', 'expiry_date', 'notes',
  ],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You read photos of Australian driver licences for a van rental business in Brisbane.
Extract the printed details exactly as they appear. Do not guess: if a field is unreadable, return an empty string.
Dates must be returned as YYYY-MM-DD (Australian licences print dates as DD/MM/YYYY or DD MMM YYYY).
Report honestly whether the image is really a driver licence and whether anything looks altered.
Your output is checked automatically against the details the customer typed, and a person reviews any doubtful result.`;

export function detectImageType(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length > 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

const nameTokens = (s) => String(s).toUpperCase().replace(/[^A-Z\s'-]/g, ' ').split(/[\s-]+/).filter(Boolean);
const normId = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

function namesMatch(entered, extracted) {
  const a = nameTokens(entered);
  const b = new Set(nameTokens(extracted));
  if (a.length === 0 || b.size === 0) return false;
  // Every name the customer typed must appear on the card; middle names may be omitted.
  return a.every((t) => b.has(t)) && a.length >= Math.min(2, b.size);
}

/**
 * Verifies a licence photo against the customer's typed details.
 * Returns { status: 'verified'|'pending'|'rejected', method, notes, extracted }.
 */
export async function verifyLicence(imageBuffer, person) {
  const mediaType = detectImageType(imageBuffer);
  if (!mediaType) throw new HttpError(400, 'Licence photo must be a JPEG, PNG or WebP image.');

  if (!client) {
    return {
      status: 'pending',
      method: 'manual',
      notes: 'Automatic verification is not configured. An admin will review your licence details.',
      extracted: null,
    };
  }

  let response;
  try {
    response = await client.beta.messages.parse({
      model: config.licenceModel,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: jsonSchemaOutputFormat(LicenceSchema) },
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBuffer.toString('base64') } },
          { type: 'text', text: 'Extract the details from this driver licence.' },
        ],
      }],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
      console.error('[licence] AI provider unavailable:', err.message);
    } else if (err instanceof Anthropic.APIError) {
      console.error(`[licence] AI request failed (${err.status}):`, err.message);
    } else {
      console.error('[licence] Unexpected error:', err);
    }
    return {
      status: 'pending',
      method: 'manual',
      notes: 'Automatic verification was unavailable. An admin will review your licence details.',
      extracted: null,
    };
  }

  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    return {
      status: 'pending',
      method: 'ai',
      notes: 'The licence could not be read automatically. An admin will review it.',
      extracted: null,
    };
  }

  const x = response.parsed_output;
  const problems = [];
  if (!x.is_drivers_licence) {
    return { status: 'rejected', method: 'ai', notes: 'The photo does not appear to be a driver licence. Please upload a clear photo of the front of your licence.', extracted: x };
  }
  if (!x.image_quality_ok) {
    return { status: 'rejected', method: 'ai', notes: 'The photo is not clear enough. Please retake it in good light with all four corners visible.', extracted: x };
  }
  if (x.licence_type === 'learner') {
    return { status: 'rejected', method: 'ai', notes: 'Learner licences cannot be used to hire a vehicle.', extracted: x };
  }
  if (x.expiry_date && x.expiry_date < brisbaneToday()) {
    return { status: 'rejected', method: 'ai', notes: 'This licence has expired.', extracted: x };
  }

  if (!namesMatch(person.fullName, x.full_name)) problems.push('name does not match');
  if (x.date_of_birth !== person.dob) problems.push('date of birth does not match');
  if (normId(x.licence_number) !== normId(person.licenceNumber)) problems.push('licence number does not match');
  if (x.issuing_state !== person.licenceState) problems.push('issuing state does not match');
  if (!x.expiry_date) problems.push('expiry date not legible');

  if (problems.length) {
    return {
      status: 'rejected',
      method: 'ai',
      notes: `Details on the licence did not match what you entered (${problems.join(', ')}). Check your details and upload again.`,
      extracted: x,
    };
  }
  if (x.tampering_suspected || x.licence_type === 'provisional' || x.licence_type === 'probationary') {
    return {
      status: 'pending',
      method: 'ai',
      notes: x.tampering_suspected
        ? 'Your licence needs a quick manual check by our team.'
        : 'Provisional and probationary licences are reviewed manually by our team.',
      extracted: x,
    };
  }
  return { status: 'verified', method: 'ai', notes: 'Licence verified automatically.', extracted: x };
}
