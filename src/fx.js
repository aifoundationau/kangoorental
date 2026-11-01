import { getSettings, setSettings, num } from './db.js';

// AUD -> USD exchange rate (how much US$ equals AUD$1) for visitors outside Australia and New Zealand.
// Live mode refreshes from a public market-rate feed every few hours and falls back to the last good rate,
// then to the superadmin's manual rate.

const REFRESH_MS = 6 * 3600 * 1000;

const SOURCES = [
  {
    name: 'Frankfurter (European Central Bank)',
    url: 'https://api.frankfurter.dev/v1/latest?base=AUD&symbols=USD',
    read: (d) => ({ rate: d?.rates?.USD, date: d?.date }),
  },
  {
    name: 'ExchangeRate-API',
    url: 'https://open.er-api.com/v6/latest/AUD',
    read: (d) => ({
      rate: d?.result === 'success' ? d?.rates?.USD : undefined,
      date: d?.time_last_update_unix ? new Date(d.time_last_update_unix * 1000).toISOString().slice(0, 10) : '',
    }),
  },
];

/** Normalizes a rate so it always represents USD per AUD$1 (e.g. ~0.70). If a legacy >1.05 AUD-per-USD rate is stored, inverts it. */
export function normalizeUsdPerAud(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0.7;
  return n > 1.05 ? Number((1 / n).toFixed(4)) : Number(n.toFixed(4));
}

export async function refreshLiveRate() {
  for (const source of SOURCES) {
    try {
      const res = await fetch(source.url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const { rate, date } = source.read(await res.json());
      // Sanity bounds stop a bad feed from mispricing conversions.
      if (typeof rate !== 'number' || rate < 0.3 || rate > 1.5) continue;
      await setSettings({
        fx_live_rate: rate.toFixed(4),
        fx_live_date: date || '',
        fx_live_source: source.name,
        fx_live_checked_at: new Date().toISOString(),
      });
      return true;
    } catch (err) {
      console.warn(`[fx] ${source.name} failed: ${err.message}`);
    }
  }
  return false;
}

/** Current USD-per-AUD$1 rate (e.g. 0.70) and where it came from, from already-loaded settings. */
export function currentRate(settings = {}) {
  const liveRaw = num(settings, 'fx_live_rate');
  if (settings.fx_mode === 'live' && liveRaw > 0) {
    const rate = normalizeUsdPerAud(liveRaw);
    return {
      rate,
      usdPerAud: rate,
      audPerUsd: Number((1 / rate).toFixed(4)),
      mode: 'live',
      source: settings.fx_live_source,
      date: settings.fx_live_date,
      checkedAt: settings.fx_live_checked_at,
    };
  }
  const manualRaw = num(settings, 'fx_manual_rate') || 0.7;
  const rate = normalizeUsdPerAud(manualRaw);
  return {
    rate,
    usdPerAud: rate,
    audPerUsd: Number((1 / rate).toFixed(4)),
    mode: 'manual',
    source: settings.fx_mode === 'live' ? 'Manual rate (live feed unavailable)' : 'Set by superadmin',
    date: '',
    checkedAt: '',
  };
}

let inFlight = null;
let lastAttempt = 0;

/** Refreshes a stale live rate before serving prices. Needed on serverless hosts where timers don't run between requests. */
export async function ensureFreshRate() {
  const s = await getSettings();
  const age = Date.now() - Date.parse(s.fx_live_checked_at || 0);
  if (s.fx_mode !== 'live' || age < REFRESH_MS) return;
  // If the feeds are down, retry at most every 10 minutes rather than slowing every request.
  if (!inFlight && Date.now() - lastAttempt < 10 * 60 * 1000) return;
  if (!inFlight) {
    lastAttempt = Date.now();
    inFlight = refreshLiveRate().finally(() => { inFlight = null; });
  }
  await inFlight;
}

// Market rates from US$1 to every currency, for showing visitors their local currency (not used for pricing).
let marketRates = { at: 0, tried: 0, rates: null, date: '' };
let marketInFlight = null;

/** { rates: { EUR: 0.92, ... } | null, date }: refreshed every few hours; retried at most every 10 minutes if the feed is down. */
export async function usdMarketRates() {
  const now = Date.now();
  if (!marketInFlight && now - marketRates.at > REFRESH_MS && now - marketRates.tried > 10 * 60 * 1000) {
    marketRates.tried = now;
    marketInFlight = (async () => {
      try {
        const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(5000) });
        const d = res.ok ? await res.json() : null;
        if (d?.result !== 'success' || typeof d.rates !== 'object') throw new Error(`HTTP ${res.status}`);
        marketRates = { at: Date.now(), tried: now, rates: d.rates, date: new Date(d.time_last_update_unix * 1000).toISOString().slice(0, 10) };
      } catch (err) {
        console.warn(`[fx] market rates failed: ${err.message}`);
      } finally {
        marketInFlight = null;
      }
    })();
  }
  if (marketInFlight) await marketInFlight;
  return { rates: marketRates.rates, date: marketRates.date };
}

export function startFxUpdates() {
  const tick = async () => {
    try {
      const s = await getSettings();
      const age = Date.now() - Date.parse(s.fx_live_checked_at || 0);
      if (s.fx_mode === 'live' && !(age < REFRESH_MS)) await refreshLiveRate();
    } catch (err) {
      console.warn('[fx] update check failed:', err.message);
    }
  };
  tick();
  setInterval(tick, 15 * 60 * 1000).unref();
}
