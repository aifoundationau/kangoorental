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

/** Rounds up to a whole number, ignoring floating-point dust (e.g. 100.00000000000001 stays 100). */
export const ceilWhole = (n) => Math.ceil(n - 1e-9) || 0; // `|| 0` turns -0 into 0

/**
 * Prices a rental. Tokens are US$1 each; `fxRate` is AUD per US$1.
 * basis 'aud':    AUD rate is fixed  -> tokens = AUD / rate
 * basis 'tokens': token rate is fixed -> AUD = tokens x rate
 * Multi-day discount: day 2 is 10% off, day 3 20%, day 4 30%, and day 5 onwards 40% (see the multiday_discount_* settings).
 * GST is added on the AUD amount, and the customer is charged the GST-inclusive total in tokens.
 * Every dollar and token amount is a whole number, rounded up. Amounts are returned in cents to match stored records.
 */
export function quote(settings, days, fxRate) {
  const basis = settings.price_basis === 'tokens' ? 'tokens' : 'aud';
  const gstBp = num(settings, 'gst_rate_bp');
  const stepBp = num(settings, 'multiday_discount_step_bp');
  const maxBp = num(settings, 'multiday_discount_max_bp');
  const discounted = (dailyRate) => Array.from({ length: days }, (_, i) => ceilWhole((dailyRate * (10000 - Math.min(i * stepBp, maxBp))) / 10000))
    .reduce((a, b) => a + b, 0);

  let listAud;
  let subtotalAud;
  let listTokens;
  let subtotalTokens;
  if (basis === 'aud') {
    const daily = ceilWhole(num(settings, 'daily_rate_aud_cents') / 100);
    listAud = daily * days;
    subtotalAud = discounted(daily);
    listTokens = ceilWhole(listAud / fxRate);
    subtotalTokens = ceilWhole(subtotalAud / fxRate);
  } else {
    const daily = ceilWhole(num(settings, 'daily_rate_token_cents') / 100);
    listTokens = daily * days;
    subtotalTokens = discounted(daily);
    listAud = ceilWhole(listTokens * fxRate);
    subtotalAud = ceilWhole(subtotalTokens * fxRate);
  }
  const gstAud = ceilWhole((subtotalAud * gstBp) / 10000);
  const totalAud = subtotalAud + gstAud;
  return {
    days,
    priceBasis: basis,
    fxRate,
    gstRateBp: gstBp,
    listSubtotalCents: listAud * 100,
    discountCents: (listAud - subtotalAud) * 100,
    subtotalCents: subtotalAud * 100,
    gstCents: gstAud * 100,
    totalCents: totalAud * 100,
    listSubtotalTokenCents: listTokens * 100,
    subtotalTokenCents: subtotalTokens * 100,
    tokenCents: ceilWhole(totalAud / fxRate) * 100,
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
