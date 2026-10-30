import {
  api, getMe, getConfig, isStaff, formatAud, formatTokens, formatRate, formatDateTime, toast, showError, setBusy,
  escapeHtml, ApiError,
} from './common.js';

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
};

/* ---------- Brisbane date helpers (always UTC+10) ---------- */

const brisbaneMs = (date, time = '00:00') => Date.parse(`${date}T${time}:00+10:00`);
const isoDate = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const hourLabel = (h) => new Date(Date.UTC(2000, 0, 1, h)).toLocaleTimeString('en-AU', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' });

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
    const selected = date === state.date ? ' selected' : '';
    const today = date === state.cfg.today ? ' today' : '';
    cells.push(`<button type="button" role="gridcell" class="cal-day ${status}${selected}${today}" data-date="${date}"
      ${selectable ? '' : 'disabled'} aria-label="${date} ${status}" aria-pressed="${Boolean(selected)}">${d}</button>`);
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
  $('qSubtotal').textContent = formatAud(q.subtotalCents);
  $('qGst').textContent = formatAud(q.gstCents);
  $('qTotal').textContent = formatAud(q.totalCents);
  $('qTokens').textContent = `${formatTokens(q.tokenCents)} tokens`;
  $('qRate').textContent = `Converted at US$1.00 = A$${formatRate(q.fxRate)}. 1 token = US$1.00.`;
}

function renderPricing() {
  const { cfg } = state;
  const q = cfg.dailyQuote;
  const rate = formatRate(cfg.fx.rate);
  $('heroPrice').innerHTML = `<span class="price-main">${formatAud(q.subtotalCents)}</span><span class="price-sub">+ GST per 24 hours &middot; ${formatTokens(q.tokenCents)} tokens</span>`;
  $('pxAud').textContent = formatAud(q.totalCents);
  $('pxTokens').textContent = formatTokens(q.tokenCents);
  $('pxRate').textContent = `today US$1 = A$${rate}`;
}

function renderDaysSelect() {
  const sel = $('bkDays');
  const opts = [];
  for (let d = 1; d <= state.cfg.maxRentalDays; d++) opts.push(`<option value="${d}">${d} × 24 hours</option>`);
  sel.innerHTML = opts.join('');
  sel.value = String(state.days);
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
  setBusy(btn, true, 'Booking…');
  try {
    const { booking } = await api('/bookings', {
      method: 'POST',
      body: { date: state.date, time: state.time, days: state.days, acceptDisclaimer: true, note: $('bkNote').value },
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

const WEATHER_ICON = (code) => (code === 0 ? '☀️' : code <= 2 ? '⛅' : code === 3 ? '☁️' : code <= 48 ? '🌫️' : code <= 67 ? '🌧️' : code <= 82 ? '🌦️' : '⛈️');

function startClock() {
  const clock = $('hubClock');
  const dateEl = $('hubDate');
  const tick = () => {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane', hour: 'numeric', minute: '2-digit', second: '2-digit' });
    dateEl.textContent = now.toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
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

    $('hubFx').textContent = `US$1.00 = A$${formatRate(hub.fx.rate)}`;
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
        <span class="wx-icon" aria-hidden="true">${WEATHER_ICON(day.code)}</span>
        <span>${Math.round(day.min)}°–${Math.round(day.max)}°</span>
        <span class="wx-rain">${day.rainChance ?? 0}% rain</span></li>`).join('');
    const today = w.daily[0];
    const t = (iso) => new Date(`${iso}:00+10:00`).toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane', hour: 'numeric', minute: '2-digit' });
    $('hubWeather').innerHTML = `
      <div class="wx-now">
        <span class="wx-big" aria-hidden="true">${WEATHER_ICON(c.code)}</span>
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
        : `You're about ${r.distanceKm} km away. Registration is open to people within ${r.radiusKm} km of the depot.`;
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
  renderPricing();

  const [ty, tm] = cfg.today.split('-').map(Number);
  state.month = { y: ty, m: tm - 1 };
  $('bkDate').min = cfg.today;
  $('bkDate').max = addDays(cfg.today, cfg.maxAdvanceDays);

  const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
  if (pending?.days) state.days = Math.min(Number(pending.days), cfg.maxRentalDays);
  renderDaysSelect();

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
    if (btn && !btn.disabled) selectDate(btn.dataset.date);
  });
  $('bkDate').addEventListener('change', (e) => e.target.value && selectDate(e.target.value));
  $('bkTime').addEventListener('change', (e) => { state.time = e.target.value; renderReturn(); });
  $('bkDays').addEventListener('change', async (e) => {
    state.days = Number(e.target.value);
    renderTimes();
    await loadQuote();
    renderAuthPanel();
  });
  $('bookingForm').addEventListener('submit', submitBooking);
}

document.addEventListener('DOMContentLoaded', init);
