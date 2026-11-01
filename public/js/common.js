// Shared helpers: API calls with CSRF, session state, formatting and toasts.
import { getPrefs, displayTimeZone, pricingCurrency, DEPOT_TZ } from './prefs.js';

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

// Every dollar and token amount is shown as a whole number, rounded up.
const ceilWhole = (cents) => Math.ceil(cents / 100 - 1e-9) || 0; // `|| 0` turns -0 into 0
export const formatAud = (cents) => `AUD$${ceilWhole(cents).toLocaleString('en-AU')}`;
export const formatUsd = (cents) => `US$${ceilWhole(cents).toLocaleString('en-US')}`;
export const formatTokens = (tokenCents) => ceilWhole(tokenCents).toLocaleString('en-AU');
export const formatRate = (rate) => {
  const n = Number(rate);
  if (!Number.isFinite(n) || n <= 0) return '0.70';
  const usdPerAud = n > 1.05 ? 1 / n : n;
  return usdPerAud.toFixed(2);
};

/**
 * Default currency is AUD. Visitors in Australia and New Zealand see AUD$;
 * visitors in all other nations see AUD$ with the USD conversion.
 */
export const formatPrice = ({ aud: audCents, usd: usdCents }) => (
  pricingCurrency() === 'AUD' ? formatAud(audCents) : `${formatAud(audCents)} (${formatUsd(usdCents)})`
);

/** A quote's amounts in AUD and converted USD (AUD$1 -> USD for visitors outside Australia and New Zealand). */
export const quotePrices = (q) => {
  const rate = q.usdPerAud || (q.fxRate > 1.05 ? 1 / q.fxRate : q.fxRate || 0.7);
  const toUsd = (audCents) => Math.ceil((audCents / 100) * rate - 1e-9) * 100;
  return {
    list: { aud: q.listSubtotalCents, usd: q.usdListSubtotalCents ?? toUsd(q.listSubtotalCents) },
    discount: { aud: q.discountCents, usd: q.usdDiscountCents ?? toUsd(q.discountCents) },
    subtotal: { aud: q.subtotalCents, usd: q.usdSubtotalCents ?? toUsd(q.subtotalCents) },
    gst: { aud: q.gstCents, usd: q.usdGstCents ?? toUsd(q.gstCents) },
    total: { aud: q.totalCents, usd: q.usdTotalCents ?? toUsd(q.totalCents) },
  };
};

// Dates and times follow the visitor's settings in the location panel (date order, 12/24-hour clock, time zone).
const DATE_LOCALES = { dmy: 'en-AU', mdy: 'en-US', ymd: 'en-CA' };

function formatWhen(date, options, timeZone = displayTimeZone(), { nameZone = true } = {}) {
  const { dateFormat, clock, localTz } = getPrefs();
  const o = { timeZone, ...options };
  if (o.hour) {
    o.hour12 = clock === '12';
    // Name the zone whenever the visitor might read it as a different one from the times shown.
    if (nameZone && (timeZone !== DEPOT_TZ || localTz !== DEPOT_TZ)) o.timeZoneName = 'short';
  }
  if (dateFormat === 'ymd' && o.day) Object.assign(o, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return new Date(date).toLocaleString(DATE_LOCALES[dateFormat] || 'en-AU', o);
}

export const formatDateTime = (ms) => formatWhen(ms, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
/** A Brisbane calendar date such as a booking day ("2026-10-31"); never shifted into another time zone. */
export const formatDate = (isoDate) => formatWhen(`${isoDate}T12:00:00+10:00`, { day: 'numeric', month: 'short', year: 'numeric' }, DEPOT_TZ);
export const formatStamp = (iso) => (iso ? formatWhen(iso, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
export const formatLongDate = (ms, timeZone) => formatWhen(ms, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, timeZone);
export const formatTime = (ms, timeZone, { seconds = false } = {}) => formatWhen(ms, {
  hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}),
}, timeZone, { nameZone: false });

export const weatherIcon = (code) => (code === 0 ? '☀️' : code <= 2 ? '⛅' : code === 3 ? '☁️' : code <= 48 ? '🌫️'
  : code <= 67 ? '🌧️' : code <= 77 ? '🌨️' : code <= 82 ? '🌦️' : code <= 86 ? '🌨️' : '⛈️');

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Sign in with Google ---------- */

let gsiLoading = null;
function loadGoogleScript() {
  gsiLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return gsiLoading;
}

/** Renders Google's button into `el` and calls onCredential(idToken) after sign-in. Returns false if unavailable. */
export async function renderGoogleButton(el, onCredential, text = 'continue_with', opts = {}) {
  const cfg = await getConfig().catch(() => null);
  if (!el || !cfg?.googleClientId) return false;
  try {
    await loadGoogleScript();
  } catch {
    return false;
  }
  window.google.accounts.id.initialize({
    client_id: cfg.googleClientId,
    callback: (response) => onCredential(response.credential),
    ux_mode: 'popup',
    auto_select: false,
  });
  window.google.accounts.id.renderButton(el, {
    type: 'standard',
    theme: opts.theme || 'outline',
    size: opts.size || 'medium',
    text,
    shape: opts.shape || 'pill',
    logo_alignment: opts.logo_alignment || 'left',
    width: opts.width || Math.min(400, Math.max(200, el.clientWidth || 240)),
  });
  el.closest('[data-google]')?.removeAttribute('hidden');
  return true;
}

/** The device's current location, { lat, lng, accuracy }, or an Error with a message to show the visitor. */
export function getDeviceLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Your browser can't share its location, so we can't check you're within our booking area. Please message us."));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) }),
      (err) => reject(new Error(err.code === 1
        ? 'Location permission was denied. Allow location for this site in your browser settings, then try again.'
        : "We couldn't get your location. Please try again.")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

/** Downscales a photo in the browser (longest side 1600px, JPEG) so uploads stay small. Falls back to the original. */
export async function shrinkImage(file, maxDim = 1600) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1500000) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    return blob || file;
  } catch {
    return file;
  }
}

export async function withShrunkLicence(formData) {
  const photo = formData.get('licence');
  if (photo instanceof File && photo.size) formData.set('licence', await shrinkImage(photo), 'licence.jpg');
  return formData;
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

let navGoogleInit = false;
async function initNavGoogle() {
  const btn = document.getElementById('navGoogleBtn');
  if (!btn || navGoogleInit) return;
  navGoogleInit = true;
  const ok = await renderGoogleButton(btn, async (credential) => {
    try {
      const r = await api('/auth/google', { method: 'POST', body: { credential } });
      if (r.user) {
        mePromise = Promise.resolve(r.user);
        updateNav(r.user);
        const next = new URLSearchParams(location.search).get('next');
        if (next && next.startsWith('/') && !next.startsWith('//')) {
          window.location.href = next;
        } else if (location.pathname === '/login' || location.pathname === '/register') {
          window.location.href = isStaff(r.user) ? '/admin' : '/account';
        } else {
          window.location.reload();
        }
      }
    } catch (err) {
      toast(err.message || 'Google sign-in failed. Please try again.', 'error');
    }
  }, 'signin_with', { size: 'medium', width: 215, shape: 'pill', theme: 'outline' });

  if (!ok) {
    btn.innerHTML = '<a href="/login" class="btn btn-small google-fallback-btn" data-testid="nav-login-fallback" data-agent-id="nav-login-fallback">Log in</a>';
  }
}

function updateNav(user) {
  document.querySelectorAll('[data-auth="guest"]').forEach((el) => { el.hidden = Boolean(user); });
  document.querySelectorAll('[data-auth="user"]').forEach((el) => { el.hidden = !user; });
  const account = document.getElementById('navAccount');
  if (account && user) {
    account.textContent = isStaff(user) ? 'Admin panel' : 'My account';
    account.href = isStaff(user) ? '/admin' : '/account';
  }
  const unread = document.getElementById('navUnread');
  if (unread) {
    unread.hidden = !user?.unreadMessages;
    unread.textContent = user?.unreadMessages || '';
  }
  if (user) {
    const img = document.getElementById('navAvatarImg');
    const initial = document.getElementById('navAvatarInitial');
    const name = document.getElementById('userMenuName');
    const email = document.getElementById('userMenuEmail');
    if (name) name.textContent = user.fullName || user.email || 'User';
    if (email) email.textContent = user.email || '';
    if (user.picture && img) {
      img.onerror = () => {
        img.hidden = true;
        if (initial) initial.hidden = false;
      };
      img.src = user.picture;
      img.hidden = false;
      if (initial) initial.hidden = true;
    } else if (initial) {
      initial.textContent = (user.fullName?.[0] || user.email?.[0] || 'U').toUpperCase();
      initial.hidden = false;
      if (img) img.hidden = true;
    }
  } else {
    initNavGoogle();
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

  const avatarBtn = document.getElementById('userAvatarBtn');
  const dropdown = document.getElementById('userMenuDropdown');
  if (avatarBtn && dropdown) {
    avatarBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = dropdown.hidden;
      dropdown.hidden = !open;
      avatarBtn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => {
      if (!dropdown.hidden && !e.target.closest('#userMenuWrapper')) {
        dropdown.hidden = true;
        avatarBtn.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !dropdown.hidden) {
        dropdown.hidden = true;
        avatarBtn.setAttribute('aria-expanded', 'false');
        avatarBtn.focus();
      }
    });
  }

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
