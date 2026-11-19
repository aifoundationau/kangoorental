import {
  api, getMe, formatAud, formatDate, formatDateTime, formatStamp, toast, showError,
  escapeHtml,
} from './common.js';

const $ = (id) => document.getElementById(id);
let me = null;
let superadmin = false;
let currentThread = null;
let inboxTimer = null;

const STATUS_LABEL = {
  pending_payment: 'Awaiting payment',
  confirmed: 'Confirmed',
  active: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
const LICENCE_LABEL = { verified: 'Verified', pending: 'Needs review', rejected: 'Rejected', unverified: 'Not checked' };
const LICENCE_CLASS = { verified: 'ok', pending: 'wait', rejected: 'bad', unverified: 'bad' };

/* ---------- Tabs ---------- */

const loaders = {
  messages: loadThreads,
  dashboard: loadDashboard,
  bookings: loadBookings,
  customers: () => loadCustomers(),
  handover: loadHandover,
  pricing: loadPricing,
  ledger: loadLedger,
  settings: loadSettings,
  staff: loadStaff,
  audit: loadAudit,
};

function showTab(name) {
  if (name === 'calendar') name = 'handover';
  if (!loaders[name]) name = 'messages';
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
    tile('Unread messages', s.unreadMessages, 'messages'),
    tile('Upcoming bookings', s.upcomingBookings, 'bookings'),
    tile('Van out now', s.activeBookings, 'bookings'),
    tile('Licences to review', s.pendingLicences, 'customers'),
    tile('Customers', s.customers, 'customers'),
    tile('Net revenue (30 days)', formatAud(s.revenueAudCents30d), 'audit'),
    tile('Distribution balance', s.settlement?.amountCents ? formatAud(s.settlement.amountCents) : 'Settled', 'ledger'),
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
    <thead><tr><th>Ref</th><th>Customer</th><th>Pickup</th><th>Return</th><th class="num">Total (AUD)</th><th>Payment</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows.map((b) => `<tr>
      <td><strong>${escapeHtml(b.ref)}</strong>${b.customerNote ? `<br><small class="hint" title="Customer note">“${escapeHtml(b.customerNote)}”</small>` : ''}</td>
      <td><a href="#customers" data-customer="${b.userId}">${escapeHtml(b.userName)}</a><br><small>${escapeHtml(b.userPhone || '')}</small></td>
      <td>${formatDateTime(b.startAt)}</td>
      <td>${formatDateTime(b.endAt)}</td>
      <td class="num">${formatAud(b.totalCents)}${b.refundedAudCents ? `<br><small>${formatAud(b.refundedAudCents)} refunded</small>` : ''}</td>
      <td><small>${escapeHtml(b.paymentProvider || 'demo')} &middot; ${escapeHtml(b.paymentStatus || 'paid')}</small></td>
      <td><span class="status-pill ${b.status === 'cancelled' ? 'bad' : b.status === 'pending_payment' ? 'wait' : 'ok'}">${STATUS_LABEL[b.status] || escapeHtml(b.status)}</span></td>
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
    body.refund = confirm('Refund the AUD payment to the customer? (OK = refund, Cancel = no refund)');
    body.note = prompt('Reason (optional, shown to staff only):') || '';
  }
  await api(`/admin/bookings/${id}/status`, { method: 'POST', body });
  toast('Booking updated.', 'success');
  const active = document.querySelector('[role="tab"][aria-selected="true"]').dataset.tab;
  loaders[active]();
}

/* ---------- Customers ---------- */

async function loadCustomers(q = $('custQ').value, status = $('custStatus')?.value || '') {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  const { users, total } = await api(`/admin/users${params.toString() ? `?${params}` : ''}`);
  const countEl = $('custCount');
  if (countEl) {
    const n = total ?? users.length;
    countEl.textContent = `Showing ${users.length}${n > users.length ? ` of ${n}` : ''} customer profile${n === 1 ? '' : 's'}`;
  }
  $('custTable').innerHTML = users.length ? `<table class="table">
    <thead><tr><th>Customer</th><th>Contact &amp; Suburb</th><th>Licence (Front &amp; Back)</th><th>Joined</th></tr></thead>
    <tbody>${users.map((u) => `<tr class="clickable${u.disabled ? ' muted' : ''}" data-customer="${u.id}" data-testid="cust-row-${u.id}">
      <td><strong>${escapeHtml(u.fullName)}</strong>${u.deletedAt ? ' <small>(deleted)</small>' : u.disabled ? ' <small>(disabled)</small>' : ''}<br><small class="hint">${u.googleLinked ? 'Google' : ''}${u.googleLinked && u.hasPassword ? ' · ' : ''}${u.hasPassword ? 'Password' : ''}</small></td>
      <td>${escapeHtml(u.email)}<br><small>${escapeHtml([u.phone, [u.suburb, u.state].filter(Boolean).join(' ')].filter(Boolean).join(' · '))}</small></td>
      <td><span class="status-pill ${LICENCE_CLASS[u.licenceStatus]}">${LICENCE_LABEL[u.licenceStatus]}</span><br><small>${escapeHtml([u.licenceNumber, u.licenceCardNumber ? `Card ${u.licenceCardNumber}` : '', u.licenceClass ? `Class ${u.licenceClass}` : ''].filter(Boolean).join(' · '))}</small></td>
      <td>${formatStamp(u.createdAt)}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">No customers found.</p>';
}

async function openCustomer(id) {
  const { user: u, bookings, payments } = await api(`/admin/users/${id}`);
  const ext = u.licenceExtracted || null;
  const panel = $('custDetail');
  panel.hidden = false;
  panel.dataset.id = u.id;
  const signInMethod = [u.googleLinked ? 'Google' : '', u.hasPassword ? 'Email & password' : ''].filter(Boolean).join(' + ') || '–';
  const sidesText = u.licenceFrontProvided && u.licenceBackProvided ? 'Front & back uploaded'
    : u.licenceFrontProvided ? 'Front only uploaded' : 'Not yet uploaded';
  const secFeatures = ext?.securityFeatures?.length ? ext.securityFeatures.map(escapeHtml).join(', ') : '–';
  const tamperText = ext
    ? (ext.tamperingSuspected
      ? `<strong class="neg">Flagged</strong>${ext.tamperingIndicators?.length ? `: ${ext.tamperingIndicators.map(escapeHtml).join(', ')}` : ''}`
      : 'None detected')
    : '–';
  panel.innerHTML = `
    <button class="icon-btn close" type="button" data-close aria-label="Close">×</button>
    <h3>${escapeHtml(u.fullName)}${u.deletedAt ? ' <small>(deleted)</small>' : ''}</h3>
    <dl class="details">
      <div><dt>Email</dt><dd>${escapeHtml(u.email)}</dd></div>
      <div><dt>Mobile</dt><dd>${escapeHtml(u.phone || '–')}</dd></div>
      <div><dt>Date of birth</dt><dd>${escapeHtml(u.dob || '–')}</dd></div>
      <div><dt>Residential address</dt><dd>${escapeHtml([u.addressLine, u.suburb, u.state, u.postcode].filter(Boolean).join(', ') || '–')}</dd></div>
      <div><dt>Sign-in method</dt><dd>${escapeHtml(signInMethod)}</dd></div>
      <div><dt>Registered from</dt><dd>${u.regDistanceKm ?? '–'} km from depot</dd></div>
      <div><dt>Joined</dt><dd>${formatStamp(u.createdAt) || '–'}</dd></div>
      ${u.acceptedTermsAt ? `<div><dt>Terms / AI consent</dt><dd>${formatStamp(u.acceptedTermsAt)}</dd></div>` : ''}
    </dl>
    <h4>Driver Licence (Front &amp; Back) <span class="status-pill ${LICENCE_CLASS[u.licenceStatus]}">${LICENCE_LABEL[u.licenceStatus]}</span></h4>
    ${(u.licenceBriefDescription || ext?.briefDescription) ? `<p class="notice">${escapeHtml(u.licenceBriefDescription || ext.briefDescription)}</p>` : ''}
    <dl class="details">
      <div><dt>Licence number</dt><dd>${escapeHtml(u.licenceNumber || '–')} (${escapeHtml(u.licenceState || '–')})</dd></div>
      <div><dt>Card number</dt><dd>${escapeHtml(u.licenceCardNumber || ext?.cardNumber || '–')}</dd></div>
      <div><dt>Licence type</dt><dd>${escapeHtml(u.licenceType || ext?.licenceType || '–')}</dd></div>
      <div><dt>Vehicle class</dt><dd>${escapeHtml(u.licenceClass || ext?.licenceClass || '–')}</dd></div>
      <div><dt>Issue date</dt><dd>${escapeHtml(u.licenceIssueDate || ext?.issueDate || '–')}</dd></div>
      <div><dt>Expiry date</dt><dd>${escapeHtml(u.licenceExpiry || ext?.expiryDate || '–')}</dd></div>
      <div><dt>Issuing authority</dt><dd>${escapeHtml(u.licenceAuthority || ext?.issuingAuthority || '–')}</dd></div>
      <div><dt>Conditions</dt><dd>${escapeHtml(u.licenceConditions || ext?.conditions || 'None noted')}${ext?.automaticOnly ? ' <strong class="neg">(Automatic only — manual restriction)</strong>' : ''}</dd></div>
      <div><dt>Address on front</dt><dd>${escapeHtml(u.licenceAddressFront || ext?.addressFront || '–')}</dd></div>
      <div><dt>Address on back</dt><dd>${escapeHtml(u.licenceAddressBack || ext?.addressBack || '–')}</dd></div>
      <div><dt>Uploads</dt><dd>${sidesText}</dd></div>
      <div><dt>Checked</dt><dd>${u.licenceMethod === 'ai' ? `Google Gemini AI${ext?.model ? ` (${escapeHtml(ext.model)})` : ''}` : u.licenceMethod === 'manual' ? 'By staff' : '–'} ${formatStamp(u.licenceCheckedAt)}</dd></div>
      ${ext ? `<div><dt>Back 2D barcode</dt><dd>${ext.hasBarcode ? 'Detected' : 'Not detected'}</dd></div>
      <div><dt>Security features</dt><dd>${secFeatures}</dd></div>
      <div><dt>Forensic check</dt><dd>${tamperText}</dd></div>` : ''}
    </dl>
    ${ext?.backTextSummary ? `<p class="hint"><strong>Back details:</strong> ${escapeHtml(ext.backTextSummary)}</p>` : ''}
    ${u.licenceNotes ? `<p class="hint"><strong>Verification status:</strong> ${escapeHtml(u.licenceNotes)}</p>` : ''}
    <p class="hint">Raw licence photos are processed in memory by Google Gemini AI and discarded immediately after extraction.</p>
    ${u.deletedAt ? '' : `<div class="btn-row">
      <button class="btn btn-small" data-licence="verified">Mark verified</button>
      <button class="btn btn-small btn-ghost" data-licence="rejected">Reject</button>
    </div>`}
    <h4>Insurance</h4>
    <p>${u.insurer ? `${escapeHtml(u.insurer)} &middot; policy ${escapeHtml(u.policyNumber)} &middot; expires ${escapeHtml(u.policyExpiry)}<br>
      $2M indemnity ${u.indemnityConfirmed ? 'confirmed by customer' : '<strong>not confirmed</strong>'}` : '<span class="hint">Not provided</span>'}</p>
    ${u.deletedAt
      ? `<p class="hint" data-testid="cust-deleted-notice">Account deleted ${formatStamp(u.deletedAt)}. Message history is archived for 7-year retention.</p>
         <div class="btn-row"><button class="btn btn-small btn-ghost" data-message="${u.id}">View archived messages</button></div>`
      : `<div class="btn-row">
      <button class="btn btn-small btn-ghost" data-message="${u.id}">Message customer</button>
      <button class="btn btn-small ${u.disabled ? '' : 'btn-danger'}" data-disable="${u.disabled ? 'false' : 'true'}">${u.disabled ? 'Re-enable account' : 'Disable account'}</button>
      ${superadmin ? `<button class="btn btn-small btn-danger" type="button" data-cust-del-start="${u.id}" data-testid="cust-delete-start" data-agent-id="cust-delete-start">Delete account</button>
      <span class="inline-confirm" data-cust-del-box="${u.id}" hidden>
        <button class="btn btn-small btn-danger" type="button" data-cust-del-confirm="${u.id}" data-testid="cust-delete-confirm" data-agent-id="cust-delete-confirm">Confirm delete</button>
        <button class="btn btn-small btn-ghost" type="button" data-cust-del-cancel="${u.id}" data-testid="cust-delete-cancel" data-agent-id="cust-delete-cancel">Cancel</button>
      </span>` : ''}
    </div>`}
    <h4>Bookings</h4>
    ${bookings.length ? `<ul class="mini-list">${bookings.map((b) => `<li><strong>${escapeHtml(b.ref)}</strong> ${formatDateTime(b.startAt)} &middot; ${b.days}d &middot; ${formatAud(b.totalCents)} &middot; ${STATUS_LABEL[b.status] || escapeHtml(b.status)}</li>`).join('')}</ul>` : '<p class="hint">None.</p>'}
    <h4>Payment history (AUD)</h4>
    ${payments.length ? `<ul class="mini-list">${payments.slice(0, 15).map((p) => `<li>${formatStamp(p.createdAt)} &middot; ${escapeHtml(p.kind)} &middot; <strong>${p.amountCents > 0 ? '+' : ''}${formatAud(p.amountCents)}</strong> ${escapeHtml(p.note || '')}</li>`).join('')}</ul>` : '<p class="hint">None.</p>'}`;
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
  const { user, messages, archived } = await api(`/admin/threads/${userId}`);
  $('threadTitle').textContent = archived
    ? `${user.fullName} (archived · 7-year retention)`
    : `${user.fullName} · ${user.email}`;
  const chat = $('adminChat');
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
  chat.innerHTML = messages.length ? messages.map((m) => `
    <div class="bubble ${m.sender === 'admin' ? 'mine' : 'theirs'}">
      <p>${escapeHtml(m.body)}</p><time>${formatStamp(m.createdAt)}</time></div>`).join('')
    : '<p class="hint">No messages yet. Start the conversation below.</p>';
  if (!quiet || atBottom) chat.scrollTop = chat.scrollHeight;
  $('adminChatForm').hidden = Boolean(archived);
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

/* ---------- Pricing (AUD only) ---------- */

let previewTimer = null;

function pricingFormValues() {
  const prices = [...document.querySelectorAll('#pList input[data-role="aud"]')].map((el) => el.value);
  const discounts = [...document.querySelectorAll('#pList input[data-role="discount"]')].map((el) => el.value || '0');
  return {
    price_table: prices.join(','),
    discount_table: discounts.join(','),
  };
}

function recalculateTierFromDiscount(dayNum) {
  if (dayNum <= 1) return;
  const day1Aud = Math.max(1, Math.round(Number(document.querySelector('#pList input[data-role="aud"]')?.value || 90)));
  const discInput = document.querySelector(`#pList input[data-role="discount"][data-day="${dayNum}"]`);
  const audInput = document.querySelector(`#pList #pList${dayNum}`);
  if (!discInput || !audInput) return;

  const discPct = Math.max(0, Math.min(99, Number(discInput.value) || 0));
  const fullAud = day1Aud * dayNum;
  const audExGst = Math.max(1, Math.ceil(fullAud * (1 - discPct / 100) - 1e-9));
  audInput.value = audExGst;
}

function recalculateAllDiscountedTiers() {
  document.querySelectorAll('#pList input[data-role="discount"][data-day]').forEach((el) => {
    recalculateTierFromDiscount(Number(el.dataset.day));
  });
}

function renderCalc({ dailyQuote: q, list }) {
  // Each price-list line shows ex-GST + 10% GST = total AUD inc. GST.
  list.forEach((lq, i) => {
    const out = document.getElementById(`pListOut${i + 1}`);
    if (out) out.textContent = `+ ${formatAud(lq.gstCents)} GST = ${formatAud(lq.totalCents)} inc. GST`;
  });
  const steps = [
    `1-day hire price: <strong>${formatAud(q.subtotalCents)} ex. GST</strong> + ${formatAud(q.gstCents)} GST = <strong>${formatAud(q.totalCents)} inc. GST</strong>.`,
    `Multi-day hire lengths calculate ex-GST discounts from the 1-day rate and add 10% Australian GST.`,
    `Stripe Checkout operates strictly in <strong>AUD</strong> with <code>automatic_tax: { enabled: true }</code>, <code>tax_behavior: "exclusive"</code>, and official AUD Tax Invoices.`,
  ];
  $('calcSteps').innerHTML = steps.map((s) => `<li>${s}</li>`).join('');
}

function renderPricing(view) {
  const s = view.settings;
  const prices = String(s.price_table || '').split(',').map((n) => Number(n.trim()));
  const rawDiscounts = String(s.discount_table || '0,5,5,5,5,5,5').split(',').map((n) => Number(n.trim()));

  $('pList').innerHTML = prices.map((price, i) => {
    const day = i + 1;
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
        data-testid="price-list-${day}" data-agent-id="price-list-${day}" aria-label="Price for ${day} day${i ? 's' : ''}, whole AUD ex GST"></span>
      <output id="pListOut${day}" class="hint"></output>
    </div>`;
  }).join('');
  renderCalc(view);
}

async function loadPricing() {
  renderPricing(await api('/admin/settings'));
  const form = $('pricingForm');
  form.querySelectorAll('input').forEach((el) => { el.disabled = !superadmin; });
  $('pricingReadonly').hidden = superadmin;
}

function schedulePreview() {
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

/* ---------- Contractor distribution ledger ---------- */

let ledgerState = null;

function brisbaneTodayStr() {
  return new Date(Date.now() + 10 * 3600000).toISOString().slice(0, 10);
}

function ledgerQueryString() {
  const from = $('ledgerFrom')?.value || '';
  const to = $('ledgerTo')?.value || '';
  const p = new URLSearchParams();
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

function renderLedger(view) {
  ledgerState = view;
  const { config: c, summary: s, entries } = view;
  const a = s.contractorA;
  const b = s.contractorB;

  const basisLabel = c.gstBasis === 'ex_gst'
    ? 'Ex-GST net revenue (10% Australian GST set aside first)'
    : 'Gross AUD collected (inclusive of GST)';
  $('ledgerBasisHint').textContent = `Split basis: ${basisLabel} · ${a.name} (${a.sharePct}%) / ${b.name} (${b.sharePct}%).`;

  const banner = $('ledgerSettlement');
  if (s.settlement.amountCents > 0) {
    const payer = s.settlement.from === 'contractor_a' ? a.name : b.name;
    const payee = s.settlement.to === 'contractor_a' ? a.name : b.name;
    banner.className = 'ledger-banner pending';
    banner.innerHTML = `<strong>Settlement due:</strong> ${escapeHtml(payer)} owes <strong>${escapeHtml(payee)}</strong> <strong>${formatAud(s.settlement.amountCents)}</strong>`;
  } else {
    banner.className = 'ledger-banner settled';
    banner.innerHTML = `<strong>All settled:</strong> ${escapeHtml(a.name)} and ${escapeHtml(b.name)} are currently balanced at AUD$0 owed.`;
  }
  if ($('ledgerPrefillBtn')) {
    $('ledgerPrefillBtn').disabled = !superadmin || s.settlement.amountCents <= 0;
  }

  const stat = (label, value, sub = '') => `<div class="stat"><span>${label}</span><strong>${value}</strong>${sub ? `<small class="hint">${sub}</small>` : ''}</div>`;
  $('ledgerSummary').innerHTML = [
    stat('Total collected (inc. GST)', formatAud(s.totalGrossCents), `Online ${formatAud(s.onlineGrossCents)} · Cash ${formatAud(s.cashGrossCents)}`),
    stat('GST set aside', formatAud(s.totalGstCents), `Online ${formatAud(s.onlineGstCents)} · Cash ${formatAud(s.cashGstCents)}`),
    stat('Distributable pool', formatAud(s.distributablePoolCents), c.gstBasis === 'ex_gst' ? 'Ex-GST net revenue' : 'Gross AUD'),
    stat('Settled between contractors', formatAud(s.distributedAToBCents + s.distributedBToACents), `${a.name} -> ${b.name}: ${formatAud(s.distributedAToBCents)}`),
  ].join('');

  const contractorCard = (k) => {
    const balClass = k.balanceCents > 0 ? 'pos' : k.balanceCents < 0 ? 'neg' : '';
    const balNote = k.balanceCents > 0
      ? `Owed ${formatAud(k.balanceCents)}`
      : k.balanceCents < 0
        ? `Owes ${formatAud(-k.balanceCents)}`
        : 'Balanced (AUD$0)';
    return `<article class="card ledger-contractor-card" data-testid="ledger-card-${k.id}" data-agent-id="ledger-card-${k.id}">
      <header>
        <div><h3>${escapeHtml(k.name)}</h3><p class="hint">${escapeHtml(k.role)}</p></div>
        <span class="status-pill ok">${k.sharePct}% share</span>
      </header>
      <dl class="details">
        <div><dt>Collected (gross)</dt><dd>${formatAud(k.grossCollectedCents)}</dd></div>
        <div><dt>GST held</dt><dd>${formatAud(k.gstHeldCents)}</dd></div>
        <div><dt>Pool held (${c.gstBasis === 'ex_gst' ? 'ex-GST' : 'gross'})</dt><dd>${formatAud(k.heldForSplitCents)}</dd></div>
        <div><dt>${k.sharePct}% entitlement</dt><dd>${formatAud(k.entitlementCents)}</dd></div>
        <div><dt>Distributions out / in</dt><dd>${formatAud(k.distributionsOutCents)} / ${formatAud(k.distributionsInCents)}</dd></div>
        <div><dt>Net balance</dt><dd class="${balClass}">${balNote}</dd></div>
      </dl>
    </article>`;
  };
  $('ledgerContractors').innerHTML = contractorCard(a) + contractorCard(b);

  if ($('lcCollector')) {
    $('lcCollector').options[0].textContent = b.name;
    $('lcCollector').options[1].textContent = a.name;
  }
  if ($('ldDirection')) {
    $('ldDirection').options[0].textContent = `${a.name} -> ${b.name}`;
    $('ldDirection').options[1].textContent = `${b.name} -> ${a.name}`;
  }
  if ($('lcDate') && !$('lcDate').value) $('lcDate').value = brisbaneTodayStr();
  if ($('ldDate') && !$('ldDate').value) $('ldDate').value = brisbaneTodayStr();

  if ($('cfgAName')) $('cfgAName').value = c.contractorA.name;
  if ($('cfgARole')) $('cfgARole').value = c.contractorA.role;
  if ($('cfgAShare')) $('cfgAShare').value = c.contractorA.sharePct;
  if ($('cfgBName')) $('cfgBName').value = c.contractorB.name;
  if ($('cfgBRole')) $('cfgBRole').value = c.contractorB.role;
  if ($('cfgBShare')) $('cfgBShare').value = c.contractorB.sharePct;
  if ($('cfgGstBasis')) $('cfgGstBasis').value = c.gstBasis;

  if ($('ledgerCsvLink')) $('ledgerCsvLink').href = `/api/admin/ledger/export.csv${ledgerQueryString()}`;

  const kindLabel = {
    payment: 'Stripe / online',
    refund: 'Refund',
    cash_payment: 'Cash payment',
    distribution: 'Distribution',
  };
  $('ledgerTable').innerHTML = entries.length ? `<table class="table">
    <thead><tr><th>Date</th><th>Type</th><th>Party / Direction</th><th>Detail</th><th class="num">Gross (AUD)</th><th class="num">GST</th><th class="num">Ex-GST / Dist.</th><th></th></tr></thead>
    <tbody>${entries.map((e) => {
      const isDist = e.kind === 'distribution';
      const rightAmt = isDist ? formatAud(e.distributionCents) : formatAud(e.exGstCents);
      const delControls = e.deletable && superadmin
        ? `<button class="btn btn-small btn-ghost" type="button" data-ledger-del-start="${e.id}" data-testid="ledger-del-${e.id}" data-agent-id="ledger-del-${e.id}">Delete</button>
           <span class="inline-confirm" data-ledger-del-box="${e.id}" hidden>
             <button class="btn btn-small btn-danger" type="button" data-ledger-del-confirm="${e.id}" data-testid="ledger-del-confirm-${e.id}" data-agent-id="ledger-del-confirm-${e.id}">Confirm delete</button>
             <button class="btn btn-small btn-ghost" type="button" data-ledger-del-cancel="${e.id}" data-testid="ledger-del-cancel-${e.id}" data-agent-id="ledger-del-cancel-${e.id}">Cancel</button>
           </span>`
        : '';
      return `<tr>
        <td>${escapeHtml(e.entryDate || formatStamp(e.createdAt))}</td>
        <td><span class="status-pill ${e.kind === 'refund' ? 'bad' : e.kind === 'distribution' ? 'wait' : 'ok'}">${kindLabel[e.kind] || escapeHtml(e.kind)}</span></td>
        <td>${escapeHtml(e.partyLabel)}${e.method ? `<br><small class="hint">${escapeHtml(e.method)}</small>` : ''}</td>
        <td>${escapeHtml(e.note || '')}${e.reference ? `<br><small class="hint">${escapeHtml(e.reference)}</small>` : ''}</td>
        <td class="num">${isDist ? '–' : formatAud(e.grossCents)}</td>
        <td class="num">${isDist ? '–' : formatAud(e.gstCents)}</td>
        <td class="num ${isDist ? 'pos' : e.exGstCents < 0 ? 'neg' : ''}">${rightAmt}</td>
        <td class="actions">${delControls}</td>
      </tr>`;
    }).join('')}</tbody></table>` : '<p class="hint">No ledger entries in this period yet.</p>';
}

async function loadLedger() {
  renderLedger(await api(`/admin/ledger${ledgerQueryString()}`));
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
      <td>${s.id === me.id ? '<span class="hint">You</span>' : `<div class="btn-row">
        <button class="btn btn-small btn-ghost" data-staff="${s.id}" data-disable="${!s.disabled}">${s.disabled ? 'Enable' : 'Disable'}</button>
        <button class="btn btn-small btn-danger" type="button" data-staff-del-start="${s.id}" data-testid="staff-delete-start-${s.id}" data-agent-id="staff-delete-start-${s.id}">Delete</button>
        <span class="inline-confirm" data-staff-del-box="${s.id}" hidden>
          <button class="btn btn-small btn-danger" type="button" data-staff-del-confirm="${s.id}" data-testid="staff-delete-confirm-${s.id}" data-agent-id="staff-delete-confirm-${s.id}">Confirm delete</button>
          <button class="btn btn-small btn-ghost" type="button" data-staff-del-cancel="${s.id}" data-testid="staff-delete-cancel-${s.id}" data-agent-id="staff-delete-cancel-${s.id}">Cancel</button>
        </span>
      </div>`}</td></tr>`).join('')}
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

function toggleInlineConfirm(prefix, id, show) {
  const start = document.querySelector(`[data-${prefix}-start="${CSS.escape(id)}"]`);
  const box = document.querySelector(`[data-${prefix}-box="${CSS.escape(id)}"]`);
  if (start) start.hidden = show;
  if (box) box.hidden = !show;
}

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

      const custDelStart = t.closest('[data-cust-del-start]');
      if (custDelStart) { toggleInlineConfirm('cust-del', custDelStart.dataset.custDelStart, true); return; }

      const custDelCancel = t.closest('[data-cust-del-cancel]');
      if (custDelCancel) { toggleInlineConfirm('cust-del', custDelCancel.dataset.custDelCancel, false); return; }

      const custDelConfirm = t.closest('[data-cust-del-confirm]');
      if (custDelConfirm) {
        const id = custDelConfirm.dataset.custDelConfirm;
        await api(`/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
        toast('Account deleted and message history archived for 7 years.', 'success');
        await openCustomer(id);
        return loadCustomers();
      }

      const staffDelStart = t.closest('[data-staff-del-start]');
      if (staffDelStart) { toggleInlineConfirm('staff-del', staffDelStart.dataset.staffDelStart, true); return; }

      const staffDelCancel = t.closest('[data-staff-del-cancel]');
      if (staffDelCancel) { toggleInlineConfirm('staff-del', staffDelCancel.dataset.staffDelCancel, false); return; }

      const staffDelConfirm = t.closest('[data-staff-del-confirm]');
      if (staffDelConfirm) {
        const id = staffDelConfirm.dataset.staffDelConfirm;
        await api(`/admin/staff/${encodeURIComponent(id)}`, { method: 'DELETE' });
        toast('Staff account deleted.', 'success');
        return loadStaff();
      }

      const lDelStart = t.closest('[data-ledger-del-start]');
      if (lDelStart) { toggleInlineConfirm('ledger-del', lDelStart.dataset.ledgerDelStart, true); return; }

      const lDelCancel = t.closest('[data-ledger-del-cancel]');
      if (lDelCancel) { toggleInlineConfirm('ledger-del', lDelCancel.dataset.ledgerDelCancel, false); return; }

      const lDelConfirm = t.closest('[data-ledger-del-confirm]');
      if (lDelConfirm) {
        const id = lDelConfirm.dataset.ledgerDelConfirm;
        const res = await api(`/admin/ledger/${encodeURIComponent(id)}`, { method: 'DELETE' });
        toast('Ledger entry deleted.', 'success');
        if (res.ledger) renderLedger(res.ledger);
        else await loadLedger();
        return;
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('custTable').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-customer]');
    if (row) openCustomer(row.dataset.customer).catch((err) => toast(err.message, 'error'));
  });

  $('bkFilter').addEventListener('change', () => loadBookings());
  $('custSearch').addEventListener('submit', (e) => { e.preventDefault(); loadCustomers(); });
  $('custStatus')?.addEventListener('change', () => loadCustomers());

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
    }
    schedulePreview();
  });
  $('pricingForm').addEventListener('change', schedulePreview);
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

  $('ledgerPrefillBtn')?.addEventListener('click', () => {
    const s = ledgerState?.summary?.settlement;
    if (!s || s.amountCents <= 0) return;
    $('ldDate').value = brisbaneTodayStr();
    $('ldDirection').value = s.from === 'contractor_a' ? 'a_to_b' : 'b_to_a';
    $('ldAmount').value = (s.amountCents / 100).toFixed(2);
    if (!$('ldNote').value) $('ldNote').value = 'Settlement distribution';
    $('ldAmount').focus();
  });

  $('ledgerCashForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('lcError'), null);
    try {
      const body = {
        entryDate: $('lcDate').value,
        amountAud: Number($('lcAmount').value),
        bookingRef: $('lcRef').value.trim(),
        note: $('lcNote').value.trim(),
      };
      if (superadmin && $('lcCollector')) body.collectedBy = $('lcCollector').value;
      const res = await api('/admin/ledger/cash', { method: 'POST', body });
      $('lcAmount').value = '';
      $('lcRef').value = '';
      $('lcNote').value = '';
      toast('Cash payment recorded in AUD.', 'success');
      if (res.ledger) renderLedger(res.ledger);
      else await loadLedger();
    } catch (err) {
      showError($('lcError'), err);
    }
  });

  $('ledgerDistForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('ldError'), null);
    try {
      const dir = $('ldDirection').value;
      const res = await api('/admin/ledger/distributions', {
        method: 'POST',
        body: {
          entryDate: $('ldDate').value,
          fromContractor: dir === 'a_to_b' ? 'contractor_a' : 'contractor_b',
          toContractor: dir === 'a_to_b' ? 'contractor_b' : 'contractor_a',
          amountAud: Number($('ldAmount').value),
          method: $('ldMethod').value,
          reference: $('ldRef').value.trim(),
          note: $('ldNote').value.trim(),
        },
      });
      $('ldAmount').value = '';
      $('ldRef').value = '';
      $('ldNote').value = '';
      toast('Contractor distribution recorded.', 'success');
      if (res.ledger) renderLedger(res.ledger);
      else await loadLedger();
    } catch (err) {
      showError($('ldError'), err);
    }
  });

  $('cfgAShare')?.addEventListener('input', () => {
    const a = Number($('cfgAShare').value);
    if (Number.isInteger(a) && a >= 0 && a <= 100 && $('cfgBShare')) $('cfgBShare').value = 100 - a;
  });
  $('cfgBShare')?.addEventListener('input', () => {
    const b = Number($('cfgBShare').value);
    if (Number.isInteger(b) && b >= 0 && b <= 100 && $('cfgAShare')) $('cfgAShare').value = 100 - b;
  });

  $('ledgerConfigForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('cfgLedgerError'), null);
    try {
      const ledger = await api('/admin/ledger/config', {
        method: 'PUT',
        body: {
          contractor_a_name: $('cfgAName').value.trim(),
          contractor_a_role: $('cfgARole').value.trim(),
          contractor_a_share_pct: Number($('cfgAShare').value),
          contractor_b_name: $('cfgBName').value.trim(),
          contractor_b_role: $('cfgBRole').value.trim(),
          contractor_b_share_pct: Number($('cfgBShare').value),
          distribution_gst_basis: $('cfgGstBasis').value,
        },
      });
      toast('Contractor & split settings saved.', 'success');
      renderLedger(ledger);
    } catch (err) {
      showError($('cfgLedgerError'), err);
    }
  });

  $('ledgerFilterApply')?.addEventListener('click', () => {
    loadLedger().catch((err) => toast(err.message, 'error'));
  });
  $('ledgerFilterClear')?.addEventListener('click', () => {
    $('ledgerFrom').value = '';
    $('ledgerTo').value = '';
    loadLedger().catch((err) => toast(err.message, 'error'));
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
  showTab(location.hash.slice(1) || 'messages');
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
});
