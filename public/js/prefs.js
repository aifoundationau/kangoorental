// Visitor display settings, saved in this browser only: date and clock formats, which time zone times are shown in,
// and the place and pricing currency from the location panel. Changes fire a `kangoo:prefs` event so pages can redraw.

const KEY = 'kangoo.prefs';
export const DEPOT_TZ = 'Australia/Brisbane';
const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || DEPOT_TZ;

function defaults() {
  const lang = navigator.language || 'en-AU';
  const hourCycle = new Intl.DateTimeFormat(lang, { hour: 'numeric' }).resolvedOptions().hourCycle;
  return {
    dateFormat: /-US$/i.test(lang) ? 'mdy' : 'dmy', // 'dmy' | 'mdy' | 'ymd'
    clock: hourCycle === 'h23' || hourCycle === 'h24' ? '24' : '12',
    zone: 'depot', // show times in Brisbane (pickup) time, or 'local' for the visitor's own time zone
    place: null, // a suburb the visitor chose, or their device location: { suburb, state, stateCode, country, countryCode, lat, lng, source }
    localTz: browserTz,
    // Until the server confirms the visitor's country, guess Australia or New Zealand from the browser's time zone.
    pricing: /^Australia\/|^Pacific\/(Auckland|Chatham)$/.test(browserTz) ? 'AUD' : 'USD',
  };
}

let prefs = defaults();
try {
  prefs = { ...prefs, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
} catch {
  // Unreadable or blocked storage: keep the defaults.
}

export const getPrefs = () => prefs;

export function setPrefs(patch) {
  const next = { ...prefs, ...patch };
  if (JSON.stringify(next) === JSON.stringify(prefs)) return;
  prefs = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private browsing can block storage; the settings still apply to this page.
  }
  window.dispatchEvent(new CustomEvent('kangoo:prefs'));
}

export const displayTimeZone = () => (prefs.zone === 'local' ? prefs.localTz : DEPOT_TZ);

/** 'AUD' for visitors in Australia and New Zealand, 'USD' for everyone else. */
export const pricingCurrency = () => prefs.pricing;
