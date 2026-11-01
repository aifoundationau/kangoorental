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

/** Brisbane calendar date of an epoch-ms time, e.g. "2026-11-03". */
export const brisbaneDate = (ms) => new Date(ms + 10 * 3600000).toISOString().slice(0, 10);

/** "Tue 3 Nov" for a calendar date. */
export const dayLabel = (dateStr) => new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-AU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });

/** Pickup and return days: the usual week plus single-date changes (see DEFAULT_SETTINGS.handover_*). */
export function handoverRules(settings) {
  const weekdays = String(settings.handover_weekdays ?? '').split(',').filter((s) => s.trim() !== '').map(Number);
  const overrides = Object.fromEntries(String(settings.handover_overrides || '').split(',').filter(Boolean)
    .map((entry) => entry.split(':')).map(([date, open]) => [date, open === '1']));
  return { weekdays, overrides };
}

/** Can the van be picked up or returned on this Brisbane date? */
export function isHandoverDay(rules, dateStr) {
  if (dateStr in rules.overrides) return rules.overrides[dateStr];
  return rules.weekdays.includes(new Date(`${dateStr}T00:00:00Z`).getUTCDay());
}

export function ageOn(dobStr, onDateStr) {
  const [y, m, d] = dobStr.split('-').map(Number);
  const [ty, tm, td] = onDateStr.split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

/** Rounds up to a whole number, ignoring floating-point dust (e.g. 164.00000000000003 counts as 164). */
export const ceilWhole = (n) => Math.ceil(n - 1e-9) || 0; // `|| 0` turns -0 into 0
export const floorWhole = ceilWhole; // backward-compatibility alias

/** The price list as numbers: total AUD ex GST for 1, 2, 3... days (see DEFAULT_SETTINGS.price_table). */
export function priceTable(settings) {
  const table = String(settings.price_table || '').split(',').map(Number);
  return table.length && table.every((n) => n > 0) ? table : [1];
}

/**
 * Customizable token amounts for each hire tier (1, 2, 3... days).
 * Defaults to 1 token = AUD$1 (inc GST) when not explicitly set for a tier.
 */
export function tokenTable(settings) {
  const prices = priceTable(settings);
  const gstBp = num(settings, 'gst_rate_bp');
  const raw = String(settings.token_table || '').split(',').map((s) => Number(s.trim()));
  return prices.map((audExGst, i) => {
    const defaultTokens = audExGst + ceilWhole((audExGst * gstBp) / 10000);
    return Number.isInteger(raw[i]) && raw[i] >= 1 ? raw[i] : defaultTokens;
  });
}

/** Longest hire: the admin setting, but never longer than the price list. */
export const maxRentalDays = (settings) => Math.min(num(settings, 'max_rental_days'), priceTable(settings).length);

/**
 * Prices a rental.
 * Default currency is AUD (`AUD$`), and default token price is 1 token = AUD$1.
 * The SuperAdmin can customize the token amount for each hire tier in `token_table`.
 * `fxRate` is the USD-per-AUD$1 conversion rate (e.g. 0.70, meaning AUD$1 = US$0.70) shown to visitors outside Australia and New Zealand.
 * Every dollar and token amount is a whole number, rounded up. Amounts are returned in cents to match stored records.
 * `days` must be between 1 and maxRentalDays(settings).
 */
export function quote(settings, days, fxRate = 0.7) {
  const basis = settings.price_basis === 'tokens' ? 'tokens' : 'aud';
  const gstBp = num(settings, 'gst_rate_bp');
  const table = priceTable(settings);
  const tokTable = tokenTable(settings);
  const usdPerAud = fxRate > 1.05 ? Number((1 / fxRate).toFixed(4)) : Number((fxRate || 0.7).toFixed(4));

  const listAud = table[0] * days;
  const subtotalAud = table[days - 1];
  const gstAud = ceilWhole((subtotalAud * gstBp) / 10000);
  const totalAud = subtotalAud + gstAud;

  // Token amounts: customizable per tier in SuperAdmin (defaulting to 1 token = AUD$1 inc GST)
  const day1Tokens = tokTable[0];
  const totalTokens = tokTable[days - 1];
  const listTokens = day1Tokens * days;
  const subtotalTokens = ceilWhole((totalTokens * 10000) / (10000 + gstBp));

  // USD conversion for visitors outside Australia & New Zealand (AUD$1 converted to USD)
  const usdList = ceilWhole(listAud * usdPerAud);
  const usdSubtotal = ceilWhole(subtotalAud * usdPerAud);
  const usdGst = ceilWhole(gstAud * usdPerAud);
  const usdTotal = ceilWhole(totalAud * usdPerAud);

  return {
    days,
    priceBasis: basis,
    fxRate: usdPerAud,
    usdPerAud,
    gstRateBp: gstBp,
    listSubtotalCents: listAud * 100,
    discountCents: (listAud - subtotalAud) * 100,
    subtotalCents: subtotalAud * 100,
    gstCents: gstAud * 100,
    totalCents: totalAud * 100,
    listSubtotalTokenCents: listTokens * 100,
    subtotalTokenCents: subtotalTokens * 100,
    tokenCents: totalTokens * 100,
    usdListSubtotalCents: usdList * 100,
    usdDiscountCents: Math.max(0, usdList - usdSubtotal) * 100,
    usdSubtotalCents: usdSubtotal * 100,
    usdGstCents: usdGst * 100,
    usdTotalCents: usdTotal * 100,
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
