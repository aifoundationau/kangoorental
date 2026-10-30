import { getSettings, setSettings, num } from './db.js';

// USD -> AUD exchange rate. Live mode refreshes from a public market-rate feed every few hours and
// falls back to the last good rate, then to the superadmin's manual rate.

const REFRESH_MS = 6 * 3600 * 1000;

const SOURCES = [
  {
    name: 'Frankfurter (European Central Bank)',
    url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD',
    read: (d) => ({ rate: d?.rates?.AUD, date: d?.date }),
  },
  {
    name: 'ExchangeRate-API',
    url: 'https://open.er-api.com/v6/latest/USD',
    read: (d) => ({
      rate: d?.result === 'success' ? d?.rates?.AUD : undefined,
      date: d?.time_last_update_unix ? new Date(d.time_last_update_unix * 1000).toISOString().slice(0, 10) : '',
    }),
  },
];

export async function refreshLiveRate() {
  for (const source of SOURCES) {
    try {
      const res = await fetch(source.url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const { rate, date } = source.read(await res.json());
      // Sanity bounds stop a bad feed from mispricing every booking.
      if (typeof rate !== 'number' || rate < 0.8 || rate > 3) continue;
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

/** Current AUD-per-USD rate and where it came from, from already-loaded settings. */
export function currentRate(settings) {
  const live = num(settings, 'fx_live_rate');
  if (settings.fx_mode === 'live' && live > 0) {
    return {
      rate: live,
      mode: 'live',
      source: settings.fx_live_source,
      date: settings.fx_live_date,
      checkedAt: settings.fx_live_checked_at,
    };
  }
  return {
    rate: num(settings, 'fx_manual_rate'),
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
