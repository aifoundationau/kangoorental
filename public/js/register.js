import { api, showError, setBusy, withShrunkLicence, renderGoogleButton } from './common.js';

const $ = (id) => document.getElementById(id);
const GOOGLE_KEY = 'kangoo.google';
let google = null; // { credential, email, fullName } when signing up with Google

// Signing up with Google: use the Google email, skip the password.
function applyGoogle(profile) {
  google = profile;
  sessionStorage.setItem(GOOGLE_KEY, JSON.stringify(profile));
  if (!$('fullName').value) $('fullName').value = profile.fullName || '';
  $('email').value = profile.email;
  $('email').readOnly = true;
  const pw = $('password');
  pw.required = false;
  pw.closest('.field').hidden = true;
  document.querySelector('[data-google]').hidden = true;
  const note = $('googleLinked');
  note.textContent = `Signing up with Google as ${profile.email}. Fill in the rest below.`;
  note.hidden = false;
}

document.addEventListener('DOMContentLoaded', () => {
  const saved = JSON.parse(sessionStorage.getItem(GOOGLE_KEY) || 'null');
  if (saved?.credential) applyGoogle(saved);
  else {
    renderGoogleButton($('googleBtn'), async (credential) => {
      try {
        const r = await api('/auth/google', { method: 'POST', body: { credential } });
        if (r.needsRegistration) return applyGoogle({ credential, ...r.profile });
        window.location.href = '/account'; // already registered: now logged in
      } catch (err) {
        showError($('regError'), err);
      }
    }, 'signup_with');
  }

  const form = $('registerForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('regError');
    showError(errEl, null);
    if (!form.reportValidity()) return;

    const data = new FormData(form);
    if (google) {
      data.set('googleCredential', google.credential);
      data.delete('password');
    }
    const btn = $('regBtn');
    setBusy(btn, true, 'Checking your licence…');
    try {
      const { licence } = await api('/auth/register', { method: 'POST', form: await withShrunkLicence(data) });
      sessionStorage.removeItem(GOOGLE_KEY);
      sessionStorage.setItem('kangoo.licenceResult', JSON.stringify(licence));
      const pending = sessionStorage.getItem('kangoo.pendingBooking');
      window.location.href = pending && licence.status === 'verified' ? '/#book' : '/account?welcome=1';
    } catch (err) {
      // Google sign-ins expire after about an hour; start the Google step again.
      if (google && err.status === 401) {
        sessionStorage.removeItem(GOOGLE_KEY);
        err.message += ' Reload the page to sign in with Google again.';
      }
      showError(errEl, err);
      setBusy(btn, false);
    }
  });
});
