import { Router } from 'express';
import {
  firestore, col, allDocs, docData, nowIso, getSettings, setSettings, audit, FieldValue,
} from '../db.js';
import { HttpError, requireAdmin, requireSuperadmin, hashPassword, destroyAllSessions } from '../security.js';
import {
  str, int, validDate, brisbaneToday, brisbaneDate, brisbaneTime, addDays, quote, floorWhole, maxRentalDays, handoverRules,
  isHandoverDay, PATTERNS,
} from '../util.js';
import { currentRate, refreshLiveRate } from '../fx.js';
import { publicUser, getUser, createUser } from './auth.js';
import { cancelBooking } from './bookings.js';
import { postMessage, readThread } from './account.js';

export const router = Router();
router.use('/admin', requireAdmin);

const customerView = (u) => publicUser(u, {
  disabled: Boolean(u.disabled),
  regDistanceKm: u.regDistanceKm,
  licenceMethod: u.licenceMethod,
});

/* ---------- Dashboard ---------- */

router.get('/admin/stats', async (req, res) => {
  const now = Date.now();
  const since = new Date(now - 30 * 86400000).toISOString();
  const customers = col.users.where('role', '==', 'supporter');
  const [customerCount, pending, liveBookings, threads, purchases, tokens] = await Promise.all([
    customers.where('disabled', '==', false).count().get(),
    customers.where('licenceStatus', '==', 'pending').count().get(),
    col.bookings.where('status', 'in', ['confirmed', 'active']).get(),
    col.threads.where('unreadForAdmin', '>', 0).get(),
    col.tokenTransactions.where('createdAt', '>=', since).get(),
    customers.select('tokenCents').get(),
  ]);
  const live = allDocs(liveBookings);
  res.json({
    customers: customerCount.data().count,
    pendingLicences: pending.data().count,
    upcomingBookings: live.filter((b) => b.status === 'confirmed' && b.startAt > now).length,
    activeBookings: live.filter((b) => b.status === 'active').length,
    unreadMessages: threads.docs.reduce((n, d) => n + d.data().unreadForAdmin, 0),
    revenueUsdCents30d: allDocs(purchases)
      .filter((t) => t.kind === 'purchase' && t.provider === 'stripe')
      .reduce((n, t) => n + (t.amountCents || 0), 0),
    tokenCentsOutstanding: tokens.docs.reduce((n, d) => n + (d.data().tokenCents || 0), 0),
  });
});

/* ---------- Settings: pricing, currency conversion and site options (superadmin) ---------- */

const wholeCents = (cents) => floorWhole(cents / 100) * 100;

const SETTING_RULES = {
  business_name: (v) => str(v, { field: 'Business name', max: 80 }),
  price_basis: (v) => {
    if (!['aud', 'tokens'].includes(v)) throw new HttpError(400, 'Price basis must be AUD or tokens.');
    return v;
  },
  // Prices are whole dollars and whole tokens, rounded down.
  // Total price for a 1, 2, 3... day hire, whole AUD ex GST (comma-separated). Longer hires can't cost less.
  price_table: (v) => {
    const prices = String(v).split(',').map((s) => floorWhole(Number(s.trim())));
    if (prices.length < 1 || prices.length > 30 || prices.some((n) => !(n >= 1 && n <= 100000))) {
      throw new HttpError(400, 'Enter a price of at least A$1 for every hire length.');
    }
    if (prices.some((n, i) => i > 0 && n < prices[i - 1])) throw new HttpError(400, "A longer hire can't cost less than a shorter one.");
    return prices.join(',');
  },
  daily_rate_token_cents: (v) => wholeCents(int(v, { field: 'Daily rate (tokens)', min: 100, max: 10000000 })),
  gst_rate_bp: (v) => int(v, { field: 'GST rate', min: 0, max: 5000 }),
  fx_mode: (v) => {
    if (!['live', 'manual'].includes(v)) throw new HttpError(400, 'Exchange rate mode must be live or manual.');
    return v;
  },
  fx_manual_rate: (v) => {
    const n = Number(v);
    if (!(n >= 0.5 && n <= 5)) throw new HttpError(400, 'Manual exchange rate must be between 0.5 and 5 AUD per USD.');
    return n.toFixed(4);
  },
  token_packs: (v) => {
    const packs = String(v).split(',').map((s) => Number(s.trim()));
    if (!packs.length || packs.some((n) => !Number.isInteger(n) || n < 1 || n > 5000)) {
      throw new HttpError(400, 'Token packs must be comma-separated whole numbers between 1 and 5000.');
    }
    return packs.join(',');
  },
  min_driver_age: (v) => int(v, { field: 'Minimum driver age', min: 16, max: 99 }),
  registration_radius_km: (v) => int(v, { field: 'Booking radius', min: 1, max: 2000 }),
  pickup_label: (v) => str(v, { field: 'Pickup location', max: 160 }),
  pickup_lat: (v) => { const n = Number(v); if (!(n >= -90 && n <= 90)) throw new HttpError(400, 'Latitude is invalid.'); return n; },
  pickup_lng: (v) => { const n = Number(v); if (!(n >= -180 && n <= 180)) throw new HttpError(400, 'Longitude is invalid.'); return n; },
  cancellation_hours: (v) => int(v, { field: 'Cancellation window', min: 0, max: 720 }),
  buffer_hours: (v) => int(v, { field: 'Turnaround buffer', min: 0, max: 48 }),
  min_notice_hours: (v) => int(v, { field: 'Minimum notice', min: 0, max: 720 }),
  max_rental_days: (v) => int(v, { field: 'Maximum rental days', min: 1, max: 90 }),
  // Pickup and return days: the usual week (0 = Sunday ... 6 = Saturday) and single-date changes ("2026-11-03:0").
  handover_weekdays: (v) => {
    const days = [...new Set(String(v).split(',').filter((s) => s.trim() !== '').map(Number))];
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new HttpError(400, 'Weekdays must be numbers from 0 (Sunday) to 6 (Saturday).');
    return days.sort().join(',');
  },
  handover_overrides: (v) => {
    const entries = String(v).split(',').map((s) => s.trim()).filter(Boolean);
    if (entries.length > 2000) throw new HttpError(400, 'Too many pickup-day changes. Remove some older ones.');
    const today = brisbaneToday();
    const kept = new Map();
    for (const entry of entries) {
      const [date, open] = entry.split(':');
      validDate(date, 'Pickup day');
      if (open !== '0' && open !== '1') throw new HttpError(400, 'Each pickup-day change must be on (1) or off (0).');
      if (date >= today) kept.set(date, open); // past dates no longer matter
    }
    return [...kept].sort(([a], [b]) => a.localeCompare(b)).map(([date, open]) => `${date}:${open}`).join(',');
  },
  max_advance_days: (v) => int(v, { field: 'Maximum advance days', min: 1, max: 730 }),
  first_pickup_hour: (v) => int(v, { field: 'First pickup hour', min: 0, max: 23 }),
  last_pickup_hour: (v) => int(v, { field: 'Last pickup hour', min: 0, max: 23 }),
  required_indemnity_cents: (v) => wholeCents(int(v, { field: 'Required indemnity', min: 0, max: 100000000000 })),
  contact_email: (v) => str(v, { field: 'Contact email', required: false, max: 120 }),
  contact_phone: (v) => str(v, { field: 'Contact phone', required: false, max: 30 }),
  announcement: (v) => str(v, { field: 'Announcement', required: false, max: 300 }),
};

function cleanSettings(updates) {
  const clean = {};
  for (const [key, value] of Object.entries(updates || {})) {
    if (!SETTING_RULES[key]) throw new HttpError(400, `Unknown setting: ${key}`);
    clean[key] = SETTING_RULES[key](value);
  }
  return clean;
}

function pricingView(settings) {
  const fx = currentRate(settings);
  const list = Array.from({ length: maxRentalDays(settings) }, (_, i) => quote(settings, i + 1, fx.rate));
  return { settings, fx, dailyQuote: list[0], list };
}

router.get('/admin/settings', async (req, res) => res.json(pricingView(await getSettings())));

router.put('/admin/settings', requireSuperadmin, async (req, res) => {
  const clean = cleanSettings(req.body?.settings);
  const merged = { ...(await getSettings()), ...clean };
  if (Number(merged.first_pickup_hour) > Number(merged.last_pickup_hour)) {
    throw new HttpError(400, 'First pickup hour must be before the last pickup hour.');
  }
  await setSettings(clean);
  audit(req.user.id, 'settings.update', Object.entries(clean).map(([k, v]) => `${k}=${v}`).join(' '), req.ip);
  if (clean.fx_mode === 'live') await refreshLiveRate();
  res.json(pricingView(await getSettings()));
});

// Shows what customers would pay with unsaved pricing changes, using the same formula as bookings.
router.post('/admin/pricing/preview', requireSuperadmin, async (req, res) => {
  res.json(pricingView({ ...(await getSettings()), ...cleanSettings(req.body?.settings) }));
});

router.post('/admin/fx/refresh', requireSuperadmin, async (req, res) => {
  if (!(await refreshLiveRate())) throw new HttpError(502, 'Could not reach the exchange rate feeds. The previous rate is still in use.');
  const settings = await getSettings();
  audit(req.user.id, 'fx.refresh', settings.fx_live_rate, req.ip);
  res.json(pricingView(settings));
});

/* ---------- Bookings ---------- */

router.get('/admin/bookings', async (req, res) => {
  const status = String(req.query.status || '');
  const query = ['confirmed', 'active', 'completed', 'cancelled'].includes(status)
    ? col.bookings.where('status', '==', status)
    : col.bookings.orderBy('startAt', 'desc').limit(500);
  const rows = allDocs(await query.get()).sort((a, b) => b.startAt - a.startAt).slice(0, 500);
  res.json({ bookings: rows });
});

router.post('/admin/bookings/:id/status', async (req, res) => {
  const id = String(req.params.id);
  const status = String(req.body?.status || '');
  const note = str(req.body?.note, { field: 'Note', required: false, max: 500 });

  if (status === 'cancelled') {
    await cancelBooking(id, {
      refundTokenCents: (b) => (req.body?.refund === true ? b.tokenCents : 0),
      byUserId: req.user.id,
      ip: req.ip,
      reason: note,
    });
  } else {
    const ref = col.bookings.doc(id);
    const booking = await firestore.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) throw new HttpError(404, 'Booking not found.');
      const b = snap.data();
      const allowed = { confirmed: ['active'], active: ['completed'] };
      if (!allowed[b.status]?.includes(status)) throw new HttpError(409, `Cannot change a ${b.status} booking to ${status}.`);
      t.update(ref, { status, ...(note ? { adminNote: note } : {}), [`${status}At`]: nowIso() });
      // Completing early frees the calendar, so touch the lock like other booking changes.
      t.set(col.locks.doc('calendar'), { updatedAt: nowIso() });
      return b;
    });
    audit(req.user.id, 'booking.status', `${booking.ref} -> ${status}`, req.ip);
  }
  res.json({ booking: docData(await col.bookings.doc(id).get()) });
});

/* ---------- Pickup and return days ---------- */

/** The rules, plus upcoming bookings that now pick up or return on a day that isn't available. */
async function handoverView() {
  const rules = handoverRules(await getSettings());
  const now = Date.now();
  const conflicts = allDocs(await col.bookings.where('status', '==', 'confirmed').get())
    .filter((b) => b.startAt > now)
    .map((b) => {
      const pickup = brisbaneDate(b.startAt);
      const dropoff = brisbaneDate(b.endAt);
      return { id: b.id, ref: b.ref, name: b.userName, pickup, dropoff, pickupOk: isHandoverDay(rules, pickup), dropoffOk: isHandoverDay(rules, dropoff) };
    })
    .filter((b) => !b.pickupOk || !b.dropoffOk)
    .sort((a, b) => a.pickup.localeCompare(b.pickup));
  return { ...rules, today: brisbaneToday(), conflicts };
}

router.get('/admin/handover', async (req, res) => res.json(await handoverView()));

router.put('/admin/handover', requireSuperadmin, async (req, res) => {
  const { weekdays, overrides } = req.body || {};
  if (!Array.isArray(weekdays) || typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    throw new HttpError(400, 'Send the usual weekdays and the date changes.');
  }
  const clean = cleanSettings({
    handover_weekdays: weekdays.join(','),
    handover_overrides: Object.entries(overrides).map(([date, open]) => `${date}:${open === true ? 1 : 0}`).join(','),
  });
  await setSettings(clean);
  audit(req.user.id, 'handover.update', `weekdays=${clean.handover_weekdays} changes=${clean.handover_overrides || 'none'}`.slice(0, 500), req.ip);
  res.json(await handoverView());
});

/* ---------- Calendar blocks ---------- */

/** Current and future blocks, plus upcoming bookings that overlap a blocked day (blocking doesn't cancel them). */
async function blocksView() {
  const today = brisbaneToday();
  const blocks = allDocs(await col.blocks.where('endDate', '>=', today).get())
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const ranges = blocks.map((b) => [brisbaneTime(b.startDate), brisbaneTime(addDays(b.endDate, 1))]);
  const now = Date.now();
  const conflicts = allDocs(await col.bookings.where('status', 'in', ['confirmed', 'active']).get())
    .filter((b) => b.endAt > now && ranges.some(([start, end]) => b.startAt < end && b.endAt > start))
    .map((b) => ({ id: b.id, ref: b.ref, name: b.userName, pickup: brisbaneDate(b.startAt), dropoff: brisbaneDate(b.endAt) }))
    .sort((a, b) => a.pickup.localeCompare(b.pickup));
  return { blocks, today, conflicts };
}

router.get('/admin/blocks', async (req, res) => res.json(await blocksView()));

// One click on the Block out dates calendar: takes the van off the road for that whole day, or puts it back.
// Sets the day's state (rather than flipping it), so repeating a request is harmless.
router.put('/admin/blocks/day', async (req, res) => {
  const date = validDate(req.body?.date, 'Date');
  if (typeof req.body?.blocked !== 'boolean') throw new HttpError(400, 'Say whether the day is blocked.');
  if (date < brisbaneToday()) throw new HttpError(400, "Past dates can't be changed.");
  const blocked = req.body.blocked;
  await firestore.runTransaction(async (t) => {
    const covering = (await t.get(col.blocks.where('endDate', '>=', date))).docs.filter((d) => d.data().startDate <= date);
    if (blocked && !covering.length) {
      t.create(col.blocks.doc(), { startDate: date, endDate: date, reason: null, createdAt: nowIso(), createdBy: req.user.id });
    }
    if (!blocked) {
      // Unblocking one day of a longer block keeps the days either side blocked.
      for (const doc of covering) {
        const b = doc.data();
        t.delete(doc.ref);
        const keep = (startDate, endDate) => t.create(col.blocks.doc(), { ...b, startDate, endDate });
        if (b.startDate < date) keep(b.startDate, addDays(date, -1));
        if (b.endDate > date) keep(addDays(date, 1), b.endDate);
      }
    }
  });
  audit(req.user.id, blocked ? 'block.create' : 'block.delete', date, req.ip);
  res.json(await blocksView());
});

router.post('/admin/blocks', async (req, res) => {
  const startDate = validDate(req.body?.startDate, 'Start date');
  const endDate = validDate(req.body?.endDate, 'End date');
  if (endDate < startDate) throw new HttpError(400, 'End date must be on or after the start date.');
  const reason = str(req.body?.reason, { field: 'Reason', required: false, max: 200 });
  await col.blocks.add({ startDate, endDate, reason: reason || null, createdAt: nowIso(), createdBy: req.user.id });
  audit(req.user.id, 'block.create', `${startDate}..${endDate}`, req.ip);
  res.status(201).json({ ok: true });
});

router.delete('/admin/blocks/:id', async (req, res) => {
  await col.blocks.doc(String(req.params.id)).delete();
  audit(req.user.id, 'block.delete', req.params.id, req.ip);
  res.json({ ok: true });
});

/* ---------- Customers ---------- */

router.get('/admin/users', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let users = allDocs(await col.users.where('role', '==', 'supporter').get());
  if (q) {
    users = users.filter((u) => [u.fullName, u.email, u.licenceNumber, u.phone]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  }
  users.sort((a, b) => (b.licenceStatus === 'pending') - (a.licenceStatus === 'pending') || b.createdAt.localeCompare(a.createdAt));
  res.json({ users: users.slice(0, 300).map(customerView) });
});

router.get('/admin/users/:id', async (req, res) => {
  const u = await getUser(req.params.id);
  if (!u || u.role !== 'supporter') throw new HttpError(404, 'Customer not found.');
  const [bookings, transactions] = await Promise.all([
    col.bookings.where('userId', '==', u.id).get(),
    col.tokenTransactions.where('userId', '==', u.id).get(),
  ]);
  res.json({
    user: customerView(u),
    bookings: allDocs(bookings).sort((a, b) => b.startAt - a.startAt),
    transactions: allDocs(transactions).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100),
  });
});

async function requireCustomer(id) {
  const u = await getUser(id);
  if (!u || u.role !== 'supporter') throw new HttpError(404, 'Customer not found.');
  return u;
}

router.post('/admin/users/:id/licence', async (req, res) => {
  const u = await requireCustomer(req.params.id);
  const status = String(req.body?.status || '');
  if (!['verified', 'rejected', 'pending'].includes(status)) throw new HttpError(400, 'Invalid licence status.');
  const notes = str(req.body?.notes, { field: 'Notes', required: false, max: 300 }) ||
    (status === 'verified' ? 'Verified by our team.' : status === 'rejected' ? 'Rejected by our team. Please message us.' : '');
  await col.users.doc(u.id).update({ licenceStatus: status, licenceNotes: notes, licenceMethod: 'manual', licenceCheckedAt: nowIso() });
  audit(req.user.id, 'licence.manual', `user ${u.id} -> ${status}`, req.ip);
  res.json({ ok: true });
});

router.post('/admin/users/:id/tokens', async (req, res) => {
  const id = String(req.params.id);
  // Whole tokens only, e.g. 10 or -5.
  const tokens = Number(req.body?.tokens);
  if (!Number.isInteger(tokens) || tokens === 0 || Math.abs(tokens) > 100000) {
    throw new HttpError(400, 'Enter a non-zero whole number of tokens, e.g. 10 or -5.');
  }
  const delta = tokens * 100;
  const note = str(req.body?.note, { field: 'Reason', min: 3, max: 200 });
  await firestore.runTransaction(async (t) => {
    const ref = col.users.doc(id);
    const snap = await t.get(ref);
    if (!snap.exists || snap.data().role !== 'supporter') throw new HttpError(404, 'Customer not found.');
    if ((snap.data().tokenCents || 0) + delta < 0) throw new HttpError(400, 'Balance cannot go below zero.');
    t.update(ref, { tokenCents: FieldValue.increment(delta) });
    t.create(col.tokenTransactions.doc(), {
      userId: id, deltaCents: delta, kind: 'adjustment', provider: 'admin', note, createdBy: req.user.id, createdAt: nowIso(),
    });
  });
  audit(req.user.id, 'tokens.adjust', `user ${id} ${tokens}: ${note}`, req.ip);
  res.json({ ok: true });
});

router.post('/admin/users/:id/disabled', async (req, res) => {
  const u = await requireCustomer(req.params.id);
  const disabled = req.body?.disabled === true;
  await col.users.doc(u.id).update({ disabled });
  if (disabled) await destroyAllSessions(u.id);
  audit(req.user.id, disabled ? 'user.disable' : 'user.enable', `user ${u.id}`, req.ip);
  res.json({ ok: true });
});

/* ---------- Message inbox ---------- */

router.get('/admin/threads', async (req, res) => {
  const threads = allDocs(await col.threads.orderBy('lastAt', 'desc').limit(200).get());
  res.json({ threads });
});

router.get('/admin/threads/:userId', async (req, res) => {
  const u = await requireCustomer(req.params.userId);
  const messages = await readThread(u.id);
  if (messages.length) await col.threads.doc(u.id).set({ unreadForAdmin: 0 }, { merge: true });
  res.json({ user: customerView(u), messages });
});

router.post('/admin/threads/:userId', async (req, res) => {
  const u = await requireCustomer(req.params.userId);
  const body = str(req.body?.body, { field: 'Message', min: 1, max: 2000 });
  await postMessage(u, 'admin', body);
  res.status(201).json({ ok: true });
});

/* ---------- Staff accounts (superadmin) ---------- */

router.get('/admin/staff', requireSuperadmin, async (req, res) => {
  const staff = allDocs(await col.users.where('role', 'in', ['admin', 'superadmin']).get())
    .map(({ id, role, email, fullName, disabled, createdAt }) => ({ id, role, email, fullName, disabled: Boolean(disabled), createdAt }))
    .sort((a, b) => b.role.localeCompare(a.role) || a.createdAt.localeCompare(b.createdAt));
  res.json({ staff });
});

router.post('/admin/staff', requireSuperadmin, async (req, res) => {
  const email = str(req.body?.email, { field: 'Email', pattern: PATTERNS.email, max: 120 }).toLowerCase();
  const fullName = str(req.body?.fullName, { field: 'Name', min: 2, max: 120 });
  const role = req.body?.role === 'superadmin' ? 'superadmin' : 'admin';
  const password = String(req.body?.password || '');
  if (password.length < 12) throw new HttpError(400, 'Staff passwords must be at least 12 characters.');
  await createUser({ role, email, fullName, passwordHash: await hashPassword(password) });
  audit(req.user.id, 'staff.create', `${role} ${email}`, req.ip);
  res.status(201).json({ ok: true });
});

router.post('/admin/staff/:id/disabled', requireSuperadmin, async (req, res) => {
  const id = String(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'You cannot disable your own account.');
  const u = await getUser(id);
  if (!u || !['admin', 'superadmin'].includes(u.role)) throw new HttpError(404, 'Staff member not found.');
  const disabled = req.body?.disabled === true;
  await col.users.doc(id).update({ disabled });
  if (disabled) await destroyAllSessions(id);
  audit(req.user.id, disabled ? 'staff.disable' : 'staff.enable', `user ${id}`, req.ip);
  res.json({ ok: true });
});

/* ---------- Audit log ---------- */

router.get('/admin/audit', async (req, res) => {
  res.json({ entries: allDocs(await col.auditLog.orderBy('createdAt', 'desc').limit(300).get()) });
});
