import { api, isStaff, showError, setBusy } from './common.js';

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('loginForm');
  const errEl = document.getElementById('loginError');
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
      const next = new URLSearchParams(location.search).get('next');
      const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;
      const pending = sessionStorage.getItem('kangoo.pendingBooking');
      window.location.href = safeNext || (isStaff(user) ? '/admin' : pending ? '/#book' : '/account');
    } catch (err) {
      showError(errEl, err);
      setBusy(btn, false);
    }
  });
});
