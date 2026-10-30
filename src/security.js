import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { firestore, col, docData } from './db.js';
import { config } from './config.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = config.isProduction ? '__Host-kr_sid' : 'kr_sid';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ---------- Passwords ---------- */

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, expected);
}

/* ---------- Sessions & CSRF ---------- */

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token, maxAgeSeconds) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.isProduction) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

export async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const maxAge = config.sessionDays * 86400;
  // expireAt is a Date so a Firestore TTL policy on sessions.expireAt can clean up old sessions.
  const expiresAt = Date.now() + maxAge * 1000;
  await col.sessions.doc(sha256(token)).set({ userId, csrf, expiresAt, expireAt: new Date(expiresAt) });
  setSessionCookie(res, token, maxAge);
  return csrf;
}

export async function destroySession(req, res) {
  if (req.sessionId) await col.sessions.doc(req.sessionId).delete();
  setSessionCookie(res, '', 0);
}

export async function destroyAllSessions(userId) {
  const qs = await col.sessions.where('userId', '==', userId).get();
  const batch = firestore.batch();
  qs.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

// Attaches req.user / req.csrf when a valid session cookie is present.
export async function loadSession(req, res, next) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return next();
  try {
    const id = sha256(token);
    const session = await col.sessions.doc(id).get();
    if (!session.exists) return next();
    const { userId, csrf, expiresAt } = session.data();
    const user = expiresAt > Date.now() ? docData(await col.users.doc(userId).get()) : null;
    if (user && !user.disabled) {
      req.sessionId = id;
      req.csrf = csrf;
      user.hasPassword = Boolean(user.passwordHash);
      delete user.passwordHash;
      req.user = user;
    } else {
      await col.sessions.doc(id).delete();
    }
    next();
  } catch (err) {
    next(err);
  }
}

// State-changing requests from a logged-in browser must echo the session's CSRF token.
export function csrfGuard(req, res, next) {
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (safe || !req.user) return next();
  const sent = req.get('x-csrf-token') || '';
  const ok = sent.length === req.csrf.length &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.csrf));
  if (!ok) return next(new HttpError(403, 'Security token expired. Please refresh the page.'));
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Please log in to continue.'));
  next();
}

export const isStaff = (user) => user?.role === 'admin' || user?.role === 'superadmin';

export function requireAdmin(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Please log in to continue.'));
  if (!isStaff(req.user)) return next(new HttpError(403, 'Admin access only.'));
  next();
}

// Pricing, currency conversion, site settings and staff accounts are superadmin-only.
export function requireSuperadmin(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Please log in to continue.'));
  if (req.user.role !== 'superadmin') return next(new HttpError(403, 'Superadmin access only.'));
  next();
}

export async function purgeExpiredSessions() {
  const qs = await col.sessions.where('expiresAt', '<', Date.now()).limit(400).get();
  if (qs.empty) return;
  const batch = firestore.batch();
  qs.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

/* ---------- Rate limiting (in-memory, per key) ---------- */

const buckets = new Map();

export function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Too many attempts. Please wait and try again.' }) {
  return (req, res, next) => {
    const k = `${windowMs}:${max}:${req.baseUrl}${req.path}:${key(req)}`;
    const now = Date.now();
    const hits = (buckets.get(k) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) return next(new HttpError(429, message));
    hits.push(now);
    buckets.set(k, hits);
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, hits] of buckets) {
    const windowMs = Number(k.split(':')[0]);
    if (!hits.some((t) => now - t < windowMs)) buckets.delete(k);
  }
}, 10 * 60 * 1000).unref();

/* ---------- Security headers ---------- */

export function securityHeaders(req, res, next) {
  res.set({
    // accounts.google.com/gsi entries are for the "Sign in with Google" button.
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' https://accounts.google.com/gsi/client",
      "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
      "img-src 'self' data:",
      "frame-src https://www.openstreetmap.org https://accounts.google.com/gsi/",
      "connect-src 'self' https://accounts.google.com/gsi/",
      "form-action 'self' https://checkout.stripe.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=()',
    // Google's sign-in popup needs to report back to this window.
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'X-Frame-Options': 'DENY',
  });
  if (config.isProduction) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}
