import {
  api, getMe, getConfig, isStaff, formatAud, formatUsd, formatPrice, quotePrices, formatTokens, formatRate, formatDate, formatDateTime, formatTime,
  formatLongDate, weatherIcon, getDeviceLocation, toast, showError, setBusy, escapeHtml, ApiError,
} from './common.js';
import { pricingCurrency, DEPOT_TZ } from './prefs.js';

const DAY = 86400000;
const PENDING_KEY = 'kangoo.pendingBooking';
const $ = (id) => document.getElementById(id);

const state = {
  cfg: null,
  me: null,
  busy: [],
  busyFrom: '',
  busyTo: '',
  month: null, // { y, m } (m: 0-11)
  date: '',
  time: '',
  days: 1,
  quote: null,
  area: null, // last "Check my location" result; the server checks again with every booking
};

/* ---------- Brisbane date helpers (always UTC+10) ---------- */

const brisbaneMs = (date, time = '00:00') => Date.parse(`${date}T${time}:00+10:00`);
const isoDate = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dayDiff = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const hourLabel = (h) => formatTime(Date.UTC(2000, 0, 1, h), 'UTC');

function slotOk(date, hour, days) {
  const start = brisbaneMs(date, `${String(hour).padStart(2, '0')}:00`);
  const end = start + days * DAY;
  if (start < Date.now() + state.cfg.minNoticeHours * 3600000) return false;
  if (start > Date.now() + state.cfg.maxAdvanceDays * DAY) return false;
  return !state.busy.some((r) => r.start < end && r.end > start);
}

function dayStatus(date) {
  const { firstPickupHour: first, lastPickupHour: last } = state.cfg;
  const dayStart = brisbaneMs(date);
  if (dayStart + DAY < Date.now() + state.cfg.minNoticeHours * 3600000) return 'past';
  if (dayStart > Date.now() + state.cfg.maxAdvanceDays * DAY) return 'past';
  if (state.busy.some((r) => r.kind === 'blocked' && r.start <= dayStart && r.end >= dayStart + DAY)) return 'blocked';
  let open = 0;
  let total = 0;
  for (let h = first; h <= last; h++) {
    const start = brisbaneMs(date, `${String(h).padStart(2, '0')}:00`);
    if (start < Date.now() + state.cfg.minNoticeHours * 3600000) continue;
    total++;
    if (slotOk(date, h, 1)) open++;
  }
  if (total === 0) return 'past';
  if (open === 0) return 'booked';
  const touched = state.busy.some((r) => r.start < dayStart + DAY && r.end > dayStart);
  return open < total || touched ? 'partial' : 'available';
}

/* ---------- Data ---------- */

async function loadBusy() {
  const { y, m } = state.month;
  const from = isoDate(y, m, 1);
  const to = isoDate(y, m, new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
  const data = await api(`/availability?from=${from}&to=${to}`);
  state.busy = data.busy;
}

async function loadQuote() {
  state.quote = await api(`/quote?days=${state.days}`);
  renderQuote();
}

/* ---------- Rendering ---------- */

function updateBookingSummary() {
  const summary = $('bkSummary');
  if (!summary) return;
  if (!state.date) {
    summary.textContent = 'Click a day panel on the calendar to begin';
    return;
  }
  const end = addDays(state.date, state.days - 1);
  if (state.days === 1) {
    summary.textContent = `${formatDate(state.date)} (1 day)`;
  } else {
    summary.textContent = `${formatDate(state.date)} – ${formatDate(end)} (${state.days} days)`;
  }
}

function renderCalendar() {
  const { y, m } = state.month;
  $('calTitle').textContent = new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-AU', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  const firstDow = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7; // Monday first
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="cal-dow" role="columnheader">${d}</div>`);
  for (let i = 0; i < firstDow; i++) cells.push('<div class="cal-empty"></div>');
  for (let d = 1; d <= daysInMonth; d++) {
    const date = isoDate(y, m, d);
    const status = dayStatus(date);
    const selectable = status === 'available' || status === 'partial';
    // The hire's days: all days in the run are selected/highlighted
    const offset = state.date ? dayDiff(state.date, date) : -1;
    const inRun = offset >= 0 && offset < state.days;
    const run = inRun ? (offset === 0 || offset === state.days - 1 ? ' selected' : ' in-range') : '';
    const noHandover = selectable && !handoverOk(date);
    const today = date === state.cfg.today ? ' today' : '';
    cells.push(`<button type="button" role="gridcell" class="cal-day ${status}${noHandover ? ' nohandover' : ''}${run}${today}"
      data-date="${date}" data-testid="cal-${date}" data-agent-id="cal-${date}" ${selectable ? '' : 'disabled'} aria-pressed="${inRun}"
      aria-label="${date} ${status}${noHandover ? ', no pickups or returns' : ''}${inRun ? ', in your hire' : ''}">${d}</button>`);
  }
  $('calendar').innerHTML = cells.join('');
  const now = new Date(Date.now() + 10 * 3600000);
  $('calPrev').disabled = y === now.getUTCFullYear() && m === now.getUTCMonth();
  updateBookingSummary();
}

function renderTimes() {
  const first = state.cfg?.firstPickupHour || 7;
  state.time = state.time || `${String(first).padStart(2, '0')}:00`;
  const el = $('bkTime');
  if (el) el.value = state.time;
  renderReturn();
}

function renderReturn() {
  updateBookingSummary();
}

function renderQuote() {
  const q = state.quote;
  if (!q) return;
  const p = quotePrices(q);
  const discounted = q.discountCents > 0;
  $('qListRow').hidden = !discounted;
  $('qDiscountRow').hidden = !discounted;
  $('qListLabel').textContent = `Rental, ${q.days} day${q.days > 1 ? 's' : ''}`;
  $('qList').textContent = formatPrice(p.list);
  $('qDiscount').textContent = `−${formatPrice(p.discount)}`;
  $('qSubtotal').textContent = formatPrice(p.subtotal);
  $('qGst').textContent = formatPrice(p.gst);
  $('qTotalLabel').textContent = pricingCurrency() === 'AUD' ? 'Total (AUD)' : 'Total (AUD / USD)';
  $('qTotal').textContent = formatPrice(p.total);
  $('qTokens').textContent = `${formatTokens(q.tokenCents)} tokens`;
  $('qRate').textContent = pricingCurrency() === 'AUD'
    ? 'Default token price: 1 token = AUD$1. All invoices are issued in Australian dollars (AUD$).'
    : `Currency conversion for international visitors: AUD$1 = US$${formatRate(q.fxRate)}. All invoices are in Australian dollars (AUD$).`;
}

function renderPricing() {
  const { cfg } = state;
  const q = cfg.dailyQuote;
  const p = quotePrices(q);
  $('heroPrice').innerHTML = `<span class="price-main">${formatAud(p.subtotal.aud)}</span><span class="price-sub">${pricingCurrency() === 'USD' ? `(${formatUsd(p.subtotal.usd)}) ` : ''}+ GST per day &middot; ${formatTokens(q.tokenCents)} tokens</span>`;
  renderPriceCards();
}

/** One price card per hire length (AUD prices and token amounts set by the superadmin). */
function renderPriceCards() {
  const list = state.cfg.priceList;
  const day1 = list[0];
  const isIntl = pricingCurrency() === 'USD';
  $('pxCards').innerHTML = list.map((p) => {
    const label = `${p.days} day${p.days > 1 ? 's' : ''}`;
    const audPrice = formatAud(p.audCents);
    const usdNote = isIntl ? ` (${formatUsd(p.usdCents)})` : '';
    const tokensLabel = p.tokenCents ? ` · ${formatTokens(p.tokenCents)} tokens` : '';
    const save = { aud: day1.audCents * p.days - p.audCents, usd: day1.usdCents * p.days - p.usdCents };
    const best = p.days === list.length && list.length > 1;
    return `<button type="button" class="postcard${best ? ' best' : ''}" data-days="${p.days}" aria-pressed="${p.days === state.days}"
        data-testid="price-card-${p.days}" data-agent-id="price-card-${p.days}" aria-label="${label} for ${audPrice}${usdNote} before GST">
      ${best ? '<span class="pc-ribbon">Best value</span>' : ''}
      <span class="pc-days">${label}</span>
      <strong class="pc-price">${audPrice}</strong>
      <span class="pc-sub">${isIntl ? `≈ ${formatUsd(p.usdCents)} ` : ''}+ GST${tokensLabel}</span>
      ${save.aud > 0 ? `<span class="pc-stamp">Save ${formatAud(save.aud)}</span>` : `<span class="pc-stamp plain">${formatAud(p.audCents / p.days)} a day</span>`}
    </button>`;
  }).join('');
}

/** The hire-length cards in the booking form: one choice, which stays selected and sets the booking's days. */
function renderDayCards() {
  $('bkDays').innerHTML = state.cfg.priceList.map((p) => {
    const label = `${p.days} day${p.days > 1 ? 's' : ''}`;
    const price = formatAud(p.audCents);
    const on = p.days === state.days;
    return `<button type="button" class="postcard mini" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-days="${p.days}"
        data-testid="book-days-${p.days}" data-agent-id="book-days-${p.days}" aria-label="${label}, ${price} before GST">
      <span class="pc-days">${label}</span><strong class="pc-price">${price}</strong></button>`;
  }).join('');
  markDayCards();
}

/**
 * Lights up the "How long?" cards up to the hire length; the matching card is the selected one. Once a pickup day is
 * chosen, lengths that would be returned on a day with no returns are greyed out.
 */
function markDayCards() {
  $('bkDays').querySelectorAll('[data-days]').forEach((card) => {
    const days = Number(card.dataset.days);
    const ok = !state.date || lengthOk(state.date, days);
    card.disabled = !ok;
    card.title = ok ? '' : `Returns aren't available on ${formatDate(addDays(state.date, days))}`;
    card.setAttribute('aria-checked', String(days === state.days));
    card.tabIndex = days === state.days ? 0 : -1;
    card.classList.toggle('lit', days < state.days);
  });
}

const canBook = (date) => ['available', 'partial'].includes(dayStatus(date));
/** True if every day from `start` for `days` days can be picked on the calendar. */
const runOpen = (start, days) => Array.from({ length: days }, (_, i) => addDays(start, i)).every(canBook);

/** Pickups and returns only happen on the owner's available days (Pickup days in the admin panel). */
function handoverOk(date) {
  const { weekdays, overrides } = state.cfg.handover;
  return date in overrides ? overrides[date] : weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay());
}

/** A hire of `days` from `start` works if every day is free and it's picked up and returned on available days. */
const lengthOk = (start, days) => runOpen(start, days) && handoverOk(start) && handoverOk(addDays(start, days));
const validLengths = (start) => Array.from({ length: state.cfg.maxRentalDays }, (_, i) => i + 1).filter((d) => lengthOk(start, d));

function calNote(text) {
  $('calNote').textContent = text;
  $('calNote').hidden = !text;
}

/**
 * Calendar clicks choose up to maxRentalDays days in a row. The first day picked is the pickup day. Clicking a later day
 * (or a day inside the run) makes the hire end on that day; clicking anywhere else starts a new hire from that day.
 * The van is returned the day after the last day, at the pickup time.
 */
function pickCalendarDay(date) {
  if (!handoverOk(date)) return calNote(`That date (${formatDate(date)}) has no pickups or returns. Striped days cannot be booked.`);
  if (!canBook(date)) return calNote(`${formatDate(date)} is already booked. Please choose another date.`);

  const offset = state.date ? dayDiff(state.date, date) : -1;
  if (state.date && offset > 0 && offset < state.cfg.maxRentalDays) {
    if (runOpen(state.date, offset + 1)) {
      const days = offset + 1;
      calNote('');
      setDays(days);
      return;
    }
  }

  if (state.date && offset === 0 && state.days > 1) {
    calNote('');
    setDays(1);
    return;
  }

  startHire(date);
}

function startHire(date) {
  if (!handoverOk(date)) return calNote(`Pickups aren't available on ${formatDate(date)}. Striped days have no pickups or returns.`);
  if (!canBook(date)) return calNote(`${formatDate(date)} is not available for booking.`);
  calNote('');
  state.days = 1;
  selectDate(date);
}

function chooseDays(days) {
  if (state.date && !runOpen(state.date, days)) {
    return calNote(`A ${days}-day hire from ${formatDate(state.date)} isn't available: one or more days are booked.`);
  }
  calNote('');
  return setDays(days);
}

async function setDays(days) {
  state.days = days;
  $('pxCards').querySelectorAll('[data-days]').forEach((card) => card.setAttribute('aria-pressed', String(Number(card.dataset.days) === days)));
  renderCalendar();
  renderTimes();
  await loadQuote();
  renderAuthPanel();
}

function renderAuthPanel() {
  const me = state.me;
  const box = $('confirmBox');
  const hint = $('bkAuthHint');
  const submit = $('bkSubmit');
  if (!me) {
    box.hidden = true;
    hint.hidden = false;
    hint.innerHTML = 'You\'ll need to <a href="/register">register</a> or <a href="/login?next=/%23book">log in</a> and verify your licence before booking.';
    submit.textContent = 'Continue to register';
    return;
  }
  if (isStaff(me)) {
    box.hidden = true;
    hint.hidden = false;
    hint.textContent = 'You are logged in as staff. Use a customer account to make bookings.';
    submit.disabled = true;
    return;
  }
  hint.hidden = true;
  box.hidden = false;
  submit.textContent = 'Confirm booking';
  const items = [];
  const radius = state.cfg.bookingRadiusKm;
  items.push(state.area?.inArea
    ? `<li class="ok">Within ${radius} km of our depot (you're ${state.area.distanceKm} km away)</li>`
    : `<li class="todo">Within ${radius} km of our depot${state.area ? `: you appear to be ${state.area.distanceKm} km away` : ''}
        &middot; <button class="link-button" type="button" id="bkCheckLocation">Check my location</button></li>`);
  const licenceOk = me.licenceStatus === 'verified';
  items.push(`<li class="${licenceOk ? 'ok' : 'todo'}">Driver licence ${licenceOk ? 'verified' : `<a href="/account#licence">${me.licenceStatus === 'pending' ? 'awaiting review' : 'needs verifying'}</a>`}</li>`);
  const insOk = me.insurer && me.indemnityConfirmed && me.policyExpiry;
  items.push(`<li class="${insOk ? 'ok' : 'todo'}">Insurance ${insOk ? `on file (${escapeHtml(me.insurer)}, expires ${escapeHtml(me.policyExpiry)})` : '<a href="/account#insurance">add your insurance details</a>'}</li>`);
  const need = state.quote?.tokenCents ?? 0;
  const tokensOk = me.tokenCents >= need;
  items.push(`<li class="${tokensOk ? 'ok' : 'todo'}">Tokens: ${formatTokens(me.tokenCents)} available${tokensOk ? '' : ` &middot; <a href="/account?buy=${Math.ceil((need - me.tokenCents) / 100)}#tokens">buy ${Math.ceil((need - me.tokenCents) / 100)} more</a>`}</li>`);
  $('checklist').innerHTML = `<ul>${items.join('')}</ul>`;
}

/* ---------- Events ---------- */

async function checkLocation() {
  showError($('bkError'), null);
  try {
    const { lat, lng } = await getDeviceLocation();
    state.area = await api('/geo/check', { method: 'POST', body: { lat, lng } });
  } catch (err) {
    showError($('bkError'), err);
  }
  renderAuthPanel();
}

async function changeMonth(delta) {
  let { y, m } = state.month;
  m += delta;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  state.month = { y, m };
  await loadBusy();
  renderCalendar();
}

function selectDate(date) {
  state.date = date;
  if ($('bkDate')) $('bkDate').value = date;
  const [y, m] = date.split('-').map(Number);
  const monthChanged = state.month.y !== y || state.month.m !== m - 1;
  state.month = { y, m: m - 1 };
  const after = monthChanged ? loadBusy() : Promise.resolve();
  after.then(() => {
    renderCalendar();
    renderTimes();
    loadQuote();
    renderAuthPanel();
  });
}

async function submitBooking(e) {
  e.preventDefault();
  const errEl = $('bkError');
  showError(errEl, null);
  if (!state.date) return showError(errEl, new Error('Please click an available day panel on the calendar.'));
  state.time = state.time || '07:00';

  if (!state.me) {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ date: state.date, time: state.time, days: state.days }));
    window.location.href = '/register';
    return;
  }
  if (!$('bkDisclaimer').checked) return showError(errEl, new Error('Please accept the rental disclaimer and insurance requirements.'));

  const btn = $('bkSubmit');
  setBusy(btn, true, 'Checking your location…');
  let here;
  try {
    here = await getDeviceLocation();
  } catch (err) {
    setBusy(btn, false);
    return showError(errEl, err);
  }
  setBusy(btn, false);
  setBusy(btn, true, 'Booking…');
  try {
    const { booking } = await api('/bookings', {
      method: 'POST',
      body: {
        date: state.date, time: state.time, days: state.days, acceptDisclaimer: true, note: $('bkNote').value,
        lat: here.lat, lng: here.lng,
      },
    });
    sessionStorage.removeItem(PENDING_KEY);
    toast(`Booked! Reference ${booking.ref}`, 'success');
    window.location.href = `/account?booked=${encodeURIComponent(booking.ref)}#bookings`;
  } catch (err) {
    showError(errEl, err);
    if (err instanceof ApiError && err.status === 409) {
      await loadBusy();
      renderCalendar();
      renderTimes();
    }
  } finally {
    setBusy(btn, false);
  }
}

/* ---------- Location, Weather & Time Hub ---------- */

function startClock() {
  const clock = $('hubClock');
  const dateEl = $('hubDate');
  const tick = () => {
    const now = new Date();
    clock.textContent = formatTime(now, DEPOT_TZ, { seconds: true });
    dateEl.textContent = formatLongDate(now, DEPOT_TZ);
  };
  tick();
  setInterval(tick, 1000);
}

async function loadHub() {
  try {
    const hub = await api('/hub');
    const { lat, lng, label } = hub.pickup;
    $('hubPickup').textContent = label;
    const d = 0.012;
    const frame = document.createElement('iframe');
    frame.title = `Map of ${label}`;
    frame.loading = 'lazy';
    frame.referrerPolicy = 'no-referrer';
    frame.src = `https://www.openstreetmap.org/export/embed.html?bbox=${lng - d},${lat - d},${lng + d},${lat + d}&layer=mapnik&marker=${lat},${lng}`;
    $('hubMap').replaceChildren(frame);
    $('hubDirections').href = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

    $('hubFx').textContent = `AUD$1 = US$${formatRate(hub.fx.rate)}`;
    $('hubFxSource').textContent = hub.fx.mode === 'live'
      ? `Market rate from ${hub.fx.source}${hub.fx.date ? `, ${hub.fx.date}` : ''} (shown to visitors outside AU & NZ).`
      : `${hub.fx.source} (shown to visitors outside AU & NZ).`;

    const w = hub.weather;
    if (!w) {
      $('hubWeather').innerHTML = '<p class="hint">Weather is unavailable right now.</p>';
      return;
    }
    const c = w.current;
    const days = w.daily.map((day) => `
      <li><span class="wx-day">${new Date(`${day.date}T12:00:00+10:00`).toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'short' })}</span>
        <span class="wx-icon" aria-hidden="true">${weatherIcon(day.code)}</span>
        <span>${Math.round(day.min)}°–${Math.round(day.max)}°</span>
        <span class="wx-rain">${day.rainChance ?? 0}% rain</span></li>`).join('');
    const today = w.daily[0];
    const t = (iso) => formatTime(Date.parse(`${iso}:00+10:00`), DEPOT_TZ);
    $('hubWeather').innerHTML = `
      <div class="wx-now">
        <span class="wx-big" aria-hidden="true">${weatherIcon(c.code)}</span>
        <div><p class="big-figure">${Math.round(c.temperature)}°C</p>
          <p>${escapeHtml(c.summary)} &middot; feels like ${Math.round(c.feelsLike)}°</p></div>
      </div>
      <p class="hint">Humidity ${c.humidity}% &middot; wind ${Math.round(c.windKmh)} km/h &middot; UV max ${today.uv ?? '–'}</p>
      <p class="hint">Sunrise ${t(today.sunrise)} &middot; sunset ${t(today.sunset)}</p>
      <ul class="wx-days">${days}</ul>
      <p class="fine-print">Weather data by Open-Meteo.</p>`;
  } catch {
    $('hubWeather').innerHTML = '<p class="hint">Weather is unavailable right now.</p>';
  }
}

function locateMe() {
  const out = $('hubDistance');
  if (!navigator.geolocation) {
    out.textContent = 'Your browser does not support location.';
    return;
  }
  out.textContent = 'Finding your location…';
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const r = await api('/geo/check', { method: 'POST', body: { lat: pos.coords.latitude, lng: pos.coords.longitude } });
      out.textContent = r.inArea
        ? `You're about ${r.distanceKm} km from the depot, inside our ${r.radiusKm} km service area.`
        : `You're about ${r.distanceKm} km away. Bookings are open to people within ${r.radiusKm} km of the depot.`;
    } catch (err) {
      out.textContent = err.message;
    }
  }, () => { out.textContent = 'Location permission was denied.'; }, { enableHighAccuracy: false, timeout: 10000 });
}

/* ---------- Init ---------- */

async function init() {
  startClock();
  loadHub();
  $('hubLocate').addEventListener('click', locateMe);

  const [cfg, me] = await Promise.all([getConfig(), getMe()]);
  state.cfg = cfg;
  state.me = me;
  // A booking started before signing up resumes with the same hire length.
  const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
  if (pending?.days) state.days = Math.min(Number(pending.days), cfg.maxRentalDays);
  renderPricing();
  renderDayCards();

  const [ty, tm] = cfg.today.split('-').map(Number);
  state.month = { y: ty, m: tm - 1 };
  $('bkDate').min = cfg.today;
  $('bkDate').max = addDays(cfg.today, cfg.maxAdvanceDays);

  await Promise.all([loadBusy(), loadQuote()]);
  renderCalendar();
  renderTimes();
  renderAuthPanel();

  if (pending?.date && pending.date >= cfg.today) {
    state.time = pending.time;
    selectDate(pending.date);
    if (me && location.hash !== '#book') document.getElementById('book').scrollIntoView();
  }

  $('calPrev').addEventListener('click', () => changeMonth(-1));
  $('calNext').addEventListener('click', () => changeMonth(1));
  $('calendar').addEventListener('click', (e) => {
    const btn = e.target.closest('.cal-day');
    if (btn && !btn.disabled) pickCalendarDay(btn.dataset.date);
  });
  $('bkDate').addEventListener('change', (e) => e.target.value && startHire(e.target.value));
  $('bkTime').addEventListener('change', (e) => { state.time = e.target.value; renderReturn(); });
  $('bkDays').addEventListener('click', (e) => {
    const card = e.target.closest('[data-days]');
    if (card && !card.disabled) chooseDays(Number(card.dataset.days));
  });
  // Arrow keys move between the hire lengths that are available, like any other set of options.
  $('bkDays').addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    let days = state.days + step;
    while (days >= 1 && days <= state.cfg.maxRentalDays && state.date && !lengthOk(state.date, days)) days += step;
    if (days < 1 || days > state.cfg.maxRentalDays) return;
    setDays(days).then(() => $('bkDays').querySelector(`[data-days="${days}"]`)?.focus());
  });
  $('pxCards').addEventListener('click', (e) => {
    const card = e.target.closest('[data-days]');
    if (!card) return;
    chooseDays(Number(card.dataset.days));
    document.getElementById('book').scrollIntoView();
  });
  $('bookingForm').addEventListener('submit', submitBooking);
  $('checklist').addEventListener('click', (e) => { if (e.target.id === 'bkCheckLocation') checkLocation(); });
  window.addEventListener('kangoo:prefs', () => {
    renderPricing();
    renderDayCards();
    renderQuote();
    renderTimes();
    loadHub();
  });
}

document.addEventListener('DOMContentLoaded', init);
