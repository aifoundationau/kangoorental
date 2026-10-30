import {
  api, getMe, getConfig, formatAud, formatUsd, formatTokens, formatRate, formatDateTime, formatStamp, toast,
  showError, setBusy, escapeHtml, withShrunkLicence,
} from './common.js';

const $ = (id) => document.getElementById(id);
let me = null;
let cfg = null;
let chatTimer = null;

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
  if (name === 'tokens') loadTransactions();
}

/* ---------- Rendering ---------- */

function renderHeader() {
  $('acctName').textContent = `Hi, ${me.fullName.split(' ')[0]}`;
  $('acctBalance').textContent = `${formatTokens(me.tokenCents)} tokens`;
  const unread = $('tabUnread');
  unread.hidden = !me.unreadMessages;
  unread.textContent = me.unreadMessages || '';
}

function renderOverview() {
  const [cls, text] = LICENCE_TEXT[me.licenceStatus];
  const ins = me.insurer && me.indemnityConfirmed && me.policyExpiry >= cfg.today;
  const day = cfg.dailyQuote.tokenCents;
  $('readyList').innerHTML = `
    <li class="${cls}"><strong>Licence:</strong> ${text} <a href="#licence" data-goto="licence">View</a></li>
    <li class="${ins ? 'ok' : 'bad'}"><strong>Insurance:</strong> ${ins ? `${escapeHtml(me.insurer)}, valid to ${escapeHtml(me.policyExpiry)}` : 'Add your insurance details'} <a href="#insurance" data-goto="insurance">${ins ? 'Edit' : 'Add'}</a></li>
    <li class="${me.tokenCents >= day ? 'ok' : 'bad'}"><strong>Tokens:</strong> ${formatTokens(me.tokenCents)} (one day is ${formatTokens(day)}) <a href="#tokens" data-goto="tokens">Buy tokens</a></li>`;
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
    <div><dt>Date of birth</dt><dd>${escapeHtml(me.dob)}</dd></div>`;
  $('pPhone').value = me.phone || '';
  $('pAddress').value = me.addressLine || '';
  $('pSuburb').value = me.suburb || '';
  $('pState').value = me.state || 'QLD';
  $('pPostcode').value = me.postcode || '';
}

function renderTokens() {
  $('tokRate').textContent = `US$1.00 = A$${formatRate(cfg.fx.rate)}`;
  const q = cfg.dailyQuote;
  $('tokDay').textContent = `${formatAud(q.totalCents)} inc GST = ${formatTokens(q.tokenCents)} tokens`;
  $('packs').innerHTML = cfg.tokenPacks.map((n) => {
    const days = Math.floor((n * 100) / q.tokenCents);
    return `<button class="pack" type="button" data-tokens="${n}">
      <strong>${n} tokens</strong><span>${formatUsd(n * 100)}</span>
      <small>${days >= 1 ? `about ${days} day${days > 1 ? 's' : ''} hire` : 'top-up'}</small></button>`;
  }).join('');
  const modes = {
    stripe: 'Payments are processed securely by Stripe and charged in US dollars.',
    demo: 'Demo mode: no payment is taken and tokens are added straight away.',
    disabled: 'Online payments are not available right now. Please message us.',
  };
  $('payMode').textContent = modes[cfg.paymentsMode];
  const suggested = Number(new URLSearchParams(location.search).get('buy'));
  if (suggested > 0) $('customAmount').value = suggested;
}

function bookingCard(b, { compact = false } = {}) {
  const canCancel = b.status === 'confirmed' && Date.now() < b.startAt - cfg.cancellationHours * 3600000;
  const statusLabel = { confirmed: 'Confirmed', active: 'In progress', completed: 'Completed', cancelled: 'Cancelled' }[b.status];
  return `<article class="booking-card ${b.status}">
    <header><strong>${escapeHtml(b.ref)}</strong><span class="status-pill ${b.status === 'cancelled' ? 'bad' : b.status === 'completed' ? '' : 'ok'}">${statusLabel}</span></header>
    <p><strong>Pickup:</strong> ${formatDateTime(b.startAt)}<br><strong>Return:</strong> ${formatDateTime(b.endAt)}</p>
    ${compact ? '' : `<p class="hint">${b.days} × 24 hours &middot; ${formatAud(b.totalCents)} inc GST &middot; ${formatTokens(b.tokenCents)} tokens
      (at US$1 = A$${formatRate(b.fxRate)})${b.refundedTokenCents ? ` &middot; ${formatTokens(b.refundedTokenCents)} tokens refunded` : ''}</p>`}
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

async function loadTransactions() {
  const { transactions } = await api('/account/transactions');
  const kinds = { purchase: 'Purchase', booking: 'Booking', refund: 'Refund', adjustment: 'Adjustment' };
  $('txList').innerHTML = transactions.length ? `<table class="table">
    <thead><tr><th>Date</th><th>Type</th><th>Detail</th><th class="num">Tokens</th></tr></thead>
    <tbody>${transactions.map((t) => `<tr>
      <td>${formatStamp(t.createdAt)}</td><td>${kinds[t.kind]}</td>
      <td>${escapeHtml(t.note || (t.amountCents ? `${formatUsd(t.amountCents)} via ${t.provider}` : ''))}</td>
      <td class="num ${t.deltaCents < 0 ? 'neg' : 'pos'}">${t.deltaCents > 0 ? '+' : ''}${formatTokens(t.deltaCents)}</td></tr>`).join('')}
    </tbody></table>` : '<p class="hint">No token activity yet.</p>';
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

async function buyTokens(tokens, button) {
  setBusy(button, true, 'Starting payment…');
  try {
    const r = await api('/tokens/checkout', { method: 'POST', body: { tokens } });
    if (r.url) {
      window.location.href = r.url;
      return;
    }
    toast(`${tokens} tokens added (demo mode).`, 'success');
    await refreshMe();
    loadTransactions();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function handleReturnParams() {
  const params = new URLSearchParams(location.search);
  const flash = $('flash');
  const say = (msg, kind = 'info') => { flash.textContent = msg; flash.dataset.kind = kind; flash.hidden = false; };

  if (params.get('purchase') === 'success' && params.get('session_id')) {
    try {
      const r = await api(`/tokens/confirm?session_id=${encodeURIComponent(params.get('session_id'))}`);
      say(r.paid ? 'Payment received. Your tokens have been added.' : 'Your payment is still processing. Tokens will appear shortly.', 'success');
      await refreshMe();
    } catch (err) {
      say(err.message, 'error');
    }
  } else if (params.get('purchase') === 'cancelled') {
    say('Payment cancelled. No money was taken.');
  } else if (params.get('booked')) {
    say(`Booking ${params.get('booked')} is confirmed. See you at pickup!`, 'success');
  } else if (params.get('welcome')) {
    const lic = JSON.parse(sessionStorage.getItem('kangoo.licenceResult') || 'null');
    sessionStorage.removeItem('kangoo.licenceResult');
    say(`Welcome to Kangoo Rental! ${lic?.notes || ''}`, lic?.status === 'rejected' ? 'error' : 'success');
  }
  if (params.has('purchase') || params.has('booked') || params.has('welcome')) {
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

  $('packs').addEventListener('click', (e) => {
    const pack = e.target.closest('.pack');
    if (pack) buyTokens(Number(pack.dataset.tokens), pack);
  });
  $('customTokens').addEventListener('submit', (e) => {
    e.preventDefault();
    buyTokens(Number($('customAmount').value), e.submitter);
  });

  $('bookingList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cancel]');
    if (!btn || !confirm('Cancel this booking? Your tokens will be refunded.')) return;
    try {
      await api(`/bookings/${btn.dataset.cancel}/cancel`, { method: 'POST' });
      toast('Booking cancelled and tokens refunded.', 'success');
      await refreshMe();
      loadBookings();
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

  $('deleteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!confirm('Delete your account permanently? This cannot be undone.')) return;
    try {
      await api('/account/delete', { method: 'POST', body: { password: $('delPw').value } });
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
  renderTokens();
  await handleReturnParams();
  await refreshMe();
  loadBookings();
  const tabFromHash = () => {
    const tab = location.hash.slice(1);
    return document.querySelector(`[data-tab="${tab}"]`) ? tab : 'overview';
  };
  showTab(tabFromHash());
  window.addEventListener('hashchange', () => showTab(tabFromHash()));
});
