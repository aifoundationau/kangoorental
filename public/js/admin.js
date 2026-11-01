import {
  api, getMe, formatAud, formatUsd, formatTokens, formatRate, formatDate, formatDateTime, formatStamp, toast, showError,
  escapeHtml,
} from './common.js';

const $ = (id) => document.getElementById(id);
let me = null;
let superadmin = false;
let currentThread = null;
let inboxTimer = null;

const STATUS_LABEL = { confirmed: 'Confirmed', active: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
const LICENCE_LABEL = { verified: 'Verified', pending: 'Needs review', rejected: 'Rejected', unverified: 'Not checked' };
const LICENCE_CLASS = { verified: 'ok', pending: 'wait', rejected: 'bad', unverified: 'bad' };

/* ---------- Tabs ---------- */

const loaders = {
  dashboard: loadDashboard,
  bookings: loadBookings,
  customers: () => loadCustomers(),
  messages: loadThreads,
  handover: loadHandover,
  pricing: loadPricing,
  settings: loadSettings,
  staff: loadStaff,
  audit: loadAudit,
};

function showTab(name) {
  if (name === 'calendar') name = 'handover';
  if (!loaders[name]) name = 'dashboard';
  document.querySelectorAll('[role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  history.replaceState(null, '', `#${name}`);
  clearInterval(inboxTimer);
  if (name === 'messages') inboxTimer = setInterval(() => { loadThreads(); if (currentThread) openThread(currentThread, true); }, 15000);
  loaders[name]().catch((err) => toast(err.message, 'error'));
}

/* ---------- Dashboard ---------- */

async function loadDashboard() {
  const [s, { bookings }] = await Promise.all([api('/admin/stats'), api('/admin/bookings?status=confirmed')]);
  const tile = (label, value, tab) => `<button class="stat" data-goto="${tab}"><span>${label}</span><strong>${value}</strong></button>`;
  $('stats').innerHTML = [
    tile('Upcoming bookings', s.upcomingBookings, 'bookings'),
    tile('Van out now', s.activeBookings, 'bookings'),
    tile('Licences to review', s.pendingLicences, 'customers'),
    tile('Unread messages', s.unreadMessages, 'messages'),
    tile('Customers', s.customers, 'customers'),
    tile('Token sales (30 days)', formatAud(s.revenueAudCents30d ?? s.revenueUsdCents30d), 'audit'),
    tile('Tokens held by customers', formatTokens(s.tokenCentsOutstanding), 'customers'),
  ].join('');
  const upcoming = bookings.filter((b) => b.startAt > Date.now()).sort((a, b) => a.startAt - b.startAt).slice(0, 8);
  $('upcoming').innerHTML = upcoming.length ? bookingTable(upcoming) : '<p class="hint">No upcoming pickups.</p>';
  const unread = $('tabUnread');
  unread.hidden = !s.unreadMessages;
  unread.textContent = s.unreadMessages || '';
}

/* ---------- Bookings ---------- */

function bookingActions(b) {
  const out = [];
  if (b.status === 'confirmed') {
    out.push(`<button class="btn btn-small" data-status="active" data-id="${b.id}">Picked up</button>`);
    out.push(`<button class="btn btn-small btn-ghost" data-status="cancelled" data-id="${b.id}">Cancel</button>`);
  }
  if (b.status === 'active') out.push(`<button class="btn btn-small" data-status="completed" data-id="${b.id}">Returned</button>`);
  return out.join(' ');
}

function bookingTable(rows) {
  return `<table class="table">
    <thead><tr><th>Ref</th><th>Customer</th><th>Pickup</th><th>Return</th><th class="num">Total</th><th class="num">Tokens</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows.map((b) => `<tr>
      <td><strong>${escapeHtml(b.ref)}</strong>${b.customerNote ? `<br><small class="hint" title="Customer note">“${escapeHtml(b.customerNote)}”</small>` : ''}</td>
      <td><a href="#customers" data-customer="${b.userId}">${escapeHtml(b.userName)}</a><br><small>${escapeHtml(b.userPhone || '')}</small></td>
      <td>${formatDateTime(b.startAt)}</td>
      <td>${formatDateTime(b.endAt)}</td>
      <td class="num">${formatAud(b.totalCents)}</td>
      <td class="num">${formatTokens(b.tokenCents)}${b.refundedTokenCents ? `<br><small>${formatTokens(b.refundedTokenCents)} refunded</small>` : ''}</td>
      <td><span class="status-pill ${b.status === 'cancelled' ? 'bad' : 'ok'}">${STATUS_LABEL[b.status]}</span></td>
      <td class="actions">${bookingActions(b)}</td></tr>`).join('')}</tbody></table>`;
}

async function loadBookings() {
  const { bookings } = await api(`/admin/bookings?status=${$('bkFilter').value}`);
  $('bookingTable').innerHTML = bookings.length ? bookingTable(bookings) : '<p class="hint">No bookings.</p>';
}

async function changeBookingStatus(id, status) {
  const body = { status };
  if (status === 'cancelled') {
    if (!confirm('Cancel this booking?')) return;
    body.refund = confirm('Refund the tokens to the customer? (OK = refund, Cancel = no refund)');
    body.note = prompt('Reason (optional, shown to staff only):') || '';
  }
  await api(`/admin/bookings/${id}/status`, { method: 'POST', body });
  toast('Booking updated.', 'success');
  const active = document.querySelector('[role="tab"][aria-selected="true"]').dataset.tab;
  loaders[active]();
}

/* ---------- Customers ---------- */

async function loadCustomers(q = $('custQ').value) {
  const { users } = await api(`/admin/users?q=${encodeURIComponent(q)}`);
  $('custTable').innerHTML = users.length ? `<table class="table">
    <thead><tr><th>Name</th><th>Contact</th><th>Licence</th><th class="num">Tokens</th><th>Joined</th></tr></thead>
    <tbody>${users.map((u) => `<tr class="clickable${u.disabled ? ' muted' : ''}" data-customer="${u.id}">
      <td><strong>${escapeHtml(u.fullName)}</strong>${u.disabled ? ' <small>(disabled)</small>' : ''}</td>
      <td>${escapeHtml(u.email)}<br><small>${escapeHtml(u.phone || '')}</small></td>
      <td><span class="status-pill ${LICENCE_CLASS[u.licenceStatus]}">${LICENCE_LABEL[u.licenceStatus]}</span></td>
      <td class="num">${formatTokens(u.tokenCents)}</td>
      <td>${formatStamp(u.createdAt)}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">No customers found.</p>';
}

async function openCustomer(id) {
  const { user: u, bookings, transactions } = await api(`/admin/users/${id}`);
  const panel = $('custDetail');
  panel.hidden = false;
  panel.dataset.id = u.id;
  panel.innerHTML = `
    <button class="icon-btn close" type="button" data-close aria-label="Close">×</button>
    <h3>${escapeHtml(u.fullName)}</h3>
    <dl class="details">
      <div><dt>Email</dt><dd>${escapeHtml(u.email)}</dd></div>
      <div><dt>Mobile</dt><dd>${escapeHtml(u.phone || '–')}</dd></div>
      <div><dt>Date of birth</dt><dd>${escapeHtml(u.dob || '–')}</dd></div>
      <div><dt>Address</dt><dd>${escapeHtml([u.addressLine, u.suburb, u.state, u.postcode].filter(Boolean).join(', '))}</dd></div>
      <div><dt>Registered from</dt><dd>${u.regDistanceKm ?? '–'} km from depot</dd></div>
      <div><dt>Tokens</dt><dd>${formatTokens(u.tokenCents)}</dd></div>
    </dl>
    <h4>Licence <span class="status-pill ${LICENCE_CLASS[u.licenceStatus]}">${LICENCE_LABEL[u.licenceStatus]}</span></h4>
    <dl class="details">
      <div><dt>Number</dt><dd>${escapeHtml(u.licenceNumber || '–')} (${escapeHtml(u.licenceState || '')})</dd></div>
      <div><dt>Expiry</dt><dd>${escapeHtml(u.licenceExpiry || '–')}</dd></div>
      <div><dt>Class</dt><dd>${escapeHtml(u.licenceClass || '–')}</dd></div>
      <div><dt>Checked</dt><dd>${u.licenceMethod === 'ai' ? 'Automatically' : u.licenceMethod === 'manual' ? 'By staff' : '–'} ${formatStamp(u.licenceCheckedAt)}</dd></div>
    </dl>
    ${u.licenceNotes ? `<p class="hint">${escapeHtml(u.licenceNotes)}</p>` : ''}
    <p class="hint">The licence photo is never stored. To verify manually, sight the physical licence (for example at pickup or by video call) and check it matches the details above.</p>
    <div class="btn-row">
      <button class="btn btn-small" data-licence="verified">Mark verified</button>
      <button class="btn btn-small btn-ghost" data-licence="rejected">Reject</button>
    </div>
    <h4>Insurance</h4>
    <p>${u.insurer ? `${escapeHtml(u.insurer)} &middot; policy ${escapeHtml(u.policyNumber)} &middot; expires ${escapeHtml(u.policyExpiry)}<br>
      $2M indemnity ${u.indemnityConfirmed ? 'confirmed by customer' : '<strong>not confirmed</strong>'}` : '<span class="hint">Not provided</span>'}</p>
    <h4>Adjust tokens</h4>
    <form class="inline-form" data-tokens-form>
      <label class="sr-only" for="adjTokens">Tokens</label>
      <input id="adjTokens" type="number" step="1" placeholder="e.g. 10 or -5" required>
      <label class="sr-only" for="adjNote">Reason</label>
      <input id="adjNote" placeholder="Reason" required minlength="3">
      <button class="btn btn-small" type="submit">Apply</button>
    </form>
    <div class="btn-row">
      <button class="btn btn-small btn-ghost" data-message="${u.id}">Message customer</button>
      <button class="btn btn-small ${u.disabled ? '' : 'btn-danger'}" data-disable="${u.disabled ? 'false' : 'true'}">${u.disabled ? 'Re-enable account' : 'Disable account'}</button>
    </div>
    <h4>Bookings</h4>
    ${bookings.length ? `<ul class="mini-list">${bookings.map((b) => `<li><strong>${escapeHtml(b.ref)}</strong> ${formatDateTime(b.startAt)} &middot; ${b.days}d &middot; ${STATUS_LABEL[b.status]}</li>`).join('')}</ul>` : '<p class="hint">None.</p>'}
    <h4>Token history</h4>
    ${transactions.length ? `<ul class="mini-list">${transactions.slice(0, 15).map((t) => `<li>${formatStamp(t.createdAt)} &middot; ${t.kind} &middot; <strong>${t.deltaCents > 0 ? '+' : ''}${formatTokens(t.deltaCents)}</strong> ${escapeHtml(t.note || '')}</li>`).join('')}</ul>` : '<p class="hint">None.</p>'}`;
}

/* ---------- Messages ---------- */

async function loadThreads() {
  const { threads } = await api('/admin/threads');
  $('threads').innerHTML = threads.length ? threads.map((t) => `
    <li><button class="thread${t.id === currentThread ? ' active' : ''}" data-thread="${t.id}">
      <strong>${escapeHtml(t.fullName)}</strong>${t.unreadForAdmin ? ` <span class="badge">${t.unreadForAdmin}</span>` : ''}
      <span class="thread-preview">${t.lastSender === 'admin' ? 'You: ' : ''}${escapeHtml(t.lastBody)}</span>
      <time>${formatStamp(t.lastAt)}</time></button></li>`).join('') : '<li class="hint">No conversations yet.</li>';
  const unread = threads.reduce((n, t) => n + (t.unreadForAdmin || 0), 0);
  $('tabUnread').hidden = !unread;
  $('tabUnread').textContent = unread || '';
  getMe(true); // keeps the header badge in step with the inbox
}

async function openThread(userId, quiet = false) {
  currentThread = userId;
  const { user, messages } = await api(`/admin/threads/${userId}`);
  $('threadTitle').textContent = `${user.fullName} · ${user.email}`;
  const chat = $('adminChat');
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
  chat.innerHTML = messages.length ? messages.map((m) => `
    <div class="bubble ${m.sender === 'admin' ? 'mine' : 'theirs'}">
      <p>${escapeHtml(m.body)}</p><time>${formatStamp(m.createdAt)}</time></div>`).join('')
    : '<p class="hint">No messages yet. Start the conversation below.</p>';
  if (!quiet || atBottom) chat.scrollTop = chat.scrollHeight;
  $('adminChatForm').hidden = false;
  if (!quiet) loadThreads();
}

/* ---------- Pickup and return days ---------- */

const WEEKDAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
let ho = null; // { weekdays: Set, overrides: Map(date -> open), today }
let hoMonth = null; // { y, m } (m: 0-11)
let hoTimer = null;
let hoSeq = 0; // the latest change; an older save's response doesn't overwrite newer clicks

const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const usuallyOpen = (date) => ho.weekdays.has(weekdayOf(date));
const hoOpen = (date) => (ho.overrides.has(date) ? ho.overrides.get(date) : usuallyOpen(date));

function applyHandover(view) {
  ho = { weekdays: new Set(view.weekdays), overrides: new Map(Object.entries(view.overrides)), today: view.today };
  renderHandoverConflicts(view.conflicts);
}

async function loadHandover() {
  applyHandover(await api('/admin/handover'));
  if (!hoMonth) {
    const [y, m] = ho.today.split('-').map(Number);
    hoMonth = { y, m: m - 1 };
  }
  $('hoReadonly').hidden = superadmin;
  renderHandover();
}

function renderHandover() {
  $('hoWeekdays').innerHTML = WEEKDAYS.map(([d, label]) => `<button type="button" class="day-toggle" data-weekday="${d}"
    aria-pressed="${ho.weekdays.has(d)}" ${superadmin ? '' : 'disabled'} data-testid="ho-weekday-${d}" data-agent-id="ho-weekday-${d}">${label}</button>`).join('');

  const { y, m } = hoMonth;
  $('hoTitle').textContent = new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-AU', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  const firstDow = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7; // Monday first
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="cal-dow" role="columnheader">${d}</div>`);
  for (let i = 0; i < firstDow; i++) cells.push('<div class="cal-empty"></div>');
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const past = date < ho.today;
    const open = hoOpen(date);
    const changed = ho.overrides.has(date);
    const state = open ? 'pickups and returns' : 'not available';
    cells.push(`<button type="button" role="gridcell" class="cal-day ${past ? 'past' : open ? 'available' : 'closed'}${changed ? ' changed' : ''}"
      data-date="${date}" aria-pressed="${open}" ${past || !superadmin ? 'disabled' : ''} data-testid="ho-${date}" data-agent-id="ho-${date}"
      aria-label="${date}: ${state}${changed ? ', changed from your usual week' : ''}">${d}</button>`);
  }
  $('hoCalendar').innerHTML = cells.join('');
  const [ty, tm] = ho.today.split('-').map(Number);
  $('hoPrev').disabled = y === ty && m === tm - 1;
}

function renderHandoverConflicts(conflicts) {
  const day = (date, ok) => `${formatDate(date)}${ok ? '' : ' <strong>(not available)</strong>'}`;
  $('hoConflicts').innerHTML = conflicts.length ? `<div class="notice" role="alert">
    <p><strong>Check these bookings.</strong> They pick up or return on a day that isn't available any more. Contact the customer,
      or make the day available again.</p>
    <ul>${conflicts.map((b) => `<li>${escapeHtml(b.ref)} · ${escapeHtml(b.name || '')} · pickup ${day(b.pickup, b.pickupOk)}
      · return ${day(b.dropoff, b.dropoffOk)}</li>`).join('')}</ul></div>` : '';
}

/** Saves shortly after the last click, so several quick clicks become one save. */
function saveHandoverSoon() {
  const seq = ++hoSeq;
  $('hoStatus').textContent = 'Saving…';
  clearTimeout(hoTimer);
  hoTimer = setTimeout(async () => {
    try {
      const view = await api('/admin/handover', {
        method: 'PUT',
        body: { weekdays: [...ho.weekdays], overrides: Object.fromEntries(ho.overrides) },
      });
      if (seq !== hoSeq) return;
      applyHandover(view);
      renderHandover();
      $('hoStatus').textContent = 'Saved. Customers see the change straight away.';
    } catch (err) {
      $('hoStatus').textContent = '';
      toast(err.message, 'error');
      loadHandover();
    }
  }, 500);
}

function bindHandover() {
  $('hoWeekdays').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-weekday]');
    if (!btn || btn.disabled) return;
    const d = Number(btn.dataset.weekday);
    if (ho.weekdays.has(d)) ho.weekdays.delete(d);
    else ho.weekdays.add(d);
    // Date changes that now match the usual week aren't changes any more.
    for (const [date, open] of ho.overrides) if (weekdayOf(date) === d && open === usuallyOpen(date)) ho.overrides.delete(date);
    renderHandover();
    saveHandoverSoon();
  });
  $('hoCalendar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-date]');
    if (!btn || btn.disabled) return;
    const date = btn.dataset.date;
    const open = !hoOpen(date);
    if (open === usuallyOpen(date)) ho.overrides.delete(date);
    else ho.overrides.set(date, open);
    renderHandover();
    saveHandoverSoon();
  });
  const changeMonth = (delta) => {
    const t = new Date(Date.UTC(hoMonth.y, hoMonth.m + delta, 1));
    hoMonth = { y: t.getUTCFullYear(), m: t.getUTCMonth() };
    renderHandover();
  };
  $('hoPrev').addEventListener('click', () => changeMonth(-1));
  $('hoNext').addEventListener('click', () => changeMonth(1));
}

/* ---------- Pricing & currency ---------- */

let pricingState = null;
let previewTimer = null;

function pricingFormValues() {
  const form = $('pricingForm');
  const prices = [...document.querySelectorAll('#pList input[data-role="aud"]')].map((el) => el.value);
  const tokens = [...document.querySelectorAll('#pList input[data-role="tokens"]')].map((el) => el.value);
  const discounts = [...document.querySelectorAll('#pList input[data-role="discount"]')].map((el) => el.value || '0');
  return {
    price_basis: 'aud',
    token_price_aud: Math.max(1, Math.round(Number($('pTokenPriceAud')?.value || 1))),
    token_share_fee: Math.max(0, Math.round(Number($('pShareFee')?.value || 1))),
    price_table: prices.join(','),
    token_table: tokens.join(','),
    discount_table: discounts.join(','),
    daily_rate_token_cents: Math.round(Number(tokens[0] || 99) * 100),
    gst_rate_bp: Math.round(Number($('pGst').value) * 100),
    fx_mode: form.fx_mode.value,
    fx_manual_rate: $('pManual').value,
    token_packs: $('pPacks').value,
  };
}

function recalculateTierFromDiscount(dayNum) {
  if (dayNum <= 1) return;
  const day1Aud = Math.max(1, Math.round(Number(document.querySelector('#pList input[data-role="aud"]')?.value || 90)));
  const discInput = document.querySelector(`#pList input[data-role="discount"][data-day="${dayNum}"]`);
  const audInput = document.querySelector(`#pList #pList${dayNum}`);
  const tokInput = document.querySelector(`#pList #pTokList${dayNum}`);
  if (!discInput || !audInput || !tokInput) return;

  const discPct = Math.max(0, Math.min(99, Number(discInput.value) || 0));
  const fullAud = day1Aud * dayNum;
  const audExGst = Math.max(1, Math.ceil(fullAud * (1 - discPct / 100) - 1e-9));
  audInput.value = audExGst;

  const gstPct = Number($('pGst')?.value) || 10;
  const tokenPriceAud = Math.max(1, Number($('pTokenPriceAud')?.value) || 1);
  const totalAud = audExGst + Math.ceil((audExGst * gstPct) / 100 - 1e-9);
  tokInput.value = Math.ceil(totalAud / tokenPriceAud - 1e-9);
}

function recalculateAllDiscountedTiers() {
  document.querySelectorAll('#pList input[data-role="discount"][data-day]').forEach((el) => {
    recalculateTierFromDiscount(Number(el.dataset.day));
  });
}

function renderCalc({ fx, dailyQuote: q, list }) {
  // Each price-list line shows what a customer pays for that hire length.
  list.forEach((lq, i) => {
    const out = document.getElementById(`pListOut${i + 1}`);
    if (out) out.textContent = `+ ${formatAud(lq.gstCents)} GST = ${formatAud(lq.totalCents)} inc GST (${formatUsd(lq.usdTotalCents)} intl)`;
  });
  const rate = formatRate(fx.rate);
  const gstPct = (q.gstRateBp / 100).toString();
  const steps = [
    `1-day hire price: <strong>${formatAud(q.subtotalCents)}</strong> ex GST + <strong>${formatAud(q.gstCents)}</strong> (${gstPct}% GST) = <strong>${formatAud(q.totalCents)}</strong> inc GST.`,
    `Tokens charged for 1-day hire: <strong>${formatTokens(q.tokenCents)} tokens</strong> (customizable per product/service tier; default 1 token = AUD$${$('pTokenPriceAud')?.value || 1}).`,
    `Visitors in Australia &amp; New Zealand see: <strong>${formatAud(q.totalCents)}</strong> inc GST (${formatTokens(q.tokenCents)} tokens).`,
    `Visitors in all other nations see currency conversion <strong>AUD$1 = US$${rate}</strong> (${formatAud(q.totalCents)} &rarr; <strong>${formatUsd(q.usdTotalCents)}</strong>). All invoices are in Australian dollars (AUD$).`,
  ];
  $('calcSteps').innerHTML = steps.map((s) => `<li>${s}</li>`).join('');
  $('hdrFx').textContent = `AUD$1 = US$${rate}`;
}

function renderPricing(view) {
  pricingState = view;
  const s = view.settings;
  const form = $('pricingForm');
  form.fx_mode.value = s.fx_mode;
  const prices = String(s.price_table || '').split(',').map((n) => Number(n.trim()));
  const gstBp = Number(s.gst_rate_bp) || 1000;
  const rawTokens = String(s.token_table || '').split(',').map((n) => Number(n.trim()));
  const rawDiscounts = String(s.discount_table || '0,5,5,5,5,5,5').split(',').map((n) => Number(n.trim()));

  $('pList').innerHTML = prices.map((price, i) => {
    const day = i + 1;
    const defaultTok = price + Math.ceil((price * gstBp) / 10000 - 1e-9);
    const tokVal = Number.isInteger(rawTokens[i]) && rawTokens[i] >= 1 ? rawTokens[i] : defaultTok;
    const discVal = Number.isFinite(rawDiscounts[i]) ? rawDiscounts[i] : (day === 1 ? 0 : 5);
    const discountCell = day === 1
      ? `<span class="price-input discount-input"><input data-role="discount" data-day="1" type="number" value="0" readonly title="Day 1 base rate"><span aria-hidden="true">% off</span></span>`
      : `<span class="price-input discount-input"><input id="pDisc${day}" data-role="discount" data-day="${day}" type="number" min="0" max="99" step="0.5" value="${discVal}"
          data-testid="discount-list-${day}" data-agent-id="discount-list-${day}" aria-label="Discount percentage for ${day} days hire"><span aria-hidden="true">% off</span></span>`;

    return `
    <div class="price-list-row" data-tier="${day}">
      <label for="pList${day}">${day} day${i ? 's' : ''}</label>
      ${discountCell}
      <span class="price-input"><span aria-hidden="true">AUD$</span><input id="pList${day}" data-role="aud" data-day="${day}" type="number" min="1" step="1" required value="${price}"
        data-testid="price-list-${day}" data-agent-id="price-list-${day}" aria-label="Price for ${day} day${i ? 's' : ''}, whole AUD before GST"></span>
      <span class="price-input token-input"><span aria-hidden="true">Tokens:</span><input id="pTokList${day}" data-role="tokens" data-day="${day}" type="number" min="1" step="1" required value="${tokVal}"
        data-testid="token-list-${day}" data-agent-id="token-list-${day}" aria-label="Tokens for ${day} day${i ? 's' : ''} hire"></span>
      <output id="pListOut${day}" class="hint"></output>
    </div>`;
  }).join('');
  if ($('pTokenPriceAud')) $('pTokenPriceAud').value = Number(s.token_price_aud) || 1;
  if ($('pShareFee')) $('pShareFee').value = Number(s.token_share_fee ?? 1);
  $('pGst').value = Number(s.gst_rate_bp) / 100;
  const manualNum = Number(s.fx_manual_rate) || 0.7;
  $('pManual').value = (manualNum > 1.05 ? 1 / manualNum : manualNum).toFixed(4);
  $('pPacks').value = s.token_packs;
  $('liveRate').textContent = s.fx_live_rate ? `AUD$1 = US$${formatRate(s.fx_live_rate)}` : 'Not loaded yet';
  $('liveRateInfo').textContent = s.fx_live_rate
    ? `${s.fx_live_source}${s.fx_live_date ? `, rate date ${s.fx_live_date}` : ''}. Checked ${formatStamp(s.fx_live_checked_at)}.`
    : 'The live rate loads automatically when the server starts.';
  renderCalc(view);
}

function toggleBasisFields() {}

async function loadPricing() {
  renderPricing(await api('/admin/settings'));
  const form = $('pricingForm');
  form.querySelectorAll('input').forEach((el) => { el.disabled = !superadmin; });
  $('fxRefresh').disabled = !superadmin;
  $('pricingReadonly').hidden = superadmin;
}

function schedulePreview() {
  toggleBasisFields();
  if (!superadmin) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      const view = await api('/admin/pricing/preview', { method: 'POST', body: { settings: pricingFormValues() } });
      showError($('pricingError'), null);
      renderCalc(view);
    } catch (err) {
      showError($('pricingError'), err);
    }
  }, 300);
}

/* ---------- Settings ---------- */

async function loadSettings() {
  const { settings } = await api('/admin/settings');
  document.querySelectorAll('#settingsForm [data-key]').forEach((el) => {
    const v = settings[el.dataset.key];
    el.value = el.hasAttribute('data-cents') ? Number(v) / 100 : v;
  });
}

/* ---------- Staff ---------- */

async function loadStaff() {
  const { staff } = await api('/admin/staff');
  $('staffList').innerHTML = `<table class="table">
    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
    <tbody>${staff.map((s) => `<tr class="${s.disabled ? 'muted' : ''}"><td>${escapeHtml(s.fullName)}</td><td>${escapeHtml(s.email)}</td>
      <td>${s.role === 'superadmin' ? 'Superadmin' : 'Admin'}</td><td>${s.disabled ? 'Disabled' : 'Active'}</td>
      <td>${s.id === me.id ? '<span class="hint">You</span>' : `<button class="btn btn-small btn-ghost" data-staff="${s.id}" data-disable="${!s.disabled}">${s.disabled ? 'Enable' : 'Disable'}</button>`}</td></tr>`).join('')}
    </tbody></table>`;
}

/* ---------- Audit ---------- */

async function loadAudit() {
  const { entries } = await api('/admin/audit');
  $('auditTable').innerHTML = `<table class="table">
    <thead><tr><th>When</th><th>Event</th><th>User</th><th>Detail</th><th>IP</th></tr></thead>
    <tbody>${entries.map((e) => `<tr><td>${formatStamp(e.createdAt)}</td><td>${escapeHtml(e.action)}</td>
      <td><small>${escapeHtml(e.userId || '')}</small></td><td>${escapeHtml(e.detail || '')}</td><td><small>${escapeHtml(e.ip || '')}</small></td></tr>`).join('')}
    </tbody></table>`;
}

/* ---------- Events ---------- */

function bindEvents() {
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) showTab(tab.dataset.tab);
  });

  document.addEventListener('click', async (e) => {
    const t = e.target;
    try {
      const goto = t.closest('[data-goto]');
      if (goto) return showTab(goto.dataset.goto);

      const status = t.closest('[data-status]');
      if (status) return await changeBookingStatus(status.dataset.id, status.dataset.status);

      const customer = t.closest('[data-customer]');
      if (customer) {
        e.preventDefault();
        if (!document.querySelector('[data-panel="customers"]').hidden) return await openCustomer(customer.dataset.customer);
        showTab('customers');
        return await openCustomer(customer.dataset.customer);
      }

      if (t.closest('[data-close]')) { $('custDetail').hidden = true; return; }

      const lic = t.closest('[data-licence]');
      if (lic) {
        const id = $('custDetail').dataset.id;
        const notes = lic.dataset.licence === 'rejected' ? prompt('Reason shown to the customer:') ?? '' : '';
        await api(`/admin/users/${id}/licence`, { method: 'POST', body: { status: lic.dataset.licence, notes } });
        toast('Licence status updated.', 'success');
        await openCustomer(id);
        return loadCustomers();
      }

      const disable = t.closest('#custDetail [data-disable]');
      if (disable) {
        const id = $('custDetail').dataset.id;
        const disabled = disable.dataset.disable === 'true';
        if (disabled && !confirm('Disable this account? The customer will be logged out.')) return;
        await api(`/admin/users/${id}/disabled`, { method: 'POST', body: { disabled } });
        await openCustomer(id);
        return loadCustomers();
      }

      const msg = t.closest('[data-message]');
      if (msg) {
        showTab('messages');
        return await openThread(msg.dataset.message);
      }

      const thread = t.closest('[data-thread]');
      if (thread) return await openThread(thread.dataset.thread);

      const staff = t.closest('[data-staff]');
      if (staff) {
        await api(`/admin/staff/${staff.dataset.staff}/disabled`, { method: 'POST', body: { disabled: staff.dataset.disable === 'true' } });
        return loadStaff();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('custTable').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-customer]');
    if (row) openCustomer(row.dataset.customer).catch((err) => toast(err.message, 'error'));
  });

  $('custDetail').addEventListener('submit', async (e) => {
    if (!e.target.matches('[data-tokens-form]')) return;
    e.preventDefault();
    const id = $('custDetail').dataset.id;
    try {
      await api(`/admin/users/${id}/tokens`, { method: 'POST', body: { tokens: Number($('adjTokens').value), note: $('adjNote').value } });
      toast('Tokens adjusted.', 'success');
      await openCustomer(id);
      loadCustomers();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('bkFilter').addEventListener('change', () => loadBookings());
  $('custSearch').addEventListener('submit', (e) => { e.preventDefault(); loadCustomers(); });

  $('adminChatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('adminChatInput');
    try {
      await api(`/admin/threads/${currentThread}`, { method: 'POST', body: { body: input.value } });
      input.value = '';
      openThread(currentThread);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('adminChatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('adminChatForm').requestSubmit();
    }
  });

  $('pricingForm').addEventListener('input', (e) => {
    const role = e.target.dataset.role;
    if (role === 'discount') {
      const dayNum = Number(e.target.dataset.day);
      if (dayNum > 1) recalculateTierFromDiscount(dayNum);
    } else if (role === 'aud' && e.target.dataset.day === '1') {
      recalculateAllDiscountedTiers();
    } else if (e.target.id === 'pGst' || e.target.id === 'pTokenPriceAud') {
      recalculateAllDiscountedTiers();
    }
    schedulePreview();
  });
  $('pricingForm').addEventListener('change', schedulePreview);
  $('resetTokensBtn')?.addEventListener('click', () => {
    const gstPct = Number($('pGst').value) || 10;
    const tokenPriceAud = Math.max(1, Number($('pTokenPriceAud')?.value) || 1);
    document.querySelectorAll('#pList .price-list-row').forEach((row) => {
      const audInput = row.querySelector('input[data-role="aud"]');
      const tokInput = row.querySelector('input[data-role="tokens"]');
      if (audInput && tokInput) {
        const audEx = Number(audInput.value) || 0;
        const totalAud = audEx + Math.ceil((audEx * gstPct) / 100 - 1e-9);
        tokInput.value = Math.ceil(totalAud / tokenPriceAud - 1e-9);
      }
    });
    schedulePreview();
  });
  $('pricingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('pricingError'), null);
    try {
      renderPricing(await api('/admin/settings', { method: 'PUT', body: { settings: pricingFormValues() } }));
      toast('Pricing saved. New bookings use these prices straight away.', 'success');
    } catch (err) {
      showError($('pricingError'), err);
    }
  });
  $('fxRefresh').addEventListener('click', async () => {
    try {
      renderPricing(await api('/admin/fx/refresh', { method: 'POST' }));
      toast('Live exchange rate refreshed.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('settingsError'), null);
    const settings = {};
    document.querySelectorAll('#settingsForm [data-key]').forEach((el) => {
      settings[el.dataset.key] = el.hasAttribute('data-cents') ? Math.round(Number(el.value) * 100) : el.value;
    });
    try {
      await api('/admin/settings', { method: 'PUT', body: { settings } });
      toast('Settings saved.', 'success');
    } catch (err) {
      showError($('settingsError'), err);
    }
  });

  $('staffForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/admin/staff', {
        method: 'POST',
        body: { fullName: $('stName').value, email: $('stEmail').value, password: $('stPw').value, role: $('stRole').value },
      });
      e.target.reset();
      toast('Staff account created.', 'success');
      loadStaff();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  me = await getMe();
  if (!me) {
    window.location.href = '/login?next=/admin';
    return;
  }
  superadmin = me.role === 'superadmin';
  $('adminRole').textContent = superadmin ? 'Superadmin' : 'Admin';
  document.querySelectorAll('[data-super]').forEach((el) => { el.hidden = !superadmin; });
  bindEvents();
  bindHandover();
  api('/admin/settings').then((v) => { $('hdrFx').textContent = `AUD$1 = US$${formatRate(v.fx.rate)}`; }).catch(() => {});
  showTab(location.hash.slice(1) || 'dashboard');
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
});
