// Shared helpers: API calls with CSRF, session state, formatting and toasts.

let csrfToken = '';
let mePromise = null;
let configPromise = null;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (data.csrf) csrfToken = data.csrf;
  if (!res.ok) throw new ApiError(res.status, data.error || 'Request failed.');
  return data;
}

export function getMe(refresh = false) {
  if (!mePromise || refresh) {
    mePromise = api('/me').then((d) => {
      updateNav(d.user);
      return d.user;
    }).catch(() => null);
  }
  return mePromise;
}

export function getConfig(refresh = false) {
  if (!configPromise || refresh) configPromise = api('/config');
  return configPromise;
}

export const isStaff = (user) => user && (user.role === 'admin' || user.role === 'superadmin');

/* ---------- Formatting ---------- */

const aud = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
export const formatAud = (cents) => `A${aud.format(cents / 100)}`;
export const formatUsd = (cents) => `US$${(cents / 100).toFixed(2)}`;
export const formatTokens = (tokenCents) => (tokenCents / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const formatRate = (rate) => Number(rate).toFixed(4);

const TZ = 'Australia/Brisbane';
export const formatDateTime = (ms) => new Date(ms).toLocaleString('en-AU', {
  timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
});
export const formatDate = (isoDate) => new Date(`${isoDate}T00:00:00+10:00`).toLocaleDateString('en-AU', {
  timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric',
});
export const formatStamp = (iso) => (iso ? new Date(iso).toLocaleString('en-AU', {
  timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
}) : '');

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- UI helpers ---------- */

let toastTimer;
export function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

export function showError(el, err) {
  if (!el) return toast(err.message || String(err), 'error');
  el.textContent = err ? err.message || String(err) : '';
  el.hidden = !err;
}

export function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label || 'Please wait…';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

function updateNav(user) {
  document.querySelectorAll('[data-auth="guest"]').forEach((el) => { el.hidden = Boolean(user); });
  document.querySelectorAll('[data-auth="user"]').forEach((el) => { el.hidden = !user; });
  const account = document.getElementById('navAccount');
  if (account && user) {
    account.firstChild.textContent = isStaff(user) ? 'Admin panel ' : 'My account ';
    account.href = isStaff(user) ? '/admin' : '/account';
  }
  const unread = document.getElementById('navUnread');
  if (unread) {
    unread.hidden = !user?.unreadMessages;
    unread.textContent = user?.unreadMessages || '';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  getMe();

  const toggle = document.getElementById('navToggle');
  const nav = document.getElementById('siteNav');
  toggle?.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/';
  });

  getConfig().then((cfg) => {
    const banner = document.getElementById('announcement');
    if (banner && cfg.announcement) {
      banner.textContent = cfg.announcement;
      banner.hidden = false;
    }
  }).catch(() => {});
});
