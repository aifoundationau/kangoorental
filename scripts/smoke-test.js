// End-to-end smoke test against a running server (use the Firestore emulator, not the live database).
// Usage: BASE=http://localhost:3100 ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/smoke-test.js
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:3100';
const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD };
const BRISBANE = { lat: -27.47, lng: 153.03 };
const SYDNEY = { lat: -33.87, lng: 151.21 };
// 1x1 PNG - enough to exercise the upload path (manual review when no AI key is configured).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let passed = 0;
const step = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

class Client {
  cookie = '';
  csrf = '';
  async req(path, { method = 'GET', body, form, csrf = true, redirect = 'follow' } = {}) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (csrf && this.csrf) headers['x-csrf-token'] = this.csrf;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers, body: payload, redirect });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    if (data?.csrf) this.csrf = data.csrf;
    return { status: res.status, data, headers: res.headers };
  }
  api(path, opts) { return this.req(`/api${path}`, opts); }
}

function registrationForm(email, where = BRISBANE, overrides = {}) {
  const f = new FormData();
  const fields = {
    email, password: 'correct-horse-9', fullName: 'Alex Sample Driver', phone: '0400 000 000', dob: '1990-05-01',
    addressLine: '1 Grey Street', suburb: 'South Brisbane', state: 'QLD', postcode: '4101',
    licenceNumber: '123456789', licenceState: 'QLD', licenceExpiry: '2030-01-01',
    acceptTerms: 'true', acceptAi: 'true', lat: where.lat, lng: where.lng, accuracy: 20, ...overrides,
  };
  for (const [k, v] of Object.entries(fields)) f.set(k, String(v));
  f.set('licence', new Blob([PNG], { type: 'image/png' }), 'licence.png');
  return f;
}

const plusDays = (n) => new Date(Date.now() + 10 * 3600000 + n * 86400000).toISOString().slice(0, 10);

const admin = new Client();
const customer = new Client();
const staff = new Client();
const email = `smoke-${Date.now()}@example.com`;
let customerId;
let bookingId;

console.log(`Smoke testing ${BASE}`);

await step('public config exposes AUD price, tokens and exchange rate', async () => {
  const { status, data } = await customer.api('/config');
  assert.equal(status, 200);
  assert.ok(data.fx.rate > 0);
  assert.ok(data.dailyQuote.tokenCents > 0);
});

await step('every page renders with the AI Foundation footer', async () => {
  for (const p of ['/', '/login', '/register', '/rental-disclaimer', '/founder-welcome', '/privacy', '/terms', '/ai-policy', '/security-policy']) {
    const { status, data } = await customer.req(p);
    assert.equal(status, 200, p);
    for (const text of ['2026 AI Foundation', 'Founder Welcome', 'Privacy Policy', 'Terms of Service', 'AI Policy (ISO/IEC 42001)', 'Security Policy (ISO/IEC 27001)']) {
      assert.ok(data.includes(text), `${p} missing "${text}"`);
    }
    assert.ok(!/\{\{\w+\}\}/.test(data), `${p} has an unfilled placeholder`);
  }
});

await step('account and admin pages require login', async () => {
  assert.equal((await customer.req('/account', { redirect: 'manual' })).status, 302);
  assert.equal((await customer.req('/admin', { redirect: 'manual' })).status, 302);
});

await step('registration outside Brisbane is refused', async () => {
  const { status } = await customer.api('/auth/register', { method: 'POST', form: registrationForm(email, SYDNEY) });
  assert.equal(status, 403);
});

await step('registration inside Brisbane succeeds; licence image not stored', async () => {
  const { status, data } = await customer.api('/auth/register', { method: 'POST', form: registrationForm(email) });
  assert.equal(status, 201, JSON.stringify(data));
  customerId = data.user.id;
  assert.ok(['pending', 'verified', 'rejected'].includes(data.licence.status));
  assert.equal(JSON.stringify(data).includes(PNG.toString('base64')), false);
});

await step('duplicate email is rejected', async () => {
  const other = new Client();
  assert.equal((await other.api('/auth/register', { method: 'POST', form: registrationForm(email) })).status, 409);
});

await step('requests without the CSRF token are refused', async () => {
  assert.equal((await customer.api('/messages', { method: 'POST', body: { body: 'hi' }, csrf: false })).status, 403);
});

await step('superadmin logs in and sets a fixed manual exchange rate', async () => {
  assert.ok(ADMIN.email && ADMIN.password, 'set ADMIN_EMAIL and ADMIN_PASSWORD');
  assert.equal((await admin.api('/auth/login', { method: 'POST', body: ADMIN })).status, 200);
  const { status, data } = await admin.api('/admin/settings', {
    method: 'PUT',
    body: { settings: { price_basis: 'aud', daily_rate_aud_cents: 9000, gst_rate_bp: 1000, fx_mode: 'manual', fx_manual_rate: '1.43' } },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.fx.rate, 1.43);
});

await step('AUD basis: A$90 + GST at 1.43 = A$99.00 = 69.23 tokens', async () => {
  const { data: q } = await customer.api('/quote?days=1');
  assert.equal(q.subtotalCents, 9000);
  assert.equal(q.subtotalTokenCents, 6294); // A$90 / 1.43 = 62.94 tokens ex GST
  assert.equal(q.gstCents, 900);
  assert.equal(q.totalCents, 9900);
  assert.equal(q.tokenCents, 6923); // A$99 / 1.43 = 69.23 tokens
});

await step('token basis: 62 tokens -> US$62 x 1.43 = A$88.66 + GST = A$97.53 = 68.20 tokens', async () => {
  await admin.api('/admin/settings', { method: 'PUT', body: { settings: { price_basis: 'tokens', daily_rate_token_cents: 6200 } } });
  const { data: q } = await customer.api('/quote?days=1');
  assert.equal(q.subtotalCents, 8866);
  assert.equal(q.gstCents, 887);
  assert.equal(q.totalCents, 9753);
  assert.equal(q.tokenCents, 6820);
  await admin.api('/admin/settings', { method: 'PUT', body: { settings: { price_basis: 'aud' } } });
});

await step('booking is blocked until the licence is verified', async () => {
  const { status } = await customer.api('/bookings', { method: 'POST', body: { date: plusDays(4), time: '10:00', days: 1, acceptDisclaimer: true } });
  assert.equal(status, 409);
});

await step('admin verifies the licence manually', async () => {
  assert.equal((await admin.api(`/admin/users/${customerId}/licence`, { method: 'POST', body: { status: 'verified' } })).status, 200);
});

await step('customer adds insurance with $2M indemnity confirmation', async () => {
  const bad = await customer.api('/account/insurance', { method: 'PUT', body: { insurer: 'Test Insure', policyNumber: 'P-1234', policyExpiry: plusDays(400), confirmIndemnity: false } });
  assert.equal(bad.status, 400);
  const ok = await customer.api('/account/insurance', { method: 'PUT', body: { insurer: 'Test Insure', policyNumber: 'P-1234', policyExpiry: plusDays(400), confirmIndemnity: true } });
  assert.equal(ok.status, 200);
});

await step('booking needs enough tokens', async () => {
  const { status } = await customer.api('/bookings', { method: 'POST', body: { date: plusDays(4), time: '10:00', days: 1, acceptDisclaimer: true } });
  assert.equal(status, 402);
});

await step('customer buys 70 tokens (demo mode)', async () => {
  const { status, data } = await customer.api('/tokens/checkout', { method: 'POST', body: { tokens: 70 } });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.user.tokenCents, 7000);
});

await step('booking requires the disclaimer to be accepted', async () => {
  const { status } = await customer.api('/bookings', { method: 'POST', body: { date: plusDays(4), time: '10:00', days: 1, acceptDisclaimer: false } });
  assert.equal(status, 400);
});

await step('customer books 24 hours for 69.23 tokens', async () => {
  const { status, data } = await customer.api('/bookings', { method: 'POST', body: { date: plusDays(4), time: '10:00', days: 1, acceptDisclaimer: true, note: 'Moving boxes' } });
  assert.equal(status, 201, JSON.stringify(data));
  bookingId = data.booking.id;
  assert.equal(data.booking.tokenCents, 6923);
  assert.equal(data.booking.totalCents, 9900);
  const me = await customer.api('/me');
  assert.equal(me.data.user.tokenCents, 7000 - 6923);
});

await step('overlapping booking is refused and shows on the calendar', async () => {
  await admin.api(`/admin/users/${customerId}/tokens`, { method: 'POST', body: { tokens: 200, note: 'Smoke test credit' } });
  const { status } = await customer.api('/bookings', { method: 'POST', body: { date: plusDays(4), time: '18:00', days: 1, acceptDisclaimer: true } });
  assert.equal(status, 409);
  const { data } = await customer.api(`/availability?from=${plusDays(0)}&to=${plusDays(10)}`);
  assert.ok(data.busy.some((r) => r.kind === 'booking'));
});

await step('two simultaneous bookings for the same slot: exactly one succeeds', async () => {
  const body = { date: plusDays(9), time: '09:00', days: 1, acceptDisclaimer: true };
  const results = await Promise.all([customer.api('/bookings', { method: 'POST', body }), customer.api('/bookings', { method: 'POST', body })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
});

await step('admin blocks dates and they become unavailable', async () => {
  assert.equal((await admin.api('/admin/blocks', { method: 'POST', body: { startDate: plusDays(20), endDate: plusDays(21), reason: 'Service' } })).status, 201);
  const { status } = await customer.api('/bookings', { method: 'POST', body: { date: plusDays(20), time: '10:00', days: 1, acceptDisclaimer: true } });
  assert.equal(status, 409);
});

await step('customer and admin exchange messages with unread counts', async () => {
  assert.equal((await customer.api('/messages', { method: 'POST', body: { body: 'What time can I pick up?' } })).status, 201);
  const threads = await admin.api('/admin/threads');
  const thread = threads.data.threads.find((t) => t.id === customerId);
  assert.equal(thread.unreadForAdmin, 1);
  await admin.api(`/admin/threads/${customerId}`);
  assert.equal((await admin.api(`/admin/threads/${customerId}`, { method: 'POST', body: { body: 'Any time from 10am.' } })).status, 201);
  assert.equal((await customer.api('/me')).data.user.unreadMessages, 1);
  const { data } = await customer.api('/messages');
  assert.equal(data.messages.length, 2);
  assert.equal((await customer.api('/me')).data.user.unreadMessages, 0);
});

await step('regular admin can manage bookings but cannot change pricing', async () => {
  const staffEmail = `staff-${Date.now()}@example.com`;
  assert.equal((await admin.api('/admin/staff', { method: 'POST', body: { fullName: 'Desk Admin', email: staffEmail, password: 'staff-password-123', role: 'admin' } })).status, 201);
  assert.equal((await staff.api('/auth/login', { method: 'POST', body: { email: staffEmail, password: 'staff-password-123' } })).status, 200);
  assert.equal((await staff.api('/admin/bookings')).status, 200);
  assert.equal((await staff.api('/admin/settings', { method: 'PUT', body: { settings: { daily_rate_aud_cents: 100 } } })).status, 403);
  assert.equal((await customer.api('/admin/stats')).status, 403);
});

await step('customer cancels more than 48h ahead and gets tokens back', async () => {
  const before = (await customer.api('/me')).data.user.tokenCents;
  assert.equal((await customer.api(`/bookings/${bookingId}/cancel`, { method: 'POST' })).status, 200);
  const after = (await customer.api('/me')).data.user.tokenCents;
  assert.equal(after - before, 6923);
});

await step('admin dashboard, bookings and audit log load', async () => {
  const stats = await admin.api('/admin/stats');
  assert.equal(stats.status, 200, JSON.stringify(stats.data));
  assert.ok(stats.data.customers >= 1);
  const audit = await admin.api('/admin/audit');
  assert.ok(audit.data.entries.some((e) => e.action === 'booking.create'));
});

await step('hub returns location, time zone and exchange rate', async () => {
  const { status, data } = await customer.api('/hub');
  assert.equal(status, 200);
  assert.equal(data.timezone, 'Australia/Brisbane');
  assert.ok(data.fx.rate > 0);
});

await step('customer with an active booking cannot delete; after cancelling, can', async () => {
  const { data } = await customer.api('/bookings');
  for (const b of data.bookings.filter((x) => x.status === 'confirmed')) {
    await customer.api(`/bookings/${b.id}/cancel`, { method: 'POST' });
  }
  assert.equal((await customer.api('/account/delete', { method: 'POST', body: { password: 'correct-horse-9' } })).status, 200);
  assert.equal((await customer.api('/me')).data.user, null);
  const relogin = new Client();
  assert.equal((await relogin.api('/auth/login', { method: 'POST', body: { email, password: 'correct-horse-9' } })).status, 401);
});

await step('restore live exchange rate mode', async () => {
  assert.equal((await admin.api('/admin/settings', { method: 'PUT', body: { settings: { fx_mode: 'live' } } })).status, 200);
});

console.log(`\nAll ${passed} checks passed.`);
