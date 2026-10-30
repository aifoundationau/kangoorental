import crypto from 'node:crypto';
import { num } from './db.js';
import { HttpError } from './security.js';

const DAY_MS = 86400000;
// Queensland has no daylight saving, so Brisbane is always UTC+10.
const BRISBANE_OFFSET = '+10:00';

export function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function brisbaneTime(dateStr, timeStr = '00:00') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^\d{2}:\d{2}$/.test(timeStr)) return NaN;
  return Date.parse(`${dateStr}T${timeStr}:00${BRISBANE_OFFSET}`);
}

export function brisbaneToday() {
  return new Date(Date.now() + 10 * 3600000).toISOString().slice(0, 10);
}

export function addDays(dateStr, n) {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function ageOn(dobStr, onDateStr) {
  const [y, m, d] = dobStr.split('-').map(Number);
  const [ty, tm, td] = onDateStr.split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

/**
 * Prices a rental. Tokens are USD $1.00 each; `fxRate` is AUD per USD 1.00.
 * basis 'aud':    AUD rate is fixed  -> tokens = AUD / rate
 * basis 'tokens': token rate is fixed -> AUD = tokens x rate
 * GST is added on the AUD amount, and the customer is charged the GST-inclusive total in tokens.
 */
export function quote(settings, days, fxRate) {
  const basis = settings.price_basis === 'tokens' ? 'tokens' : 'aud';
  const gstBp = num(settings, 'gst_rate_bp');
  let subtotalAud;
  let subtotalTokenCents;
  if (basis === 'aud') {
    subtotalAud = num(settings, 'daily_rate_aud_cents') * days;
    subtotalTokenCents = Math.round(subtotalAud / fxRate);
  } else {
    subtotalTokenCents = num(settings, 'daily_rate_token_cents') * days;
    subtotalAud = Math.round(subtotalTokenCents * fxRate);
  }
  const gstAud = Math.round((subtotalAud * gstBp) / 10000);
  const totalAud = subtotalAud + gstAud;
  return {
    days,
    priceBasis: basis,
    fxRate,
    gstRateBp: gstBp,
    subtotalCents: subtotalAud,
    gstCents: gstAud,
    totalCents: totalAud,
    subtotalTokenCents,
    tokenCents: Math.round(totalAud / fxRate),
  };
}

export function bookingRef() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  return 'KR-' + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/* ---------- Input validation ---------- */

export function str(value, { field, min = 0, max = 200, required = true, pattern, message } = {}) {
  const v = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  if (!v) {
    if (required) throw new HttpError(400, `${field} is required.`);
    return '';
  }
  if (v.length < min || v.length > max) throw new HttpError(400, message || `${field} must be ${min}–${max} characters.`);
  if (pattern && !pattern.test(v)) throw new HttpError(400, message || `${field} is not valid.`);
  return v;
}

export function int(value, { field, min, max }) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field} must be a whole number between ${min} and ${max}.`);
  return n;
}

export const PATTERNS = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  phone: /^\+?[0-9 ()-]{8,20}$/,
  postcode: /^\d{4}$/,
  licence: /^[A-Za-z0-9 -]{4,20}$/,
};

export const AU_STATES = ['QLD', 'NSW', 'VIC', 'SA', 'WA', 'TAS', 'NT', 'ACT'];

export function validDate(value, field, required = true) {
  const v = str(value, { field, pattern: PATTERNS.date, required, max: 10, message: `${field} must be a valid date.` });
  if (v && Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new HttpError(400, `${field} must be a valid date.`);
  return v;
}

export const DAY = DAY_MS;
