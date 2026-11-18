import { api, getConfig, isStaff, showError, setBusy } from './common.js';

const OAUTH_ERRORS = {
  google_cancelled: 'Google sign-in was cancelled. You can try again anytime.',
  google_state: 'Google sign-in session expired or did not match. Please try again.',
  google_disabled: 'This account is disabled. Please contact us.',
  google_unavailable: 'Google sign-in is not configured on this server.',
  google_failed: 'Google sign-in failed. Please try again.',
};

function goAfterLogin(user) {
  const next = new URLSearchParams(location.search).get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;
  const pending = sessionStorage.getItem('kangoo.pendingBooking');
  window.location.href = safeNext || (isStaff(user) ? '/admin' : pending ? '/#book' : '/account');
}

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('loginForm');
  const errEl = document.getElementById('loginError');
  const params = new URLSearchParams(location.search);

  const errCode = params.get('error');
  if (errCode && OAUTH_ERRORS[errCode]) {
    showError(errEl, new Error(OAUTH_ERRORS[errCode]));
  }

  const next = params.get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '';
  const oauthBtn = document.getElementById('googleOAuthBtn');
  if (oauthBtn && safeNext) {
    oauthBtn.href = `/api/auth/google/start?next=${encodeURIComponent(safeNext)}`;
  }

  const cfg = await getConfig().catch(() => null);
  const googleBlock = document.querySelector('[data-google]');
  if (googleBlock) googleBlock.hidden = !cfg?.googleOAuthEnabled;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(errEl, null);
    const btn = document.getElementById('loginBtn');
    setBusy(btn, true, 'Logging in…');
    try {
      const { user } = await api('/auth/login', {
        method: 'POST',
        body: { email: form.email.value, password: form.password.value },
      });
      goAfterLogin(user);
    } catch (err) {
      showError(errEl, err);
      setBusy(btn, false);
    }
  });
});
