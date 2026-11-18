import {
  api, getMe, getConfig, formatAud, formatDateTime, formatStamp,
  getDeviceLocation, toast, showError, setBusy, escapeHtml, withShrunkLicence,
} from './common.js';

const $ = (id) => document.getElementById(id);
let me = null;
let cfg = null;
let chatTimer = null;
let area = null; // last "Check my location" result; bookings check again each time

const LICENCE_TEXT = {
  verified: ['ok', 'Verified'],
  pending: ['wait', 'Awaiting review by our team'],
  rejected: ['bad', 'Not verified'],
  unverified: ['bad', 'Not yet checked'],
};

/* ---------- Tabs ---------- */

function showTab(name) {
  document.querySelectorAll('[role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  history.replaceState(null, '', `${location.pathname}${location.search}#${name}`);
  clearInterval(chatTimer);
  if (name === 'messages') {
    loadChat();
    chatTimer = setInterval(loadChat, 15000);
  }
  if (name === 'bookings') loadBookings();
  if (name === 'payments') loadPayments();
}

/* ---------- Rendering ---------- */

function renderHeader() {
  $('acctName').textContent = `Hi, ${me.fullName.split(' ')[0]}`;
  const ins = me.insurer && me.indemnityConfirmed && me.policyExpiry >= cfg.today;
  const ready = me.licenceStatus === 'verified' && Boolean(ins);
  $('acctStatus').textContent = ready ? 'Ready to book' : 'Setup incomplete';
  const unread = $('tabUnread');
  unread.hidden = !me.unreadMessages;
  unread.textContent = me.unreadMessages || '';
}

function renderOverview() {
  const [cls, text] = LICENCE_TEXT[me.licenceStatus];
  const ins = me.insurer && me.indemnityConfirmed && me.policyExpiry >= cfg.today;
  const radius = cfg.bookingRadiusKm;
  const where = !area ? `Bookings are open to people within ${radius} km of our depot. We check your location each time you book.`
    : area.inArea ? `You're ${area.distanceKm} km from our depot, inside our ${radius} km booking area.`
      : `You appear to be ${area.distanceKm} km away. Bookings are only open within ${radius} km of our depot.`;
  $('readyList').innerHTML = `
    <li class="${!area ? 'wait' : area.inArea ? 'ok' : 'bad'}"><strong>Location:</strong> ${where}
      <button class="link-button" type="button" data-check-location>${area ? 'Check again' : 'Check my location'}</button></li>
    <li class="${cls}"><strong>Licence:</strong> ${text} <a href="#licence" data-goto="licence">View</a></li>
    <li class="${ins ? 'ok' : 'bad'}"><strong>Insurance:</strong> ${ins ? `${escapeHtml(me.insurer)}, valid to ${escapeHtml(me.policyExpiry)}` : 'Add your insurance details'} <a href="#insurance" data-goto="insurance">${ins ? 'Edit' : 'Add'}</a></li>`;
}

function renderLicence() {
  const [cls, text] = LICENCE_TEXT[me.licenceStatus];
  $('licenceStatus').innerHTML = `
    <p class="status-pill ${cls}">${text}</p>
    ${me.licenceNotes ? `<p>${escapeHtml(me.licenceNotes)}</p>` : ''}
    <dl class="details">
      <div><dt>Licence number</dt><dd>${escapeHtml(me.licenceNumber || '–')}</dd></div>
      <div><dt>State</dt><dd>${escapeHtml(me.licenceState || '–')}</dd></div>
      <div><dt>Expiry</dt><dd>${escapeHtml(me.licenceExpiry || '–')}</dd></div>
      ${me.licenceClass ? `<div><dt>Class</dt><dd>${escapeHtml(me.licenceClass)}</dd></div>` : ''}
    </dl>`;
  const canUpload = me.licenceStatus === 'rejected' || me.licenceStatus === 'unverified';
  $('licenceForm').hidden = !canUpload;
  if (canUpload) {
    $('lNumber').value = me.licenceNumber || '';
    $('lState').value = me.licenceState || 'QLD';
    $('lExpiry').value = me.licenceExpiry || '';
  }
}

function renderInsurance() {
  $('insurer').value = me.insurer || '';
  $('policyNumber').value = me.policyNumber || '';
  $('policyExpiry').value = me.policyExpiry || '';
  $('policyExpiry').min = cfg.today;
  $('confirmIndemnity').checked = me.indemnityConfirmed;
}

function renderProfile() {
  $('profileFixed').innerHTML = `
    <div><dt>Name</dt><dd>${escapeHtml(me.fullName)}</dd></div>
    <div><dt>Email</dt><dd>${escapeHtml(me.email)}</dd></div>
    <div><dt>Date of birth</dt><dd>${escapeHtml(me.dob || '–')}</dd></div>
    <div><dt>Sign-in</dt><dd>${me.googleLinked ? 'Google' : ''}${me.googleLinked && me.hasPassword ? ' or ' : ''}${me.hasPassword ? 'Email and password' : ''}</dd></div>`;
  const dobField = $('pDobField');
  const dobInput = $('pDob');
  if (dobField && dobInput) {
    dobField.hidden = Boolean(me.dob);
    dobInput.required = !me.dob;
    if (me.dob) dobInput.value = '';
  }
  // Google-only accounts have no password to change, and confirm deletion by typing DELETE instead.
  $('passwordSection').hidden = !me.hasPassword;
  if (!me.hasPassword) {
    $('delPwLabel').textContent = 'Type DELETE';
    $('delPw').type = 'text';
    $('delPw').autocomplete = 'off';
  }
  $('pPhone').value = me.phone || '';
  $('pAddress').value = me.addressLine || '';
  $('pSuburb').value = me.suburb || '';
  $('pState').value = me.state || 'QLD';
  $('pPostcode').value = me.postcode || '';
}

function bookingCard(b, { compact = false } = {}) {
  const canCancel = b.status === 'confirmed' && Date.now() < b.startAt - cfg.cancellationHours * 3600000;
  const statusLabel = {
    pending_payment: 'Awaiting payment',
    confirmed: 'Confirmed',
    active: 'In progress',
    completed: 'Completed',
    cancelled: 'Cancelled',
  }[b.status] || b.status;
  const pillCls = b.status === 'cancelled' ? 'bad' : b.status === 'pending_payment' ? 'wait' : b.status === 'completed' ? '' : 'ok';
  return `<article class="booking-card ${b.status}">
    <header><strong>${escapeHtml(b.ref)}</strong><span class="status-pill ${pillCls}">${statusLabel}</span></header>
    <p><strong>Pickup:</strong> ${formatDateTime(b.startAt)}<br><strong>Return:</strong> ${formatDateTime(b.endAt)}</p>
    ${compact ? '' : `<p class="hint">${b.days} day${b.days > 1 ? 's' : ''} &middot; ${formatAud(b.totalCents)} inc. GST${b.refundedAudCents ? ` &middot; ${formatAud(b.refundedAudCents)} refunded` : ''}</p>`}
    ${canCancel && !compact ? `<button class="btn btn-small btn-ghost" data-cancel="${b.id}">Cancel booking</button>` : ''}
  </article>`;
}

/* ---------- Loaders ---------- */

async function refreshMe() {
  me = await getMe(true);
  renderHeader();
  renderOverview();
  renderLicence();
  renderInsurance();
  renderProfile();
}

async function loadBookings() {
  const { bookings } = await api('/bookings');
  $('bookingList').innerHTML = bookings.length
    ? bookings.map((b) => bookingCard(b)).join('')
    : '<p class="hint">No bookings yet. <a href="/#book">Book the van</a>.</p>';
  const next = bookings.filter((b) => ['confirmed', 'active'].includes(b.status)).sort((a, b) => a.startAt - b.startAt)[0];
  $('nextBooking').innerHTML = next ? bookingCard(next, { compact: true }) : '<p class="hint">No upcoming bookings.</p>';
}

async function loadPayments() {
  const modes = {
    stripe: 'Payments are processed securely by Stripe in Australian dollars (AUD) with 10% GST and an official Tax Invoice.',
    demo: 'Demo mode: bookings are confirmed straight away in AUD without charging a card.',
    disabled: 'Online payments are not available right now. Please message us.',
  };
  $('payMode').textContent = modes[cfg.paymentsMode];

  const { payments } = await api('/account/payments');
  const kinds = { payment: 'Booking payment', refund: 'Refund' };
  $('txList').innerHTML = payments.length ? `<table class="table">
    <thead><tr><th>Date</th><th>Type</th><th>Detail</th><th class="num">Amount (AUD)</th></tr></thead>
    <tbody>${payments.map((p) => `<tr>
      <td>${formatStamp(p.createdAt)}</td><td>${kinds[p.kind] || escapeHtml(p.kind)}</td>
      <td>${escapeHtml(p.note || (p.bookingRef ? `Booking ${p.bookingRef} via ${p.provider}` : p.provider))}</td>
      <td class="num ${p.amountCents < 0 ? 'neg' : 'pos'}">${p.amountCents > 0 ? '+' : ''}${formatAud(p.amountCents)}</td></tr>`).join('')}
    </tbody></table>` : '<p class="hint">No AUD payments or refunds yet.</p>';
}

async function loadChat() {
  const { messages } = await api('/messages');
  const chat = $('chat');
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
  chat.innerHTML = messages.length ? messages.map((m) => `
    <div class="bubble ${m.sender === 'customer' ? 'mine' : 'theirs'}">
      <p>${escapeHtml(m.body)}</p><time>${m.sender === 'admin' ? 'Kangoo Rental · ' : ''}${formatStamp(m.createdAt)}</time>
    </div>`).join('') : '<p class="hint">No messages yet. Say hello!</p>';
  if (atBottom || chat.dataset.loaded !== '1') chat.scrollTop = chat.scrollHeight;
  chat.dataset.loaded = '1';
  $('tabUnread').hidden = true;
  // Opening the thread marks it read on the server; refresh the header badge to match.
  if (me.unreadMessages) me = await getMe(true);
}

/* ---------- Actions ---------- */

async function handleReturnParams() {
  const params = new URLSearchParams(location.search);
  const flash = $('flash');
  const say = (msg, kind = 'info') => { flash.textContent = msg; flash.dataset.kind = kind; flash.hidden = false; };

  if (params.get('booking_paid') === '1' && params.get('session_id')) {
    try {
      const r = await api(`/bookings/confirm?session_id=${encodeURIComponent(params.get('session_id'))}`);
      say(r.paid
        ? `Payment received (${formatAud(r.booking?.paidAudCents ?? r.booking?.totalCents)} inc. GST). Booking ${r.booking?.ref || ''} is confirmed!`
        : 'Your payment is still processing. Your booking will appear as confirmed shortly.', 'success');
      await refreshMe();
    } catch (err) {
      say(err.message, 'error');
    }
  } else if (params.get('booking_cancelled') === '1') {
    const bid = params.get('booking_id');
    if (bid) await api(`/bookings/${encodeURIComponent(bid)}/abandon`, { method: 'POST' }).catch(() => {});
    say('Checkout cancelled. No money was taken and the calendar slot has been released.');
  } else if (params.get('booked')) {
    say(`Booking ${params.get('booked')} is confirmed. See you at pickup!`, 'success');
  } else if (params.get('welcome')) {
    const lic = JSON.parse(sessionStorage.getItem('kangoo.licenceResult') || 'null');
    sessionStorage.removeItem('kangoo.licenceResult');
    const msg = lic
      ? `Welcome to Kangoo Rental! ${lic.notes || ''}`
      : 'Welcome to Kangoo Rental! Your supporter account is ready. Complete your details, licence, and insurance to book.';
    say(msg, lic?.status === 'rejected' ? 'error' : 'success');
  }
  if (params.has('booking_paid') || params.has('booking_cancelled') || params.has('booked') || params.has('welcome') || params.has('session_id') || params.has('booking_id')) {
    history.replaceState(null, '', `${location.pathname}${location.hash}`);
  }
}

function bindForms() {
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) showTab(tab.dataset.tab);
  });
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) {
      e.preventDefault();
      showTab(go.dataset.goto);
    }
  });

  $('bookingList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cancel]');
    if (!btn || !confirm('Cancel this booking? Your AUD payment will be refunded.')) return;
    try {
      await api(`/bookings/${btn.dataset.cancel}/cancel`, { method: 'POST' });
      toast('Booking cancelled and AUD payment refunded.', 'success');
      await refreshMe();
      loadBookings();
      if ($('txList').innerHTML.trim()) loadPayments();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('licenceForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('licenceBtn');
    showError($('licenceError'), null);
    setBusy(btn, true, 'Checking…');
    try {
      const { licence } = await api('/account/licence', { method: 'POST', form: await withShrunkLicence(new FormData(e.target)) });
      toast(licence.notes, licence.status === 'rejected' ? 'error' : 'success');
      e.target.reset();
      await refreshMe();
    } catch (err) {
      showError($('licenceError'), err);
    } finally {
      setBusy(btn, false);
    }
  });

  $('insuranceForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('insuranceError'), null);
    try {
      await api('/account/insurance', {
        method: 'PUT',
        body: {
          insurer: $('insurer').value,
          policyNumber: $('policyNumber').value,
          policyExpiry: $('policyExpiry').value,
          confirmIndemnity: $('confirmIndemnity').checked,
        },
      });
      toast('Insurance details saved.', 'success');
      await refreshMe();
    } catch (err) {
      showError($('insuranceError'), err);
    }
  });

  $('chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('chatInput');
    if (!input.value.trim()) return;
    try {
      await api('/messages', { method: 'POST', body: { body: input.value } });
      input.value = '';
      $('chat').dataset.loaded = '0';
      loadChat();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('chatForm').requestSubmit();
    }
  });

  $('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/account/profile', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
      toast('Details saved.', 'success');
      await refreshMe();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: $('curPw').value, newPassword: $('newPw').value } });
      e.target.reset();
      toast('Password updated.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('delStartBtn').addEventListener('click', () => {
    if (!$('deleteForm').reportValidity()) return;
    $('delStartBtn').hidden = true;
    $('delConfirmBox').hidden = false;
    $('delConfirmBtn').focus();
  });

  $('delCancelBtn').addEventListener('click', () => {
    $('delConfirmBox').hidden = true;
    $('delStartBtn').hidden = false;
  });

  $('deleteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('delConfirmBox').hidden) {
      $('delStartBtn').click();
      return;
    }
    try {
      const value = $('delPw').value;
      await api('/account/delete', { method: 'POST', body: me.hasPassword ? { password: value } : { confirm: value.trim().toUpperCase() } });
      window.location.href = '/';
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  [cfg, me] = await Promise.all([getConfig(), getMe()]);
  if (!me) {
    window.location.href = '/login?next=/account';
    return;
  }
  bindForms();
  $('readyList').addEventListener('click', async (e) => {
    if (!e.target.closest('[data-check-location]')) return;
    try {
      const { lat, lng } = await getDeviceLocation();
      area = await api('/geo/check', { method: 'POST', body: { lat, lng } });
    } catch (err) {
      toast(err.message, 'error');
    }
    renderOverview();
  });
  await handleReturnParams();
  await refreshMe();
  loadBookings();
  const tabFromHash = () => {
    const tab = location.hash.slice(1);
    return document.querySelector(`[data-tab="${tab}"]`) ? tab : 'overview';
  };
  showTab(tabFromHash());
  window.addEventListener('hashchange', () => showTab(tabFromHash()));
  window.addEventListener('kangoo:prefs', () => {
    loadBookings();
    if ($('txList').innerHTML.trim()) loadPayments();
    if ($('chat').dataset.loaded === '1') loadChat();
  });
});
