import { api, isStaff, showError, setBusy, renderGoogleButton } from './common.js';

function goAfterLogin(user) {
  const next = new URLSearchParams(location.search).get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;
  const pending = sessionStorage.getItem('kangoo.pendingBooking');
  window.location.href = safeNext || (isStaff(user) ? '/admin' : pending ? '/#book' : '/account');
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('loginForm');
  const errEl = document.getElementById('loginError');

  renderGoogleButton(document.getElementById('googleBtn'), async (credential) => {
    showError(errEl, null);
    try {
      const r = await api('/auth/google', { method: 'POST', body: { credential } });
      if (r.needsRegistration) {
        // New customer: carry the Google sign-in over to registration.
        sessionStorage.setItem('kangoo.google', JSON.stringify({ credential, ...r.profile }));
        window.location.href = '/register';
        return;
      }
      goAfterLogin(r.user);
    } catch (err) {
      showError(errEl, err);
    }
  }, 'signin_with');

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
