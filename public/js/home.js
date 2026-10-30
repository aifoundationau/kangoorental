import {
  api, getMe, getConfig, isStaff, formatPrice, quotePrices, formatTokens, formatRate, formatDate, formatDateTime, formatTime,
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
    // The hire's days: the pickup day and last day are solid, the days between are tinted.
    const offset = state.date ? dayDiff(state.date, date) : -1;
    const inRun = offset >= 0 && offset < state.days;
    const run = inRun ? (offset === 0 || offset === state.days - 1 ? ' selected' : ' in-range') : '';
    const noHandover = selectable && !handoverOk(date);
    const returnDay = state.date && date === addDays(state.date, state.days);
    const today = date === state.cfg.today ? ' today' : '';
    cells.push(`<button type="button" role="gridcell" class="cal-day ${status}${noHandover ? ' nohandover' : ''}${run}${returnDay ? ' return-day' : ''}${today}"
      data-date="${date}" data-testid="cal-${date}" data-agent-id="cal-${date}" ${selectable ? '' : 'disabled'} aria-pressed="${inRun}"
      aria-label="${date} ${status}${noHandover ? ', no pickups or returns' : ''}${inRun ? ', in your hire' : ''}${returnDay ? ', your return day' : ''}">${d}</button>`);
  }
  $('calendar').innerHTML = cells.join('');
  const now = new Date(Date.now() + 10 * 3600000);
  $('calPrev').disabled = y === now.getUTCFullYear() && m === now.getUTCMonth();
}

function renderTimes() {
  const sel = $('bkTime');
  if (!state.date) {
    sel.innerHTML = '<option value="">Choose a date first</option>';
    state.time = '';
    renderReturn();
    return;
  }
  const { firstPickupHour: first, lastPickupHour: last } = state.cfg;
  const options = [];
  let firstOk = '';
  for (let h = first; h <= last; h++) {
    const value = `${String(h).padStart(2, '0')}:00`;
    const ok = state.date ? slotOk(state.date, h, state.days) : false;
    if (ok && !firstOk) firstOk = value;
    options.push(`<option value="${value}" ${ok ? '' : 'disabled'}>${hourLabel(h)}${ok || !state.date ? '' : ' (unavailable)'}</option>`);
  }
  sel.innerHTML = options.join('');
  const currentOk = state.time && state.date && slotOk(state.date, Number(state.time.slice(0, 2)), state.days);
  state.time = currentOk ? state.time : firstOk;
  sel.value = state.time;
  renderReturn();
}

function renderReturn() {
  if (!state.date || !state.time) {
    $('bkReturn').textContent = state.date ? 'No pickup times are free for that many days. Try fewer days or another date.' : 'Return by: choose a date';
    return;
  }
  const end = brisbaneMs(state.date, state.time) + state.days * DAY;
  $('bkReturn').textContent = `Return by ${formatDateTime(end)}`;
}

function renderQuote() {
  const q = state.quote;
  if (!q) return;
  const p = quotePrices(q);
  const discounted = q.discountCents > 0;
  $('qListRow').hidden = !discounted;
  $('qDiscountRow').hidden = !discounted;
  $('qListLabel').textContent = `Rental, ${q.days} × 24 hours`;
  $('qList').textContent = formatPrice(p.list);
  $('qDiscount').textContent = `−${formatPrice(p.discount)}`;
  $('qSubtotal').textContent = formatPrice(p.subtotal);
  $('qGst').textContent = formatPrice(p.gst);
  $('qTotalLabel').textContent = `Total (${pricingCurrency()})`;
  $('qTotal').textContent = formatPrice(p.total);
  $('qTokens').textContent = `${formatTokens(q.tokenCents)} tokens`;
  $('qRate').textContent = pricingCurrency() === 'AUD'
    ? `Converted at today's exchange rate, US$1 = A$${formatRate(q.fxRate)}. Amounts are rounded down to whole dollars and tokens.`
    : '1 token = US$1. Amounts are rounded down to whole dollars and tokens.';
}

function renderPricing() {
  const { cfg } = state;
  const q = cfg.dailyQuote;
  const p = quotePrices(q);
  $('heroPrice').innerHTML = `<span class="price-main">${formatPrice(p.subtotal)}</span><span class="price-sub">+ GST per 24 hours &middot; ${formatTokens(q.tokenCents)} tokens</span>`;
  renderPriceCards();
}

/** One price card per hire length (prices set by the superadmin). The selected card matches the booking's hire length. */
function renderPriceCards() {
  const list = state.cfg.priceList;
  const day1 = list[0];
  $('pxCards').innerHTML = list.map((p) => {
    const label = `${p.days} day${p.days > 1 ? 's' : ''}`;
    const price = formatPrice({ aud: p.audCents, usd: p.usdCents });
    const save = { aud: day1.audCents * p.days - p.audCents, usd: day1.usdCents * p.days - p.usdCents };
    const best = p.days === list.length && list.length > 1;
    return `<button type="button" class="postcard${best ? ' best' : ''}" data-days="${p.days}" aria-pressed="${p.days === state.days}"
        data-testid="price-card-${p.days}" data-agent-id="price-card-${p.days}" aria-label="${label} for ${price} before GST">
      ${best ? '<span class="pc-ribbon">Best value</span>' : ''}
      <span class="pc-days">${label}</span>
      <strong class="pc-price">${price}</strong>
      <span class="pc-sub">+ GST · ${formatPrice({ aud: p.audCents / p.days, usd: p.usdCents / p.days })} a day</span>
      ${save.aud > 0 ? `<span class="pc-stamp">Save ${formatPrice(save)}</span>` : '<span class="pc-stamp plain">Daily rate</span>'}
    </button>`;
  }).join('');
}

/** The hire-length cards in the booking form: one choice, which stays selected and sets the booking's days. */
function renderDayCards() {
  $('bkDays').innerHTML = state.cfg.priceList.map((p) => {
    const label = `${p.days} day${p.days > 1 ? 's' : ''}`;
    const price = formatPrice({ aud: p.audCents, usd: p.usdCents });
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
  const offset = state.date ? dayDiff(state.date, date) : -1;
  if (offset >= 0 && offset < state.cfg.maxRentalDays && runOpen(state.date, offset + 1)) {
    const days = offset + 1;
    const back = addDays(state.date, days);
    if (!handoverOk(back)) return calNote(`That hire would be returned on ${formatDate(back)}, which has no returns. Try a shorter or longer hire.`);
    calNote('');
    if (days !== state.days) setDays(days);
    return;
  }
  startHire(date);
}

/** A new pickup day keeps a length already chosen on the cards if it works there; otherwise the shortest hire that does. */
function startHire(date) {
  const refuse = (text) => {
    calNote(text);
    $('bkDate').value = state.date || '';
  };
  if (!handoverOk(date)) return refuse(`Pickups aren't available on ${formatDate(date)}. Striped days have no pickups or returns.`);
  const lengths = validLengths(date);
  if (!lengths.length) return refuse(`There's no return day within ${state.cfg.maxRentalDays} days of ${formatDate(date)}. Please choose another pickup day.`);
  const keep = !state.date && lengths.includes(state.days);
  const days = keep ? state.days : lengths[0];
  calNote(days > 1 && !keep ? `The shortest hire from ${formatDate(date)} is ${days} days, returned ${formatDate(addDays(date, days))}.` : '');
  if (days !== state.days) setDays(days);
  selectDate(date);
}

/** A hire length chosen on a card, if it works from the chosen pickup day. */
function chooseDays(days) {
  if (state.date && !lengthOk(state.date, days)) {
    return calNote(`A ${days}-day hire from ${formatDate(state.date)} isn't available: it would be returned on ${formatDate(addDays(state.date, days))}, which has no returns.`);
  }
  calNote('');
  return setDays(days);
}

async function setDays(days) {
  state.days = days;
  $('pxCards').querySelectorAll('[data-days]').forEach((card) => card.setAttribute('aria-pressed', String(Number(card.dataset.days) === days)));
  markDayCards();
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
  $('bkDate').value = date;
  const [y, m] = date.split('-').map(Number);
  const monthChanged = state.month.y !== y || state.month.m !== m - 1;
  state.month = { y, m: m - 1 };
  const after = monthChanged ? loadBusy() : Promise.resolve();
  after.then(() => {
    renderCalendar();
    markDayCards();
    renderTimes();
  });
}

async function submitBooking(e) {
  e.preventDefault();
  const errEl = $('bkError');
  showError(errEl, null);
  if (!state.date || !state.time) return showError(errEl, new Error('Please choose an available date and pickup time.'));

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

    $('hubFx').textContent = `US$1 = A$${formatRate(hub.fx.rate)}`;
    $('hubFxSource').textContent = hub.fx.mode === 'live'
      ? `Market rate from ${hub.fx.source}${hub.fx.date ? `, ${hub.fx.date}` : ''}.`
      : hub.fx.source;

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
