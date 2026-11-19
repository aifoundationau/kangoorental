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

/** True if a Brisbane YYYY-MM-DD date falls on Saturday (6) or Sunday (0). */
export function isWeekend(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
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

/** Longest hire: the admin setting, but never longer than the price list. */
export const maxRentalDays = (settings) => Math.min(num(settings, 'max_rental_days'), priceTable(settings).length);

/** Formats integer AUD cents cleanly (omits .00 when exact whole dollar, shows 2 decimals otherwise). */
export function formatAud(cents) {
  const neg = cents < 0;
  const n = Math.abs(Number(cents || 0)) / 100;
  const whole = Number.isInteger(n);
  return `${neg ? '−' : ''}AUD$${n.toLocaleString('en-AU', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/**
 * Prices a rental in AUD only with exact ATO 10% GST matching Stripe Tax `exclusive` to the cent.
 * `days` must be between 1 and maxRentalDays(settings).
 */
export function quote(settings, days) {
  const gstBp = num(settings, 'gst_rate_bp');
  const table = priceTable(settings);

  const listSubtotalCents = table[0] * days * 100;
  const subtotalCents = table[days - 1] * 100;
  const discountCents = Math.max(0, listSubtotalCents - subtotalCents);
  const gstCents = Math.round((subtotalCents * gstBp) / 10000);
  const totalCents = subtotalCents + gstCents;

  const day1TotalCents = table[0] * 100 + Math.round((table[0] * 100 * gstBp) / 10000);
  const listTotalCents = day1TotalCents * days;
  const discountIncGstCents = Math.max(0, listTotalCents - totalCents);

  return {
    days,
    currency: 'AUD',
    gstRateBp: gstBp,
    listSubtotalCents,
    discountCents,
    subtotalCents,
    gstCents,
    totalCents,
    listTotalCents,
    discountIncGstCents,
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
