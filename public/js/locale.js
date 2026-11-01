import { api, escapeHtml, formatDateTime, formatLongDate, formatTime, weatherIcon } from './common.js';
import { getPrefs, setPrefs, DEPOT_TZ } from './prefs.js';

// The thin location bar at the bottom of every page and its panel: closest suburb, local time and weather, local
// currency and the US dollar rate, and how dates and times are shown. The visitor's country also sets the pricing
// currency (see prefs.js): AUD in Australia and New Zealand, USD everywhere else.

const $ = (id) => document.getElementById(id);
const CACHE_KEY = 'kangoo.locale';
const CACHE_MS = 10 * 60 * 1000;
const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || DEPOT_TZ;

let info = null; // latest /api/locale answer
let results = []; // suburb search results
let searchSeq = 0;
let noteMsg = '';
let clockTimer = null;

const SOURCE_NOTE = {
  gps: 'From your device location.',
  manual: 'Chosen by you.',
  ip: 'Approximate, based on your internet connection.',
  depot: 'This is our pickup depot. Use your location or choose your suburb.',
};

const currencyNames = new Intl.DisplayNames(['en'], { type: 'currency' });
function currencyName(code) {
  try {
    return currencyNames.of(code);
  } catch {
    return code;
  }
}
function money(code, amount) {
  const digits = amount >= 100 ? 2 : 4;
  return new Intl.NumberFormat('en', { style: 'currency', currency: code, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
}

/** The place shown: a suburb the visitor chose or their device location, else what the server worked out. */
const currentPlace = () => getPrefs().place || info?.place || null;
const placeTz = () => info?.timezone || browserTz;
const sourceOf = (p) => p?.source || (p?.depot ? 'depot' : 'ip');
const tzName = (tz) => tz.replace(/_/g, ' ');

function shortPlace(p) {
  if (!p) return 'Location & settings';
  if (p.countryCode === 'AU') return [p.suburb, p.stateCode || p.state].filter(Boolean).join(' ');
  return [p.suburb, p.country].filter(Boolean).join(', ');
}

/* ---------- Data ---------- */

function cacheKey() {
  const p = getPrefs().place;
  return p ? `${p.source}:${p.lat.toFixed(3)},${p.lng.toFixed(3)}` : 'auto';
}

function remember(d) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ key: cacheKey(), at: Date.now(), info: d }));
  } catch {
    // Storage blocked: we'll just ask the server again on the next page.
  }
}

function apply(d) {
  info = d;
  setPrefs({ localTz: d.timezone || browserTz, ...(d.pricingCurrency ? { pricing: d.pricingCurrency } : {}) });
  render();
}

async function load({ fresh = false } = {}) {
  if (!fresh) {
    try {
      const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
      if (cached?.key === cacheKey() && Date.now() - cached.at < CACHE_MS) return apply(cached.info);
    } catch {
      // Fall through to a fresh lookup.
    }
  }
  const p = getPrefs().place;
  try {
    const d = await api(p ? `/locale?lat=${p.lat}&lng=${p.lng}&cc=${p.countryCode}` : '/locale');
    remember(d);
    apply(d);
  } catch (err) {
    note(err.message);
  }
}

function useDevice({ quiet = false } = {}) {
  const say = (msg) => { if (!quiet) note(msg); };
  if (!navigator.geolocation) return say("Your browser can't share its location. Choose your suburb instead.");
  say('Finding your location…');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      // About 100 m is plenty to find the suburb.
      const lat = Number(pos.coords.latitude.toFixed(3));
      const lng = Number(pos.coords.longitude.toFixed(3));
      const d = await api(`/locale?lat=${lat}&lng=${lng}&reverse=1`);
      if (!d.place) throw new Error("We couldn't find a suburb for your location. Choose it instead.");
      setPrefs({ place: { ...d.place, source: 'gps' } });
      remember(d);
      say('');
      apply(d);
    } catch (err) {
      say(err.message);
    }
  }, (err) => {
    say(err.code === 1 ? 'Location permission was denied. Choose your suburb instead.' : 'Your location is unavailable right now. Choose your suburb instead.');
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 10 * 60 * 1000 });
}

/** Refreshes the device location once per visit, but only if the visitor has already allowed it (no prompt). */
async function refreshDeviceLocation() {
  if (getPrefs().place?.source === 'manual' || sessionStorage.getItem('kangoo.gpsChecked')) return;
  try {
    if ((await navigator.permissions?.query({ name: 'geolocation' }))?.state !== 'granted') return;
  } catch {
    return;
  }
  sessionStorage.setItem('kangoo.gpsChecked', '1');
  useDevice({ quiet: true });
}

/* ---------- Suburb search ---------- */

async function search() {
  const q = $('ldQuery').value.trim();
  const list = $('ldResults');
  const seq = ++searchSeq;
  if (q.length < 2) {
    results = [];
    list.innerHTML = '';
    return;
  }
  try {
    const cc = currentPlace()?.countryCode || 'AU';
    const d = await api(`/locale/search?q=${encodeURIComponent(q)}&cc=${cc}`);
    if (seq !== searchSeq) return;
    results = d.results;
    list.innerHTML = results.length
      ? results.map((r, i) => `<li><button type="button" data-i="${i}"><strong>${escapeHtml(r.suburb)}</strong>
          <span>${escapeHtml([r.stateCode || r.state, r.country].filter(Boolean).join(', '))}</span></button></li>`).join('')
      : '<li class="ld-note">No matches. Try just the suburb or town name.</li>';
  } catch (err) {
    if (seq === searchSeq) list.innerHTML = `<li class="ld-note">${escapeHtml(err.message)}</li>`;
  }
}

function openSearch() {
  $('ldSearch').hidden = false;
  $('ldActions').hidden = true;
  $('ldNow').hidden = true; // keeps the panel the same height, so it never needs to scroll
  $('ldQuery').value = '';
  $('ldResults').innerHTML = '';
  $('ldQuery').focus();
}

function closeSearch() {
  $('ldSearch').hidden = true;
  $('ldActions').hidden = false;
  $('ldNow').hidden = false;
}

/** Switches place: drops the old place's weather, time and distance until the new ones arrive. */
function changePlace(place) {
  info = null;
  setPrefs({ place });
  note('');
  render();
  load({ fresh: true });
}

function choose(place) {
  closeSearch();
  changePlace({ ...place, source: 'manual' });
}

/* ---------- Rendering ---------- */

function setItem(id, html) {
  const el = $(id);
  el.hidden = !html;
  if (html) el.innerHTML = html;
}

function renderBar() {
  $('lbPlace').innerHTML = `<span aria-hidden="true">📍</span> ${escapeHtml(shortPlace(currentPlace()))}`;
  const w = info?.weather?.current;
  setItem('lbWeather', w && `<span aria-hidden="true">${weatherIcon(w.code)}</span> ${Math.round(w.temperature)}°C`);
  setItem('lbTime', info && escapeHtml(formatTime(Date.now(), placeTz())));
  const c = info?.currency;
  const isAuNz = getPrefs().pricing === 'AUD';
  const usdRate = info?.usdPerAud ? Number(info.usdPerAud).toFixed(2) : null;
  setItem('lbMoney', c && escapeHtml(isAuNz ? 'AUD$' : `AUD$1 = US$${usdRate || '0.70'}`));
}

function renderPlace() {
  const p = currentPlace();
  // A city's region often has the same name ("Auckland, Auckland"), so show it once.
  $('ldPlace').textContent = p
    ? [...new Set([p.suburb, p.countryCode === 'AU' ? p.stateCode || p.state : p.state].filter(Boolean))].join(', ') || p.country
    : 'Finding your location…';
  const source = sourceOf(p);
  const distance = info && source !== 'depot' ? `${info.depot.km.toLocaleString('en-AU')} km from our ${info.depot.label} depot` : '';
  $('ldPlaceNote').textContent = noteMsg || (p ? `${[p.country, distance].filter(Boolean).join(' · ')}. ${SOURCE_NOTE[source]}` : '');
  $('ldAuto').hidden = !getPrefs().place;
}

function note(msg) {
  noteMsg = msg;
  renderPlace();
}

function renderClock() {
  const tz = placeTz();
  const now = Date.now();
  const offset = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' })
    .formatToParts(now).find((x) => x.type === 'timeZoneName')?.value || '';
  $('ldClock').textContent = formatTime(now, tz, { seconds: true });
  $('ldDate').textContent = formatLongDate(now, tz);
  $('ldZone').textContent = tz === DEPOT_TZ
    ? `${tzName(tz)} (${offset}), same as our pickup depot`
    : `${tzName(tz)} (${offset}) · Brisbane pickup time ${formatTime(now, DEPOT_TZ)}`;
}

function renderWeather() {
  const w = info?.weather;
  if (!w) {
    $('ldWeather').innerHTML = `<p class="ld-note">${info ? 'Weather is unavailable right now.' : 'Loading…'}</p>`;
    return;
  }
  const c = w.current;
  const t = w.today;
  // Sunrise and sunset come as local wall-clock times ("2026-10-31T04:57").
  const wall = (iso) => formatTime(Date.UTC(2000, 0, 1, Number(iso.slice(11, 13)), Number(iso.slice(14, 16))), 'UTC');
  $('ldWeather').innerHTML = `
    <div class="ld-wx"><span class="ld-wx-icon" aria-hidden="true">${weatherIcon(c.code)}</span>
      <div><p class="ld-temp">${Math.round(c.temperature)}°C</p>
        <p class="ld-note">${escapeHtml(c.summary)} &middot; feels like ${Math.round(c.feelsLike)}°</p></div></div>
    <p class="ld-note">Today ${Math.round(t.min)}°–${Math.round(t.max)}° &middot; ${t.rainChance ?? 0}% rain &middot; wind ${Math.round(c.windKmh)} km/h</p>
    <p class="ld-note">Sunrise ${wall(t.sunrise)} &middot; sunset ${wall(t.sunset)}</p>`;
}

function renderMoney() {
  const c = info?.currency;
  const isAuNz = getPrefs().pricing === 'AUD';
  const usdRate = info?.usdPerAud ? Number(info.usdPerAud).toFixed(2) : '0.70';
  $('ldCurrency').textContent = c ? `${currencyName(c.code)} (${c.code})` : 'Australian Dollar (AUD)';
  $('ldRate').textContent = isAuNz
    ? 'Default currency: AUD$ (1 token = AUD$1)'
    : `AUD$1 = US$${usdRate}`;
  const text = isAuNz
    ? 'Prices and all invoices on this site are in Australian dollars (AUD$).'
    : `Currency conversion for visitors outside Australia and New Zealand shows AUD$1 = US$${usdRate}. All invoices are issued in Australian dollars (AUD$).`;
  $('ldPricing').textContent = text;
}

function renderSettings() {
  const prefs = getPrefs();
  $('ldDateFmt').value = prefs.dateFormat;
  $('ldClockFmt').value = prefs.clock;
  $('ldZoneMode').value = prefs.zone;
  $('ldZoneMode').options[1].textContent = prefs.localTz === DEPOT_TZ ? 'My time zone (same as Brisbane)' : `My time zone (${tzName(prefs.localTz)})`;
  $('ldExample').textContent = `Bookings show like this: ${formatDateTime(Date.now())}`;
}

function renderPanel() {
  renderPlace();
  renderClock();
  renderWeather();
  renderMoney();
  renderSettings();
}

function render() {
  renderBar();
  if ($('localeDialog').open) renderPanel();
}

/* ---------- Panel ---------- */

function showTab(name) {
  $('localeDialog').dataset.tab = name;
  document.querySelectorAll('[data-ld-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.ldTab === name)));
}

function openPanel() {
  const dialog = $('localeDialog');
  dialog.showModal();
  renderPanel();
  clearInterval(clockTimer);
  clockTimer = setInterval(renderClock, 1000);
}

function init() {
  const dialog = $('localeDialog');
  if (!dialog) return;

  const fill = (id, options) => { $(id).innerHTML = options.map(([v, label]) => `<option value="${v}">${label}</option>`).join(''); };
  fill('ldDateFmt', [['dmy', 'Day first: 31 Oct 2026'], ['mdy', 'Month first: Oct 31, 2026'], ['ymd', 'Year first: 2026-10-31']]);
  fill('ldClockFmt', [['12', '12-hour: 3:30 pm'], ['24', '24-hour: 15:30']]);
  fill('ldZoneMode', [['depot', 'Brisbane time (pickup depot)'], ['local', 'My time zone']]);
  $('ldDateFmt').addEventListener('change', (e) => setPrefs({ dateFormat: e.target.value }));
  $('ldClockFmt').addEventListener('change', (e) => setPrefs({ clock: e.target.value }));
  $('ldZoneMode').addEventListener('change', (e) => setPrefs({ zone: e.target.value }));

  $('localeBar').addEventListener('click', openPanel);
  $('ldClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); }); // backdrop
  dialog.addEventListener('cancel', (e) => {
    if (!$('ldSearch').hidden) {
      e.preventDefault(); // Esc closes the search first
      closeSearch();
    }
  });
  dialog.addEventListener('close', () => {
    clearInterval(clockTimer);
    closeSearch();
  });
  dialog.querySelectorAll('[data-ld-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.ldTab)));

  $('ldGps').addEventListener('click', () => useDevice());
  $('ldChange').addEventListener('click', openSearch);
  $('ldSearchCancel').addEventListener('click', closeSearch);
  $('ldAuto').addEventListener('click', () => changePlace(null));
  let timer;
  $('ldQuery').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, 300);
  });
  $('ldSearch').addEventListener('submit', (e) => {
    e.preventDefault();
    if (results[0]) choose(results[0]);
  });
  $('ldResults').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) choose(results[Number(b.dataset.i)]);
  });

  window.addEventListener('kangoo:prefs', render);
  renderBar();
  setInterval(renderBar, 15000);
  load().then(refreshDeviceLocation);
}

init();
