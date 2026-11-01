import { Router } from 'express';
import { getSettings, num } from '../db.js';
import { currentRate, usdMarketRates } from '../fx.js';
import { currencyFor, pricingCurrencyFor } from '../currencies.js';
import { reverseGeocode, searchPlaces, ipPlace } from '../geo.js';
import { HttpError, rateLimit } from '../security.js';
import { distanceKm } from '../util.js';

export const router = Router();

// Weather comes from Open-Meteo (free, no key), cached for 10 minutes per ~1 km square.
const weatherCache = new Map();

const WEATHER_CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm with hail',
};

/** Current conditions and a 4-day forecast in the point's own time zone, or null if Open-Meteo is unavailable. */
async function getWeather(lat, lng) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = weatherCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({
      latitude: lat.toFixed(2), longitude: lng.toFixed(2), timezone: 'auto', forecast_days: '4',
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,sunrise,sunset',
    }).toString();
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const data = {
      timezone: d.timezone,
      current: {
        temperature: d.current.temperature_2m,
        feelsLike: d.current.apparent_temperature,
        humidity: d.current.relative_humidity_2m,
        windKmh: d.current.wind_speed_10m,
        precipitationMm: d.current.precipitation,
        summary: WEATHER_CODES[d.current.weather_code] || 'Mixed conditions',
        code: d.current.weather_code,
      },
      daily: d.daily.time.map((date, i) => ({
        date,
        max: d.daily.temperature_2m_max[i],
        min: d.daily.temperature_2m_min[i],
        rainChance: d.daily.precipitation_probability_max[i],
        uv: d.daily.uv_index_max[i],
        sunrise: d.daily.sunrise[i],
        sunset: d.daily.sunset[i],
        summary: WEATHER_CODES[d.daily.weather_code[i]] || 'Mixed conditions',
        code: d.daily.weather_code[i],
      })),
    };
    weatherCache.delete(key);
    weatherCache.set(key, { at: Date.now(), data });
    if (weatherCache.size > 500) weatherCache.delete(weatherCache.keys().next().value);
    return data;
  } catch (err) {
    console.warn('[hub] weather fetch failed:', err.message);
    return null;
  }
}

router.get('/hub', async (req, res) => {
  const settings = await getSettings();
  const lat = num(settings, 'pickup_lat');
  const lng = num(settings, 'pickup_lng');
  res.json({
    pickup: { label: settings.pickup_label, lat, lng },
    timezone: 'Australia/Brisbane',
    weather: await getWeather(lat, lng),
    fx: currentRate(settings),
  });
});

/* ---------- Visitor location panel ---------- */

function point(lat, lng) {
  const p = { lat: Number(lat), lng: Number(lng) };
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
    throw new HttpError(400, 'Location is not valid.');
  }
  return p;
}

/**
 * Local conditions for the visitor's place and the site's pricing currency.
 *  - ?lat&lng&reverse=1  device location: also looks up the closest suburb
 *  - ?lat&lng&cc=AU      a place the visitor chose (the browser already has its name)
 *  - no query            approximate place from the visitor's IP, else the pickup depot
 */
router.get('/locale', rateLimit({ windowMs: 60 * 1000, max: 40, message: 'Too many location lookups. Please wait a minute.' }), async (req, res) => {
  const settings = await getSettings();
  const depot = { lat: num(settings, 'pickup_lat'), lng: num(settings, 'pickup_lng') };
  let place = null;
  let where;
  let countryCode = '';
  if (req.query.lat !== undefined || req.query.lng !== undefined) {
    where = point(req.query.lat, req.query.lng);
    if (req.query.reverse === '1') place = await reverseGeocode(where.lat, where.lng);
    countryCode = place?.countryCode || (/^[A-Z]{2}$/.test(req.query.cc) ? req.query.cc : '');
  } else {
    place = ipPlace(req) || { ...(await reverseGeocode(depot.lat, depot.lng)), ...depot, depot: true };
    if (!place.countryCode) place = { suburb: settings.pickup_label, state: '', stateCode: '', country: 'Australia', countryCode: 'AU', ...depot, depot: true };
    where = place;
    countryCode = place.countryCode;
  }

  const [weather, market] = await Promise.all([getWeather(where.lat, where.lng), usdMarketRates()]);
  const fx = currentRate(settings);
  const code = countryCode ? currencyFor(countryCode) : '';
  // AUD uses the site's own rate so the panel matches the prices; other currencies use the market feed.
  const perUsd = code === 'AUD' ? fx.audPerUsd : code === 'USD' ? 1 : market.rates?.[code] ?? null;

  res.json({
    place,
    countryCode,
    timezone: weather?.timezone || null,
    weather: weather && { current: weather.current, today: weather.daily[0] },
    currency: code ? { code, perUsd, date: code === 'AUD' ? fx.date : market.date } : null,
    usdPerAud: fx.usdPerAud,
    audPerUsd: fx.audPerUsd,
    pricingCurrency: countryCode ? pricingCurrencyFor(countryCode) : null,
    depot: { label: settings.pickup_label, km: Math.round(distanceKm(where.lat, where.lng, depot.lat, depot.lng)) },
  });
});

router.get('/locale/search', rateLimit({ windowMs: 60 * 1000, max: 30, message: 'Too many searches. Please wait a minute.' }), async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const prefer = /^[A-Z]{2}$/.test(req.query.cc) ? req.query.cc : 'AU';
  try {
    res.json({ results: await searchPlaces(q, prefer) });
  } catch (err) {
    console.warn('[hub] place search failed:', err.message);
    throw new HttpError(502, 'Suburb search is unavailable right now. Please try again shortly.');
  }
});
