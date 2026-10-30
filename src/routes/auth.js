import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { firestore, col, docData, nowIso, getSettings, num, audit, FieldValue } from '../db.js';
import {
  HttpError, hashPassword, verifyPassword, createSession, destroySession, rateLimit, requireUser,
  destroyAllSessions, isStaff,
} from '../security.js';
import { verifyLicence } from '../licence.js';
import { verifyGoogleCredential } from '../google.js';
import {
  str, PATTERNS, AU_STATES, validDate, distanceKm, ageOn, brisbaneToday,
} from '../util.js';

export const router = Router();

// Licence photos stay in memory and are never written to disk or the database.
export const licenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxLicenceBytes, files: 1, fields: 40 },
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 6 });

export function publicUser(u, extra = {}) {
  if (!u) return null;
  return {
    id: u.id,
    role: u.role,
    email: u.email,
    fullName: u.fullName,
    phone: u.phone,
    dob: u.dob,
    addressLine: u.addressLine,
    suburb: u.suburb,
    state: u.state,
    postcode: u.postcode,
    licenceNumber: u.licenceNumber,
    licenceState: u.licenceState,
    licenceExpiry: u.licenceExpiry,
    licenceClass: u.licenceClass,
    licenceStatus: u.licenceStatus,
    licenceNotes: u.licenceNotes,
    licenceCheckedAt: u.licenceCheckedAt,
    insurer: u.insurer,
    policyNumber: u.policyNumber,
    policyExpiry: u.policyExpiry,
    indemnityConfirmed: Boolean(u.indemnityConfirmedAt),
    tokenCents: u.tokenCents ?? 0,
    hasPassword: u.hasPassword ?? Boolean(u.passwordHash),
    googleLinked: Boolean(u.googleSub),
    createdAt: u.createdAt,
    ...extra,
  };
}

export async function findUserByGoogleSub(sub) {
  const qs = await col.users.where('googleSub', '==', sub).limit(1).get();
  return qs.empty ? null : { id: qs.docs[0].id, ...qs.docs[0].data() };
}

export const getUser = async (id) => docData(await col.users.doc(String(id)).get());

export function checkServiceArea(lat, lng, settings) {
  const la = Number(lat);
  const lo = Number(lng);
  if (lat == null || lng == null || !Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
    throw new HttpError(400, 'Location is required. Please allow location access in your browser.');
  }
  const km = distanceKm(la, lo, num(settings, 'pickup_lat'), num(settings, 'pickup_lng'));
  const radius = num(settings, 'registration_radius_km'); // the booking radius (setting name kept from when it applied to sign-up)
  return { distanceKm: Math.round(km * 10) / 10, radiusKm: radius, inArea: km <= radius };
}

export function readLicenceFields(body) {
  return {
    licenceNumber: str(body.licenceNumber, { field: 'Licence number', pattern: PATTERNS.licence, max: 20 }).toUpperCase(),
    licenceState: str(body.licenceState, { field: 'Licence state', max: 3 }).toUpperCase(),
    licenceExpiry: validDate(body.licenceExpiry, 'Licence expiry'),
  };
}

export async function runLicenceCheck(userId, file, person, ip) {
  if (!file) throw new HttpError(400, 'Please upload a photo of the front of your driver licence.');
  let result;
  try {
    result = await verifyLicence(file.buffer, person);
  } finally {
    // Drop our reference to the image as soon as the check is done.
    file.buffer = null;
  }
  const x = result.extracted;
  await col.users.doc(userId).update({
    licenceStatus: result.status,
    licenceMethod: result.method,
    licenceNotes: result.notes,
    licenceCheckedAt: nowIso(),
    ...(x?.licence_class ? { licenceClass: x.licence_class } : {}),
    ...(result.status === 'verified' && x?.expiry_date ? { licenceExpiry: x.expiry_date } : {}),
  });
  audit(userId, 'licence.check', `${result.method}: ${result.status}`, ip);
  return result;
}

/** Creates a user and reserves the email in one transaction. Throws 409 if the email is taken. */
export async function createUser(fields) {
  const email = fields.email.toLowerCase();
  const userRef = col.users.doc();
  const emailRef = col.emails.doc(email);
  await firestore.runTransaction(async (t) => {
    if ((await t.get(emailRef)).exists) throw new HttpError(409, 'An account with this email already exists. Please log in.');
    t.create(emailRef, { userId: userRef.id });
    t.create(userRef, {
      role: 'supporter',
      licenceStatus: 'unverified',
      tokenCents: 0,
      disabled: false,
      createdAt: nowIso(),
      ...fields,
      email,
    });
  });
  return userRef.id;
}

export async function findUserByEmail(email) {
  const link = await col.emails.doc(String(email).toLowerCase()).get();
  return link.exists ? getUser(link.data().userId) : null;
}

router.post('/geo/check', rateLimit({ windowMs: 60 * 1000, max: 30 }), async (req, res) => {
  res.json(checkServiceArea(req.body?.lat, req.body?.lng, await getSettings()));
});

router.post('/auth/register', registerLimiter, licenceUpload.single('licence'), async (req, res) => {
  const b = req.body || {};
  const settings = await getSettings();

  // Customers signing up with Google use their verified Google email and don't set a password.
  const google = b.googleCredential ? await verifyGoogleCredential(b.googleCredential) : null;
  if (google && await findUserByGoogleSub(google.sub)) throw new HttpError(409, 'This Google account is already registered. Please log in.');
  const email = google ? google.email : str(b.email, { field: 'Email', pattern: PATTERNS.email, max: 120 }).toLowerCase();
  const password = String(b.password || '');
  if (!google && (password.length < 10 || password.length > 200)) throw new HttpError(400, 'Password must be at least 10 characters.');
  const fullName = str(b.fullName, { field: 'Full name', min: 3, max: 120 });
  const phone = str(b.phone, { field: 'Mobile number', pattern: PATTERNS.phone, max: 20 });
  const dob = validDate(b.dob, 'Date of birth');
  const addressLine = str(b.addressLine, { field: 'Street address', min: 3, max: 160 });
  const suburb = str(b.suburb, { field: 'Suburb', min: 2, max: 80 });
  const state = str(b.state, { field: 'State', max: 3 }).toUpperCase();
  const postcode = str(b.postcode, { field: 'Postcode', pattern: PATTERNS.postcode, max: 4 });
  const lic = readLicenceFields(b);

  if (!AU_STATES.includes(state) || !AU_STATES.includes(lic.licenceState)) throw new HttpError(400, 'Please choose a valid Australian state.');
  if (b.acceptTerms !== 'true') throw new HttpError(400, 'You must accept the Terms of Service and Privacy Policy.');
  if (b.acceptAi !== 'true') throw new HttpError(400, 'Please consent to licence verification to continue.');

  const minAge = num(settings, 'min_driver_age');
  if (ageOn(dob, brisbaneToday()) < minAge) throw new HttpError(400, `Drivers must be at least ${minAge} years old.`);
  if (lic.licenceExpiry < brisbaneToday()) throw new HttpError(400, 'Your licence has expired.');

  if (!req.file) throw new HttpError(400, 'Please upload a photo of the front of your driver licence.');

  const userId = await createUser({
    email,
    ...(google ? { googleSub: google.sub } : { passwordHash: await hashPassword(password) }),
    fullName, phone, dob, addressLine, suburb, state, postcode,
    ...lic,
    acceptedTermsAt: nowIso(),
    acceptedAiCheckAt: nowIso(),
  });
  audit(userId, 'register', `${email}${google ? ' (Google)' : ''}`, req.ip);

  const result = await runLicenceCheck(userId, req.file, { fullName, dob, ...lic }, req.ip);
  const csrf = await createSession(res, userId);
  res.status(201).json({ user: publicUser(await getUser(userId)), csrf, licence: { status: result.status, notes: result.notes } });
});

router.post('/auth/login', authLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = email ? await findUserByEmail(email) : null;
  // Hash even when the user doesn't exist so response time doesn't reveal registered emails.
  const ok = user ? await verifyPassword(password, user.passwordHash) : (await hashPassword(password), false);
  if (!ok || user.disabled) {
    audit(user?.id, 'login.failed', email, req.ip);
    if (user && !user.disabled && !user.passwordHash && user.googleSub) {
      throw new HttpError(401, 'This account uses Google sign-in. Please use "Sign in with Google".');
    }
    throw new HttpError(401, 'Email or password is incorrect.');
  }
  if (req.sessionId) await destroySession(req, res);
  const csrf = await createSession(res, user.id);
  audit(user.id, 'login', null, req.ip);
  res.json({ user: publicUser(user), csrf });
});

/**
 * Makes the Google account behind a superadmin email (config.superadminEmails) a superadmin, creating the account if needed.
 * Only a verified Google sign-in proves the email, so the account becomes Google-only: any password is removed and other
 * sessions are signed out, in case someone registered that email with a password first.
 */
export async function superadminFromGoogle(google, ip) {
  let user = (await findUserByGoogleSub(google.sub)) || (await findUserByEmail(google.email));
  if (user?.googleSub && user.googleSub !== google.sub) throw new HttpError(409, 'This email is linked to a different Google account.');
  if (!user) {
    const id = await createUser({ role: 'superadmin', email: google.email, fullName: google.name || 'Superadmin', googleSub: google.sub });
    audit(id, 'superadmin.create', `${google.email} (Google)`, ip);
    return getUser(id);
  }
  if (user.role !== 'superadmin' || user.passwordHash || user.disabled || !user.googleSub) {
    await col.users.doc(user.id).update({ role: 'superadmin', googleSub: google.sub, passwordHash: FieldValue.delete(), disabled: false });
    await destroyAllSessions(user.id);
    audit(user.id, 'superadmin.promote', `${google.email} (Google; was ${user.role})`, ip);
    return getUser(user.id);
  }
  return user;
}

// Google sign-in: logs in an existing account (linking Google to it on first use, matched by verified email),
// or tells the browser to continue to registration with the Google details prefilled.
router.post('/auth/google', authLimiter, async (req, res) => {
  const google = await verifyGoogleCredential(req.body?.credential);
  if (config.superadminEmails.includes(google.email)) {
    const owner = await superadminFromGoogle(google, req.ip);
    if (req.sessionId) await destroySession(req, res);
    const csrf = await createSession(res, owner.id);
    audit(owner.id, 'login', 'Google (superadmin)', req.ip);
    return res.json({ user: publicUser(owner), csrf });
  }
  let user = await findUserByGoogleSub(google.sub);
  if (!user) {
    user = await findUserByEmail(google.email);
    if (user && !user.disabled) {
      if (user.googleSub && user.googleSub !== google.sub) throw new HttpError(409, 'This email is linked to a different Google account.');
      await col.users.doc(user.id).update({ googleSub: google.sub });
      audit(user.id, 'google.link', google.email, req.ip);
    }
  }
  if (!user) return res.json({ needsRegistration: true, profile: { email: google.email, fullName: google.name } });
  if (user.disabled) {
    audit(user.id, 'login.failed', `${google.email} (Google, disabled)`, req.ip);
    throw new HttpError(401, 'This account is disabled. Please contact us.');
  }
  if (req.sessionId) await destroySession(req, res);
  const csrf = await createSession(res, user.id);
  audit(user.id, 'login', 'Google', req.ip);
  res.json({ user: publicUser({ ...user, googleSub: google.sub }), csrf });
});

router.post('/auth/logout', async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

export async function unreadCount(user) {
  if (isStaff(user)) {
    const qs = await col.threads.where('unreadForAdmin', '>', 0).get();
    return qs.docs.reduce((n, d) => n + d.data().unreadForAdmin, 0);
  }
  const thread = await col.threads.doc(user.id).get();
  return thread.exists ? thread.data().unreadForCustomer || 0 : 0;
}

router.get('/me', async (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: publicUser(req.user, { unreadMessages: await unreadCount(req.user) }), csrf: req.csrf });
});

router.post('/auth/change-password', requireUser, authLimiter, async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user.passwordHash) throw new HttpError(400, 'This account signs in with Google, so it has no password to change.');
  if (!(await verifyPassword(String(req.body?.currentPassword || ''), user.passwordHash))) {
    throw new HttpError(400, 'Current password is incorrect.');
  }
  const next = String(req.body?.newPassword || '');
  if (next.length < 10 || next.length > 200) throw new HttpError(400, 'New password must be at least 10 characters.');
  await col.users.doc(user.id).update({ passwordHash: await hashPassword(next) });
  await destroyAllSessions(user.id);
  const csrf = await createSession(res, user.id);
  audit(user.id, 'password.change', null, req.ip);
  res.json({ ok: true, csrf });
});
