import { config } from './config.js';

// Place lookups for the location panel. Results are cached in memory only; visitors' coordinates are not stored.

const AU_STATES = {
  Queensland: 'QLD', 'New South Wales': 'NSW', Victoria: 'VIC', Tasmania: 'TAS', 'South Australia': 'SA',
  'Western Australia': 'WA', 'Northern Territory': 'NT', 'Australian Capital Territory': 'ACT',
};
const AU_STATE_NAMES = Object.fromEntries(Object.entries(AU_STATES).map(([name, code]) => [code, name]));

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (cc) => {
  try {
    return countryNames.of(cc) || cc;
  } catch {
    return cc;
  }
};

/** A small insertion-ordered cache: entries expire after `ttlMs`, and the oldest go first past `max`. */
function cache(ttlMs, max = 500) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value;
      map.delete(key);
      return undefined;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, { at: Date.now(), value });
      if (map.size > max) map.delete(map.keys().next().value);
    },
  };
}

const userAgent = () => `KangooRental/1.0 (${config.baseUrl})`;

/* ---------- Reverse geocoding (OpenStreetMap Nominatim: max 1 request per second, so queue and cache) ---------- */

const reverseCache = cache(24 * 3600 * 1000);
let nominatimQueue = Promise.resolve();
let queued = 0;

function nominatim(url) {
  if (queued >= 10) return Promise.reject(new Error('Location lookups are busy.'));
  queued++;
  const run = nominatimQueue.then(async () => {
    const res = await fetch(url, { headers: { 'User-Agent': userAgent(), 'Accept-Language': 'en' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    return res.json();
  }).finally(() => { queued--; });
  nominatimQueue = run.catch(() => {}).then(() => new Promise((resolve) => setTimeout(resolve, 1100)));
  return run;
}

/** Closest suburb/town, state and country for a point, or null if the lookup fails. */
export async function reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  const hit = reverseCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.search = new URLSearchParams({ format: 'jsonv2', lat: String(lat), lon: String(lng), zoom: '14', addressdetails: '1' }).toString();
    const a = (await nominatim(url)).address || {};
    const countryCode = String(a.country_code || '').toUpperCase();
    const state = a.state || a.region || a.state_district || '';
    const place = {
      suburb: a.suburb || a.neighbourhood || a.quarter || a.village || a.town || a.city_district || a.hamlet || a.city || a.municipality || a.county || '',
      state,
      stateCode: countryCode === 'AU' ? AU_STATES[state] || '' : '',
      country: a.country || countryName(countryCode),
      countryCode,
      lat,
      lng,
    };
    const result = /^[A-Z]{2}$/.test(countryCode) ? place : null;
    reverseCache.set(key, result);
    return result;
  } catch (err) {
    console.warn('[geo] reverse lookup failed:', err.message);
    return null;
  }
}

/* ---------- Suburb search (Open-Meteo geocoding, from GeoNames) ---------- */

const searchCache = cache(3600 * 1000);

async function geonames(name, countryCode) {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.search = new URLSearchParams({ name, count: '10', language: 'en', format: 'json', ...(countryCode ? { countryCode } : {}) }).toString();
  const res = await fetch(url, { headers: { 'User-Agent': userAgent() }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Geocoding HTTP ${res.status}`);
  return (await res.json()).results || [];
}

/**
 * Places matching "Suburb" or "Suburb, State/Country" (also "Suburb QLD"). Results in `preferCountry`
 * (the visitor's current country) come first.
 */
export async function searchPlaces(query, preferCountry = 'AU') {
  let [name, ...rest] = query.split(',').map((s) => s.trim());
  let filter = rest.join(' ').toLowerCase();
  const stateSuffix = name.match(/\s+(QLD|NSW|VIC|TAS|SA|WA|NT|ACT)$/i);
  if (stateSuffix) {
    name = name.slice(0, stateSuffix.index);
    filter = stateSuffix[1].toLowerCase();
  }
  if (name.length < 2) return [];

  const key = `${name.toLowerCase()}|${filter}|${preferCountry}`;
  const hit = searchCache.get(key);
  if (hit) return hit;

  const [local, global] = await Promise.all([geonames(name, preferCountry).catch(() => []), geonames(name)]);
  const unique = new Map([...local, ...global].map((r) => [r.id, r]));
  const results = [...unique.values()]
    .filter((r) => /^[A-Z]{2}$/.test(r.country_code || ''))
    .map((r) => ({
      suburb: r.name,
      state: r.admin1 || '',
      stateCode: r.country_code === 'AU' ? AU_STATES[r.admin1] || '' : '',
      country: r.country || countryName(r.country_code),
      countryCode: r.country_code,
      lat: r.latitude,
      lng: r.longitude,
    }))
    .filter((p) => !filter || [p.state, p.stateCode, p.country, p.countryCode].some((v) => v.toLowerCase().startsWith(filter)))
    .slice(0, 6);
  searchCache.set(key, results);
  return results;
}

/* ---------- Approximate place from the visitor's IP (Vercel adds these headers) ---------- */

export function ipPlace(req) {
  if (!config.onVercel) return null;
  const header = (name) => {
    const v = req.get(name) || '';
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  const countryCode = header('x-vercel-ip-country').toUpperCase();
  const lat = Number(header('x-vercel-ip-latitude'));
  const lng = Number(header('x-vercel-ip-longitude'));
  if (!/^[A-Z]{2}$/.test(countryCode) || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const region = header('x-vercel-ip-country-region');
  const stateCode = countryCode === 'AU' && AU_STATE_NAMES[region] ? region : '';
  return {
    suburb: header('x-vercel-ip-city'),
    state: stateCode ? AU_STATE_NAMES[stateCode] : region,
    stateCode,
    country: countryName(countryCode),
    countryCode,
    lat,
    lng,
    approximate: true,
  };
}
