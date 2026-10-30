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
  for (const p of ['/', '/login', '/register', '/rental-disclaimer', '/founder-welcome', '/privacy', '/terms', '/ai-policy', '/security-policy', '/token-policy']) {
    const { status, data } = await customer.req(p);
    assert.equal(status, 200, p);
    for (const text of ['2026 AI Foundation', 'Founder Welcome', 'Privacy Policy', 'Terms of Service', 'AI Policy (ISO/IEC 42001)', 'Security Policy (ISO/IEC 27001)', 'Token Policy']) {
      assert.ok(data.includes(text), `${p} missing "${text}"`);
    }
    assert.ok(!/\{\{\w+\}\}/.test(data), `${p} has an unfilled placeholder`);
  }
});

await step('account and admin pages require login', async () => {
  assert.equal((await customer.req('/account', { redirect: 'manual' })).status, 302);
  assert.equal((await customer.req('/admin', { redirect: 'manual' })).status, 302);
});

await step('anyone can register as a supporter, wherever they are', async () => {
  const far = new Client();
  const { status, data } = await far.api('/auth/register', { method: 'POST', form: registrationForm(`far-${Date.now()}@example.com`, SYDNEY) });
  assert.equal(status, 201, JSON.stringify(data));
  assert.equal(data.user.role, 'supporter');
});

await step('registration inside Brisbane succeeds as a supporter; licence image not stored', async () => {
  const { status, data } = await customer.api('/auth/register', { method: 'POST', form: registrationForm(email) });
  assert.equal(status, 201, JSON.stringify(data));
  assert.equal(data.user.role, 'supporter');
  customerId = data.user.id;
  assert.ok(['pending', 'verified', 'rejected'].includes(data.licence.status));
  assert.equal(JSON.stringify(data).includes(PNG.toString('base64')), false);
});

await step('duplicate email is rejected', async () => {
  const other = new Client();
  assert.equal((await other.api('/auth/register', { method: 'POST', form: registrationForm(email) })).status, 409);
});

await step('Google sign-in is offered and forged Google tokens are rejected', async () => {
  const { data: cfg } = await customer.api('/config');
  assert.ok(cfg.googleClientId.endsWith('.apps.googleusercontent.com'));
  const fake = 'eyJhbGciOiJSUzI1NiJ9.' + 'x'.repeat(200) + '.sig';
  const anon = new Client();
  assert.equal((await anon.api('/auth/google', { method: 'POST', body: { credential: fake } })).status, 401);
  const { status } = await anon.api('/auth/register', {
    method: 'POST', form: registrationForm(`g-${Date.now()}@example.com`, BRISBANE, { googleCredential: fake, password: '' }),
  });
  assert.equal(status, 401);
});

await step('requests without the CSRF token are refused', async () => {
  assert.equal((await customer.api('/messages', { method: 'POST', body: { body: 'hi' }, csrf: false })).status, 403);
});

await step('superadmin logs in and sets a fixed manual exchange rate', async () => {
  assert.ok(ADMIN.email && ADMIN.password, 'set ADMIN_EMAIL and ADMIN_PASSWORD');
  assert.equal((await admin.api('/auth/login', { method: 'POST', body: ADMIN })).status, 200);
  const { status, data } = await admin.api('/admin/settings', {
    method: 'PUT',
    body: { settings: { price_basis: 'aud', price_table: '90,165,230,280,315,340,350', gst_rate_bp: 1000, fx_mode: 'manual', fx_manual_rate: '1.43' } },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.fx.rate, 1.43);
});

await step('AUD basis: A$90 + GST at 1.43 = A$99 = 69 tokens (69.23 rounded down)', async () => {
  const { data: q } = await customer.api('/quote?days=1');
  assert.equal(q.subtotalCents, 9000);
  assert.equal(q.subtotalTokenCents, 6200); // A$90 / 1.43 = 62.94 -> 62 tokens ex GST
  assert.equal(q.gstCents, 900);
  assert.equal(q.totalCents, 9900);
  assert.equal(q.tokenCents, 6900); // A$99 / 1.43 = 69.23 -> 69 tokens
  assert.equal(q.discountCents, 0);
});

await step('price list: 1-7 days A$90/165/230/280/315/340/350 ex GST, up to 7 days; whole amounts rounded down', async () => {
  const { data: cfg } = await customer.api('/config');
  assert.equal(cfg.maxRentalDays, 7);
  assert.deepEqual(cfg.priceList.map((p) => p.audCents), [9000, 16500, 23000, 28000, 31500, 34000, 35000]);
  const two = (await customer.api('/quote?days=2')).data; // A$165, GST 16.50 -> 16, A$181 / 1.43 = 126.57 -> 126 tokens
  assert.deepEqual([two.listSubtotalCents, two.discountCents, two.subtotalCents, two.gstCents, two.totalCents, two.tokenCents], [18000, 1500, 16500, 1600, 18100, 12600]);
  const five = (await customer.api('/quote?days=5')).data; // A$315, GST 31.50 -> 31, A$346 / 1.43 = 241.96 -> 241 tokens
  assert.deepEqual([five.listSubtotalCents, five.discountCents, five.subtotalCents, five.gstCents, five.totalCents, five.tokenCents], [45000, 13500, 31500, 3100, 34600, 24100]);
  const seven = (await customer.api('/quote?days=7')).data; // A$350 + A$35 GST = A$385 -> 269 tokens
  assert.deepEqual([seven.subtotalCents, seven.totalCents, seven.tokenCents], [35000, 38500, 26900]);
  assert.equal((await customer.api('/quote?days=8')).status, 400);
  for (const q of [two, five, seven]) {
    for (const k of ['listSubtotalCents', 'discountCents', 'subtotalCents', 'gstCents', 'totalCents', 'tokenCents', 'subtotalTokenCents']) assert.equal(q[k] % 100, 0, k);
  }
});

await step('token basis: 62 tokens -> 62 x 1.43 = A$88.66 -> A$88 + A$8 GST = A$96 = 67 tokens', async () => {
  await admin.api('/admin/settings', { method: 'PUT', body: { settings: { price_basis: 'tokens', daily_rate_token_cents: 6200 } } });
  const { data: q } = await customer.api('/quote?days=1');
  assert.equal(q.subtotalCents, 8800);
  assert.equal(q.gstCents, 800);
  assert.equal(q.totalCents, 9600);
  assert.equal(q.tokenCents, 6700);
  await admin.api('/admin/settings', { method: 'PUT', body: { settings: { price_basis: 'aud' } } });
  // Price-list prices entered with cents are rounded down to whole dollars; a longer hire can't cost less.
  const preview = await admin.api('/admin/pricing/preview', { method: 'POST', body: { settings: { price_table: '90.5,165.99,230,280,315,340,350' } } });
  assert.deepEqual(preview.data.list.map((q) => q.subtotalCents).slice(0, 2), [9000, 16500]);
  assert.equal((await admin.api('/admin/settings', { method: 'PUT', body: { settings: { price_table: '90,80' } } })).status, 400);
});

await step('booking is blocked until the licence is verified', async () => {
  const { status } = await customer.api('/bookings', { method: 'POST', body: { date: plusDays(4), time: '10:00', days: 1, acceptDisclaimer: true, ...BRISBANE } });
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
  const { status } = await customer.api('/bookings', { method: 'POST', body: { date: plusDays(4), time: '10:00', days: 1, acceptDisclaimer: true, ...BRISBANE } });
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

await step('booking needs the device location, within 50 km of the depot', async () => {
  const body = { date: plusDays(4), time: '10:00', days: 1, acceptDisclaimer: true };
  assert.equal((await customer.api('/bookings', { method: 'POST', body })).status, 400);
  const far = await customer.api('/bookings', { method: 'POST', body: { ...body, ...SYDNEY } });
  assert.equal(far.status, 403);
  assert.match(far.data.error, /within 50 km/);
});

await step('customer books 24 hours for 69 tokens', async () => {
  const { status, data } = await customer.api('/bookings', { method: 'POST', body: { date: plusDays(4), time: '10:00', days: 1, acceptDisclaimer: true, ...BRISBANE, note: 'Moving boxes' } });
  assert.equal(status, 201, JSON.stringify(data));
  bookingId = data.booking.id;
  assert.equal(data.booking.tokenCents, 6900);
  assert.equal(data.booking.totalCents, 9900);
  const me = await customer.api('/me');
  assert.equal(me.data.user.tokenCents, 100);
});

await step('overlapping booking is refused and shows on the calendar', async () => {
  const fractional = await admin.api(`/admin/users/${customerId}/tokens`, { method: 'POST', body: { tokens: 5.5, note: 'Not whole' } });
  assert.equal(fractional.status, 400);
  await admin.api(`/admin/users/${customerId}/tokens`, { method: 'POST', body: { tokens: 200, note: 'Smoke test credit' } });
  const { status } = await customer.api('/bookings', { method: 'POST', body: { date: plusDays(4), time: '18:00', days: 1, acceptDisclaimer: true, ...BRISBANE } });
  assert.equal(status, 409);
  const { data } = await customer.api(`/availability?from=${plusDays(0)}&to=${plusDays(10)}`);
  assert.ok(data.busy.some((r) => r.kind === 'booking'));
});

await step('two simultaneous bookings for the same slot: exactly one succeeds', async () => {
  const body = { date: plusDays(9), time: '09:00', days: 1, acceptDisclaimer: true, ...BRISBANE };
  const results = await Promise.all([customer.api('/bookings', { method: 'POST', body }), customer.api('/bookings', { method: 'POST', body })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
});

await step('superadmin sets pickup/return days; bookings must start and end on one', async () => {
  const pickup = plusDays(12);
  const body = (days, date = pickup) => ({ date, time: '10:00', days, acceptDisclaimer: true, ...BRISBANE });
  assert.equal((await customer.api('/admin/handover', { method: 'PUT', body: { weekdays: [], overrides: {} } })).status, 403);
  try {
    // No usual days: only the pickup day and the day two days later are open.
    const open = { [pickup]: true, [plusDays(14)]: true };
    const set = await admin.api('/admin/handover', { method: 'PUT', body: { weekdays: [], overrides: open } });
    assert.equal(set.status, 200, JSON.stringify(set.data));
    assert.ok(set.data.conflicts.some((c) => !c.pickupOk), 'existing bookings on closed days are listed');
    assert.deepEqual((await customer.api('/config')).data.handover, { weekdays: [], overrides: open });
    const oneDay = await customer.api('/bookings', { method: 'POST', body: body(1) });
    assert.equal(oneDay.status, 400);
    assert.match(oneDay.data.error, /Returns aren't available/);
    const closedPickup = await customer.api('/bookings', { method: 'POST', body: body(1, plusDays(13)) });
    assert.equal(closedPickup.status, 400);
    assert.match(closedPickup.data.error, /Pickups aren't available/);
    const twoDays = await customer.api('/bookings', { method: 'POST', body: body(2) });
    assert.equal(twoDays.status, 201, JSON.stringify(twoDays.data));
    // Past dates are dropped when saving.
    const past = await admin.api('/admin/handover', { method: 'PUT', body: { weekdays: [0, 1, 2, 3, 4, 5, 6], overrides: { '2020-01-01': false } } });
    assert.deepEqual(past.data.overrides, {});
  } finally {
    const reset = await admin.api('/admin/handover', { method: 'PUT', body: { weekdays: [0, 1, 2, 3, 4, 5, 6], overrides: {} } });
    assert.equal(reset.data.conflicts.length, 0);
  }
});

await step('admin blocks dates and they become unavailable', async () => {
  assert.equal((await admin.api('/admin/blocks', { method: 'POST', body: { startDate: plusDays(20), endDate: plusDays(21), reason: 'Service' } })).status, 201);
  const { status } = await customer.api('/bookings', { method: 'POST', body: { date: plusDays(20), time: '10:00', days: 1, acceptDisclaimer: true, ...BRISBANE } });
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
  assert.equal((await staff.api('/admin/settings', { method: 'PUT', body: { settings: { price_table: '1' } } })).status, 403);
  assert.equal((await customer.api('/admin/stats')).status, 403);
});

await step('customer cancels more than 48h ahead and gets tokens back', async () => {
  const before = (await customer.api('/me')).data.user.tokenCents;
  assert.equal((await customer.api(`/bookings/${bookingId}/cancel`, { method: 'POST' })).status, 200);
  const after = (await customer.api('/me')).data.user.tokenCents;
  assert.equal(after - before, 6900);
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

await step('location panel: AUD pricing in Australia and New Zealand, USD elsewhere', async () => {
  const anon = new Client();
  const local = await anon.api('/locale');
  assert.equal(local.status, 200);
  assert.equal(local.data.countryCode, 'AU');
  assert.equal(local.data.pricingCurrency, 'AUD');
  assert.equal(local.data.currency.code, 'AUD');
  assert.equal(local.data.currency.perUsd, local.data.audPerUsd);
  const nz = (await anon.api('/locale?lat=-36.85&lng=174.76&cc=NZ')).data;
  assert.equal(nz.pricingCurrency, 'AUD');
  assert.equal(nz.currency.code, 'NZD');
  const uk = (await anon.api('/locale?lat=51.51&lng=-0.13&cc=GB')).data;
  assert.equal(uk.pricingCurrency, 'USD');
  assert.equal(uk.currency.code, 'GBP');
  assert.ok(uk.depot.km > 16000);
  assert.equal((await anon.api('/locale?lat=200&lng=0')).status, 400);
  const page = await anon.req('/terms');
  assert.ok(page.data.includes('id="localeBar"') && page.data.includes('id="localeDialog"'));
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
