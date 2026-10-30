import { api, showError, setBusy } from './common.js';

const $ = (id) => document.getElementById(id);
let coords = null;

function unlock(on) {
  $('detailsStep').disabled = !on;
  $('licenceStep').disabled = !on;
  $('regBtn').disabled = !on;
}

function requestLocation() {
  const status = $('geoStatus');
  status.className = 'geo-status';
  if (!navigator.geolocation) {
    status.textContent = 'Your browser does not support location, so we cannot register you online. Please contact us.';
    status.classList.add('bad');
    return;
  }
  status.textContent = 'Checking your location…';
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    try {
      const r = await api('/geo/check', { method: 'POST', body: { lat, lng } });
      if (r.inArea) {
        coords = { lat, lng, accuracy };
        status.textContent = `You're about ${r.distanceKm} km from our depot. You can register.`;
        status.classList.add('good');
        $('geoBtn').hidden = true;
        unlock(true);
        $('fullName').focus();
      } else {
        status.textContent = `You're about ${r.distanceKm} km away. Registration is only open within ${r.radiusKm} km of our depot.`;
        status.classList.add('bad');
        unlock(false);
      }
    } catch (err) {
      status.textContent = err.message;
      status.classList.add('bad');
    }
  }, (err) => {
    status.textContent = err.code === err.PERMISSION_DENIED
      ? 'Location permission was denied. Allow location for this site in your browser settings, then try again.'
      : 'We could not get your location. Please try again.';
    status.classList.add('bad');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

document.addEventListener('DOMContentLoaded', () => {
  unlock(false);
  $('geoBtn').addEventListener('click', requestLocation);

  const form = $('registerForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('regError');
    showError(errEl, null);
    if (!coords) return showError(errEl, new Error('Please share your location first.'));
    if (!form.reportValidity()) return;

    const data = new FormData(form);
    data.set('lat', coords.lat);
    data.set('lng', coords.lng);
    data.set('accuracy', coords.accuracy);
    const btn = $('regBtn');
    setBusy(btn, true, 'Checking your licence…');
    try {
      const { licence } = await api('/auth/register', { method: 'POST', form: data });
      sessionStorage.setItem('kangoo.licenceResult', JSON.stringify(licence));
      const pending = sessionStorage.getItem('kangoo.pendingBooking');
      window.location.href = pending && licence.status === 'verified' ? '/#book' : '/account?welcome=1';
    } catch (err) {
      showError(errEl, err);
      setBusy(btn, false);
    }
  });
});
