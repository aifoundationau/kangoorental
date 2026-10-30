import { Firestore, FieldValue } from '@google-cloud/firestore';
import { config, DEFAULT_SETTINGS } from './config.js';

// All data lives in a named Firestore database. Only this server talks to it; browsers never do.
//
// Collections
//   settings/site                    pricing, currency and site options (one document)
//   users/{id}                       customers and staff
//   emails/{email}                   { userId } - enforces one account per email
//   sessions/{sha256(token)}         { userId, csrf, expiresAt }
//   bookings/{id}                    rentals; times are epoch ms
//   blocks/{id}                      dates the van is unavailable
//   tokenTransactions/{id}           token ledger (Stripe purchases use id stripe_<checkout session id>)
//   threads/{userId}                 message thread summary; messages in threads/{userId}/messages
//   auditLog/{id}                    security-relevant events
//   locks/calendar                   touched by every booking change so overlapping bookings serialise

const sa = config.serviceAccount;
const projectId = config.firestoreProject || sa?.project_id;

export const firestore = new Firestore({
  ...(projectId ? { projectId } : {}),
  ...(sa ? { credentials: { client_email: sa.client_email, private_key: sa.private_key } } : {}),
  databaseId: config.firestoreDatabase,
  ignoreUndefinedProperties: true,
});

export const col = {
  settings: firestore.collection('settings'),
  users: firestore.collection('users'),
  emails: firestore.collection('emails'),
  sessions: firestore.collection('sessions'),
  bookings: firestore.collection('bookings'),
  blocks: firestore.collection('blocks'),
  tokenTransactions: firestore.collection('tokenTransactions'),
  threads: firestore.collection('threads'),
  auditLog: firestore.collection('auditLog'),
  locks: firestore.collection('locks'),
};

export { FieldValue };

export const nowIso = () => new Date().toISOString();
export const docData = (snap) => (snap.exists ? { id: snap.id, ...snap.data() } : null);
export const allDocs = (qs) => qs.docs.map((d) => ({ id: d.id, ...d.data() }));

/* ---------- Settings (cached briefly; invalidated on local writes) ---------- */

const SETTINGS_REF = col.settings.doc('site');
const SETTINGS_TTL_MS = 15000;
let settingsCache = { at: 0, value: null };

export async function initSettings() {
  const snap = await SETTINGS_REF.get();
  const current = snap.exists ? snap.data() : {};
  const missing = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).filter(([k]) => !(k in current)));
  if (Object.keys(missing).length) await SETTINGS_REF.set(missing, { merge: true });
  settingsCache = { at: 0, value: null };
}

export async function getSettings() {
  if (settingsCache.value && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  const snap = await SETTINGS_REF.get();
  const value = { ...DEFAULT_SETTINGS, ...(snap.exists ? snap.data() : {}) };
  for (const k of Object.keys(value)) value[k] = String(value[k] ?? '');
  settingsCache = { at: Date.now(), value };
  return value;
}

export async function setSettings(updates) {
  const clean = Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, String(v)]));
  await SETTINGS_REF.set(clean, { merge: true });
  settingsCache = { at: 0, value: null };
}

export function num(settings, key) {
  return Number(settings[key]);
}

/* ---------- Audit log ---------- */

export function audit(userId, action, detail, ip) {
  // Fire and forget: an audit write failure must not break the request, but is logged.
  col.auditLog.add({
    userId: userId ?? null,
    action,
    detail: detail ? String(detail).slice(0, 1000) : null,
    ip: ip ?? null,
    createdAt: nowIso(),
  }).catch((err) => console.error('[audit] write failed:', err.message));
}
