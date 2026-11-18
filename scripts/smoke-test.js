// End-to-end smoke test against a running server (use the Firestore emulator, not the live database).
// Usage: BASE=http://localhost:3100 ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/smoke-test.js
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:3100';
const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD };
const ARUNDEL = { lat: -27.94, lng: 153.36 };
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

function registrationForm(email, where = ARUNDEL, overrides = {}) {
  const f = new FormData();
  const fields = {
    email, password: 'correct-horse-9', fullName: 'Alex Sample Driver', phone: '0400 000 000', dob: '1990-05-01',
    addressLine: '1 Allied Drive', suburb: 'Arundel', state: 'QLD', postcode: '4214',
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

await step('public config exposes AUD-only pricing and Arundel pickup location', async () => {
  const { status, data } = await customer.api('/config');
  assert.equal(status, 200);
  assert.equal(data.currency, 'AUD');
  assert.equal(data.pickup.label, 'Arundel QLD 4214');
  assert.equal(data.fx, undefined);
  assert.equal(data.tokenPacks, undefined);
  assert.equal(data.priceBasis, undefined);
  assert.equal(data.dailyQuote.currency, 'AUD');
  assert.ok(data.dailyQuote.totalCents > 0);
});

await step('every page renders in AUD-only mode without USD, FX, or Token Policy leaks', async () => {
  for (const p of ['/', '/login', '/register', '/rental-disclaimer', '/founder-welcome', '/privacy', '/terms', '/ai-policy', '/security-policy']) {
    const { status, data } = await customer.req(p);
    assert.equal(status, 200, p);
    for (const text of ['2026 AI Foundation', 'Founder Welcome', 'Privacy Policy', 'Terms of Service', 'AI Policy (ISO/IEC 42001)', 'Security Policy (ISO/IEC 27001)']) {
      assert.ok(data.includes(text), `${p} missing "${text}"`);
    }
    assert.ok(!data.includes('Token Policy'), `${p} still links Token Policy`);
    assert.ok(!data.includes('US$'), `${p} still mentions US$`);
    assert.ok(!data.includes('Exchange rate'), `${p} still mentions Exchange rate`);
    assert.ok(!/\{\{\w+\}\}/.test(data), `${p} has an unfilled placeholder`);
  }
  assert.equal((await customer.req('/token-policy')).status, 404);
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
  assert.equal(data.user.tokenCents, undefined);
});

await step('registration inside Arundel / Gold Coast succeeds as a supporter; licence image not stored', async () => {
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

await step('Google OAuth 2.0 button, PKCE start/callback state checks, and forged ID tokens rejected', async () => {
  const { data: cfg } = await customer.api('/config');
  assert.ok(cfg.googleClientId.endsWith('.apps.googleusercontent.com'));
  assert.equal(cfg.googleOAuthEnabled, true);

  const home = await customer.req('/');
  assert.ok(home.data.includes('href="/api/auth/google/start"') && home.data.includes('id="navGoogleBtn"'));

  const anon = new Client();
  const start = await anon.api('/auth/google/start', { redirect: 'manual' });
  assert.equal(start.status, 302);
  const loc = start.headers.get('location') || '';
  assert.ok(loc.startsWith('https://accounts.google.com/o/oauth2/v2/auth'), loc);
  assert.ok(loc.includes('client_id=') && loc.includes('code_challenge=') && loc.includes('state=') && loc.includes('redirect_uri='), loc);
  assert.ok(start.headers.getSetCookie().some((c) => c.startsWith('kr_goauth=')), 'sets OAuth state cookie');

  const badCb = await anon.api('/auth/google/callback?code=fake&state=wrong', { redirect: 'manual' });
  assert.equal(badCb.status, 302);
  assert.equal(badCb.headers.get('location'), '/login?error=google_state');

  const fake = 'eyJhbGciOiJSUzI1NiJ9.' + 'x'.repeat(200) + '.sig';
  assert.equal((await anon.api('/auth/google', { method: 'POST', body: { credential: fake } })).status, 401);
  const { status } = await anon.api('/auth/register', {
    method: 'POST', form: registrationForm(`g-${Date.now()}@example.com`, ARUNDEL, { googleCredential: fake, password: '' }),
  });
  assert.equal(status, 401);
});

await step('requests without the CSRF token are refused and removed token/FX endpoints return 404', async () => {
  assert.equal((await customer.api('/messages', { method: 'POST', body: { body: 'hi' }, csrf: false })).status, 403);
  assert.equal((await customer.api('/tokens/checkout', { method: 'POST', body: { tokens: 10 } })).status, 404);
});

await step('superadmin sets AUD pricing and rejects removed FX/token keys', async () => {
  assert.ok(ADMIN.email && ADMIN.password, 'set ADMIN_EMAIL and ADMIN_PASSWORD');
  assert.equal((await admin.api('/auth/login', { method: 'POST', body: ADMIN })).status, 200);
  assert.equal((await admin.api('/admin/fx/refresh', { method: 'POST' })).status, 404);
  assert.equal((await admin.api('/admin/settings', { method: 'PUT', body: { settings: { fx_mode: 'manual' } } })).status, 400);
  assert.equal((await admin.api('/admin/settings', { method: 'PUT', body: { settings: { token_table: '99' } } })).status, 400);

  const { status, data } = await admin.api('/admin/settings', {
    method: 'PUT',
    body: {
      settings: {
        price_table: '90,171,257,342,428,513,599',
        discount_table: '0,5,5,5,5,5,5',
        gst_rate_bp: 1000,
      },
    },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.currency, 'AUD');
});

await step('AUD & 10% GST quote math: 1 day AUD$90 + AUD$9 GST = AUD$99', async () => {
  const { data: q } = await customer.api('/quote?days=1');
  assert.equal(q.currency, 'AUD');
  assert.equal(q.subtotalCents, 9000);
  assert.equal(q.gstCents, 900);
  assert.equal(q.totalCents, 9900);
  assert.equal(q.discountCents, 0);
});

await step('price list: 1-7 days with exact 10% GST cents and multi-day discounts', async () => {
  const { data: cfg } = await customer.api('/config');
  assert.equal(cfg.maxRentalDays, 7);
  assert.deepEqual(cfg.priceList.map((p) => p.subtotalCents), [9000, 17100, 25700, 34200, 42800, 51300, 59900]);
  assert.deepEqual(cfg.priceList.map((p) => p.totalCents), [9900, 18810, 28270, 37620, 47080, 56430, 65890]);

  const two = (await customer.api('/quote?days=2')).data;
  assert.deepEqual([two.listSubtotalCents, two.discountCents, two.subtotalCents, two.gstCents, two.totalCents], [18000, 900, 17100, 1710, 18810]);
  const five = (await customer.api('/quote?days=5')).data;
  assert.deepEqual([five.listSubtotalCents, five.discountCents, five.subtotalCents, five.gstCents, five.totalCents], [45000, 2200, 42800, 4280, 47080]);
  const seven = (await customer.api('/quote?days=7')).data;
  assert.deepEqual([seven.subtotalCents, seven.gstCents, seven.totalCents], [59900, 5990, 65890]);
  assert.equal((await customer.api('/quote?days=8')).status, 400);

  const preview = await admin.api('/admin/pricing/preview', { method: 'POST', body: { settings: { price_table: '90.5,171.99,257,342,428,513,599' } } });
  assert.deepEqual(preview.data.list.map((q) => q.subtotalCents).slice(0, 2), [9000, 17100]);
  assert.equal((await admin.api('/admin/settings', { method: 'PUT', body: { settings: { price_table: '90,80' } } })).status, 400);
});

await step('booking is blocked until the licence is verified', async () => {
  const { status } = await customer.api('/bookings', { method: 'POST', body: { date: plusDays(4), time: '10:00', days: 1, acceptDisclaimer: true, ...ARUNDEL } });
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

await step('customer books 1 day directly in AUD (demo mode) and payment ledger records it', async () => {
  const { status, data } = await customer.api('/bookings', { method: 'POST', body: { date: plusDays(4), time: '10:00', days: 1, acceptDisclaimer: true, ...ARUNDEL, note: 'Moving boxes' } });
  assert.equal(status, 201, JSON.stringify(data));
  bookingId = data.booking.id;
  assert.equal(data.booking.currency, 'AUD');
  assert.equal(data.booking.subtotalCents, 9000);
  assert.equal(data.booking.gstCents, 900);
  assert.equal(data.booking.totalCents, 9900);
  assert.equal(data.booking.paidAudCents, 9900);
  assert.equal(data.booking.paymentStatus, 'paid');
  assert.equal(data.booking.paymentProvider, 'demo');

  const payRes = await customer.api('/account/payments');
  assert.equal(payRes.status, 200);
  assert.equal(payRes.data.payments.length, 1);
  assert.equal(payRes.data.payments[0].kind, 'payment');
  assert.equal(payRes.data.payments[0].amountCents, 9900);
  assert.equal(payRes.data.payments[0].currency, 'AUD');
});

await step('overlapping booking is refused and shows on the calendar', async () => {
  const { status } = await customer.api('/bookings', { method: 'POST', body: { date: plusDays(4), time: '18:00', days: 1, acceptDisclaimer: true, ...ARUNDEL } });
  assert.equal(status, 409);
  const { data } = await customer.api(`/availability?from=${plusDays(0)}&to=${plusDays(10)}`);
  assert.ok(data.busy.some((r) => r.kind === 'booking'));
});

await step('two simultaneous bookings for the same slot: exactly one succeeds', async () => {
  const body = { date: plusDays(9), time: '09:00', days: 1, acceptDisclaimer: true, ...ARUNDEL };
  const results = await Promise.all([customer.api('/bookings', { method: 'POST', body }), customer.api('/bookings', { method: 'POST', body })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
});

await step('superadmin sets pickup/return days; bookings must start and end on one', async () => {
  const pickup = plusDays(12);
  const body = (days, date = pickup) => ({ date, time: '10:00', days, acceptDisclaimer: true, ...ARUNDEL });
  assert.equal((await customer.api('/admin/handover', { method: 'PUT', body: { weekdays: [], overrides: {} } })).status, 403);
  try {
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
    assert.equal(twoDays.data.booking.totalCents, 18810);
    const past = await admin.api('/admin/handover', { method: 'PUT', body: { weekdays: [0, 1, 2, 3, 4, 5, 6], overrides: { '2020-01-01': false } } });
    assert.deepEqual(past.data.overrides, {});
  } finally {
    const reset = await admin.api('/admin/handover', { method: 'PUT', body: { weekdays: [0, 1, 2, 3, 4, 5, 6], overrides: {} } });
    assert.equal(reset.data.conflicts.length, 0);
  }
});

await step('admin blocks dates and they become unavailable', async () => {
  assert.equal((await admin.api('/admin/blocks', { method: 'POST', body: { startDate: plusDays(20), endDate: plusDays(21), reason: 'Service' } })).status, 201);
  const { status } = await customer.api('/bookings', { method: 'POST', body: { date: plusDays(20), time: '10:00', days: 1, acceptDisclaimer: true, ...ARUNDEL } });
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

await step('customer cancels more than 48h ahead and receives full AUD refund in ledger', async () => {
  assert.equal((await customer.api(`/bookings/${bookingId}/cancel`, { method: 'POST' })).status, 200);
  const { data: bk } = await customer.api('/bookings');
  const cancelled = bk.bookings.find((b) => b.id === bookingId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.paymentStatus, 'refunded');
  assert.equal(cancelled.refundedAudCents, 9900);

  const { data: payData } = await customer.api('/account/payments');
  const refundRow = payData.payments.find((p) => p.bookingId === bookingId && p.kind === 'refund');
  assert.ok(refundRow);
  assert.equal(refundRow.amountCents, -9900);
  assert.equal(refundRow.currency, 'AUD');
});

await step('admin dashboard, customer payments and audit log load in AUD only', async () => {
  const stats = await admin.api('/admin/stats');
  assert.equal(stats.status, 200, JSON.stringify(stats.data));
  assert.ok(stats.data.customers >= 1);
  assert.equal(stats.data.revenueUsdCents30d, undefined);
  assert.equal(stats.data.tokenCentsOutstanding, undefined);
  assert.ok(stats.data.revenueAudCents30d >= 0);

  const detail = await admin.api(`/admin/users/${customerId}`);
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(detail.data.payments));

  const audit = await admin.api('/admin/audit');
  assert.ok(audit.data.entries.some((e) => e.action === 'booking.create'));
});

await step('distribution ledger: both contractors view; Car Shop logs cash; superadmin settles and exports CSV', async () => {
  assert.equal((await customer.api('/admin/ledger')).status, 403);
  const sView = await staff.api('/admin/ledger');
  assert.equal(sView.status, 200, JSON.stringify(sView.data));
  assert.equal(sView.data.config.contractorA.name, 'David Robertson');
  assert.equal(sView.data.config.contractorA.sharePct, 50);
  assert.equal(sView.data.config.contractorB.name, 'Car Shop (TBD)');
  assert.equal(sView.data.config.contractorB.sharePct, 50);
  assert.equal(sView.data.config.gstBasis, 'ex_gst');

  assert.equal((await staff.api('/admin/ledger/config', { method: 'PUT', body: { contractor_a_share_pct: 60, contractor_b_share_pct: 40 } })).status, 403);
  assert.equal((await staff.api('/admin/ledger/distributions', {
    method: 'POST',
    body: { fromContractor: 'contractor_a', toContractor: 'contractor_b', amountAud: 10, note: 'Unauthorized payout' },
  })).status, 403);

  const beforeOwed = sView.data.summary.owedAToBCents;
  const cashRes = await staff.api('/admin/ledger/cash', {
    method: 'POST',
    body: { amountAud: 198, note: 'Cash walk-in hire', bookingRef: 'CASH-1' },
  });
  assert.equal(cashRes.status, 201, JSON.stringify(cashRes.data));
  const cashId = cashRes.data.entry.id;
  assert.equal(cashRes.data.entry.grossAudCents, 19800);
  assert.equal(cashRes.data.entry.gstAudCents, 1800);
  assert.equal(cashRes.data.entry.netExGstAudCents, 18000);
  assert.equal(cashRes.data.entry.collectedBy, 'contractor_b');
  assert.equal(cashRes.data.ledger.summary.owedAToBCents, beforeOwed - 9000);

  assert.equal((await staff.api(`/admin/ledger/${cashId}`, { method: 'DELETE' })).status, 403);

  assert.equal((await admin.api('/admin/ledger/config', {
    method: 'PUT',
    body: { contractor_a_share_pct: 60, contractor_b_share_pct: 50 },
  })).status, 400);
  const split60 = await admin.api('/admin/ledger/config', {
    method: 'PUT',
    body: { contractor_a_share_pct: 60, contractor_b_share_pct: 40 },
  });
  assert.equal(split60.status, 200);
  assert.equal(split60.data.config.contractorA.sharePct, 60);
  const split50 = await admin.api('/admin/ledger/config', {
    method: 'PUT',
    body: { contractor_a_share_pct: 50, contractor_b_share_pct: 50 },
  });
  assert.equal(split50.status, 200);

  const set = split50.data.summary.settlement;
  assert.ok(set.amountCents > 0);
  const distRes = await admin.api('/admin/ledger/distributions', {
    method: 'POST',
    body: {
      fromContractor: set.from,
      toContractor: set.to,
      amountAud: set.amountCents / 100,
      method: 'bank_transfer',
      reference: 'EFT-SMOKE',
      note: 'Settlement distribution',
    },
  });
  assert.equal(distRes.status, 201, JSON.stringify(distRes.data));
  const distId = distRes.data.entry.id;
  assert.equal(distRes.data.ledger.summary.owedAToBCents, 0);
  assert.equal(distRes.data.ledger.summary.settlement.amountCents, 0);

  const csvRes = await staff.api('/admin/ledger/export.csv');
  assert.equal(csvRes.status, 200);
  assert.ok(csvRes.headers.get('content-type').includes('text/csv'));
  assert.ok(csvRes.data.includes('David Robertson') && csvRes.data.includes('Cash walk-in hire'));

  assert.equal((await admin.api(`/admin/ledger/${distId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await admin.api(`/admin/ledger/${cashId}`, { method: 'DELETE' })).status, 200);
});

await step('hub returns location, time zone and AUD currency only', async () => {
  const { status, data } = await customer.api('/hub');
  assert.equal(status, 200);
  assert.equal(data.timezone, 'Australia/Brisbane');
  assert.equal(data.currency, 'AUD');
  assert.equal(data.fx, undefined);
});

await step('location panel is strictly AUD everywhere (AU, NZ, GB)', async () => {
  const anon = new Client();
  const local = await anon.api('/locale');
  assert.equal(local.status, 200);
  assert.equal(local.data.countryCode, 'AU');
  assert.equal(local.data.pricingCurrency, 'AUD');
  assert.equal(local.data.currency.code, 'AUD');
  const nz = (await anon.api('/locale?lat=-36.85&lng=174.76&cc=NZ')).data;
  assert.equal(nz.pricingCurrency, 'AUD');
  assert.equal(nz.currency.code, 'AUD');
  const uk = (await anon.api('/locale?lat=51.51&lng=-0.13&cc=GB')).data;
  assert.equal(uk.pricingCurrency, 'AUD');
  assert.equal(uk.currency.code, 'AUD');
  assert.ok(uk.depot.km > 16000);
  assert.equal((await anon.api('/locale?lat=200&lng=0')).status, 400);
  const page = await anon.req('/terms');
  assert.ok(page.data.includes('id="localeBar"') && page.data.includes('id="localeDialog"'));
});

await step('customer with an active booking cannot delete; after cancelling, can', async () => {
  assert.equal((await customer.api('/account/delete', { method: 'POST', body: { password: 'correct-horse-9' } })).status, 409);
  const { data } = await customer.api('/bookings');
  for (const b of data.bookings.filter((x) => x.status === 'confirmed')) {
    await customer.api(`/bookings/${b.id}/cancel`, { method: 'POST' });
  }
  assert.equal((await customer.api('/account/delete', { method: 'POST', body: { password: 'correct-horse-9' } })).status, 200);
  assert.equal((await customer.api('/me')).data.user, null);
  const relogin = new Client();
  assert.equal((await relogin.api('/auth/login', { method: 'POST', body: { email, password: 'correct-horse-9' } })).status, 401);
});

await step('restore default AUD price_table and discount_table', async () => {
  assert.equal((await admin.api('/admin/settings', { method: 'PUT', body: { settings: { price_table: '90,171,257,342,428,513,599', discount_table: '0,5,5,5,5,5,5' } } })).status, 200);
});

console.log(`\nAll ${passed} checks passed.`);
