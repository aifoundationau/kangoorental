import { Router } from 'express';
import { firestore, col, allDocs, nowIso, audit, FieldValue } from '../db.js';
import {
  HttpError, requireUser, rateLimit, verifyPassword, destroyAllSessions, destroySession, isStaff,
} from '../security.js';
import { paymentsMode, createCheckout, confirmCheckout, creditTokens } from '../payments.js';
import { str, PATTERNS, AU_STATES, validDate, int, brisbaneToday } from '../util.js';
import { licenceUpload, publicUser, readLicenceFields, runLicenceCheck, getUser } from './auth.js';

export const router = Router();
router.use(['/account', '/tokens', '/messages'], requireUser);

router.put('/account/profile', async (req, res) => {
  const b = req.body || {};
  const phone = str(b.phone, { field: 'Mobile number', pattern: PATTERNS.phone, max: 20 });
  const addressLine = str(b.addressLine, { field: 'Street address', min: 3, max: 160 });
  const suburb = str(b.suburb, { field: 'Suburb', min: 2, max: 80 });
  const state = str(b.state, { field: 'State', max: 3 }).toUpperCase();
  const postcode = str(b.postcode, { field: 'Postcode', pattern: PATTERNS.postcode, max: 4 });
  if (!AU_STATES.includes(state)) throw new HttpError(400, 'Please choose a valid Australian state.');
  await col.users.doc(req.user.id).update({ phone, addressLine, suburb, state, postcode });
  audit(req.user.id, 'profile.update', null, req.ip);
  res.json({ user: publicUser(await getUser(req.user.id)) });
});

router.put('/account/insurance', async (req, res) => {
  const b = req.body || {};
  const insurer = str(b.insurer, { field: 'Insurer', min: 2, max: 100 });
  const policyNumber = str(b.policyNumber, { field: 'Policy number', min: 3, max: 60 });
  const policyExpiry = validDate(b.policyExpiry, 'Policy expiry');
  if (policyExpiry < brisbaneToday()) throw new HttpError(400, 'This policy has already expired.');
  if (b.confirmIndemnity !== true) {
    throw new HttpError(400, 'Please confirm you hold at least $2 million indemnity (public liability) cover.');
  }
  await col.users.doc(req.user.id).update({ insurer, policyNumber, policyExpiry, indemnityConfirmedAt: nowIso() });
  audit(req.user.id, 'insurance.update', insurer, req.ip);
  res.json({ user: publicUser(await getUser(req.user.id)) });
});

router.post('/account/licence',
  rateLimit({ windowMs: 60 * 60 * 1000, max: 5, key: (req) => `u${req.user.id}`, message: 'Too many licence uploads. Please try again in an hour.' }),
  licenceUpload.single('licence'),
  async (req, res) => {
    if (req.user.licenceStatus === 'verified') throw new HttpError(409, 'Your licence is already verified.');
    const lic = readLicenceFields(req.body || {});
    if (!AU_STATES.includes(lic.licenceState)) throw new HttpError(400, 'Please choose a valid Australian state.');
    if (lic.licenceExpiry < brisbaneToday()) throw new HttpError(400, 'Your licence has expired.');
    await col.users.doc(req.user.id).update(lic);
    const result = await runLicenceCheck(req.user.id, req.file, { fullName: req.user.fullName, dob: req.user.dob, ...lic }, req.ip);
    res.json({ user: publicUser(await getUser(req.user.id)), licence: { status: result.status, notes: result.notes } });
  });

router.get('/account/transactions', async (req, res) => {
  const rows = allDocs(await col.tokenTransactions.where('userId', '==', req.user.id).get())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 200)
    .map(({ id, deltaCents, kind, amountCents, currency, provider, note, createdAt }) => ({
      id, deltaCents, kind, amountCents, currency, provider, note, createdAt,
    }));
  res.json({ transactions: rows });
});

router.post('/account/delete', async (req, res) => {
  if (isStaff(req.user)) throw new HttpError(403, 'Staff accounts cannot be deleted here.');
  const user = await getUser(req.user.id);
  if (!(await verifyPassword(String(req.body?.password || ''), user.passwordHash))) throw new HttpError(400, 'Password is incorrect.');
  const live = allDocs(await col.bookings.where('userId', '==', user.id).get())
    .filter((b) => b.status === 'confirmed' || b.status === 'active');
  if (live.length) throw new HttpError(409, 'Please cancel or complete your current bookings before deleting your account.');

  // Booking and payment records are kept for tax law; personal details are removed.
  const del = FieldValue.delete();
  const batch = firestore.batch();
  batch.update(col.users.doc(user.id), {
    email: `deleted-${user.id}@invalid`, passwordHash: 'deleted', fullName: 'Deleted customer', disabled: true,
    phone: del, dob: del, addressLine: del, suburb: del, state: del, postcode: del, licenceNumber: del,
    licenceState: del, licenceExpiry: del, licenceClass: del, licenceNotes: del, regLat: del, regLng: del,
    regAccuracyM: del, insurer: del, policyNumber: del, policyExpiry: del, deletedAt: nowIso(),
  });
  batch.delete(col.emails.doc(user.email));
  for (const b of allDocs(await col.bookings.where('userId', '==', user.id).get())) {
    batch.update(col.bookings.doc(b.id), { userName: 'Deleted customer', userEmail: del, userPhone: del });
  }
  await batch.commit();
  await firestore.recursiveDelete(col.threads.doc(user.id));
  audit(user.id, 'account.delete', null, req.ip);
  await destroyAllSessions(user.id);
  await destroySession(req, res);
  res.json({ ok: true });
});

/* ---------- Tokens ---------- */

router.post('/tokens/checkout', async (req, res) => {
  if (req.user.role !== 'customer') throw new HttpError(403, 'Only customers can buy tokens.');
  // Whole tokens only, USD $1.00 each.
  const tokens = int(req.body?.tokens, { field: 'Tokens', min: 1, max: 5000 });

  if (paymentsMode === 'stripe') {
    const session = await createCheckout(req.user, tokens);
    audit(req.user.id, 'tokens.checkout', `${tokens} tokens ${session.id}`, req.ip);
    return res.json({ url: session.url });
  }
  if (paymentsMode === 'demo') {
    await creditTokens({ userId: req.user.id, tokens, provider: 'demo', note: 'Demo purchase - no money taken' });
    return res.json({ demo: true, user: publicUser(await getUser(req.user.id)) });
  }
  throw new HttpError(503, 'Online payments are not available right now. Please message us.');
});

router.get('/tokens/confirm', async (req, res) => {
  if (paymentsMode !== 'stripe') throw new HttpError(400, 'Stripe is not configured.');
  const result = await confirmCheckout(String(req.query.session_id || ''), req.user.id);
  res.json({ ...result, user: publicUser(await getUser(req.user.id)) });
});

/* ---------- Messages ---------- */

export async function postMessage(customer, sender, body) {
  const threadRef = col.threads.doc(customer.id);
  const batch = firestore.batch();
  batch.create(threadRef.collection('messages').doc(), { sender, body, createdAt: nowIso() });
  batch.set(threadRef, {
    userId: customer.id,
    fullName: customer.fullName,
    email: customer.email,
    lastBody: body.slice(0, 200),
    lastSender: sender,
    lastAt: nowIso(),
    ...(sender === 'customer'
      ? { unreadForAdmin: FieldValue.increment(1) }
      : { unreadForCustomer: FieldValue.increment(1) }),
  }, { merge: true });
  await batch.commit();
}

export async function readThread(userId) {
  const qs = await col.threads.doc(userId).collection('messages').orderBy('createdAt').limitToLast(500).get();
  return allDocs(qs).map(({ id, sender, body, createdAt }) => ({ id, sender, body, createdAt }));
}

router.get('/messages', async (req, res) => {
  const messages = await readThread(req.user.id);
  if (messages.length) await col.threads.doc(req.user.id).set({ unreadForCustomer: 0 }, { merge: true });
  res.json({ messages });
});

router.post('/messages',
  rateLimit({ windowMs: 60 * 1000, max: 10, key: (req) => `u${req.user.id}`, message: 'You are sending messages too quickly.' }),
  async (req, res) => {
    if (req.user.role !== 'customer') throw new HttpError(403, 'Use the admin inbox to reply to customers.');
    const body = str(req.body?.body, { field: 'Message', min: 1, max: 2000 });
    await postMessage(req.user, 'customer', body);
    res.status(201).json({ ok: true });
  });
