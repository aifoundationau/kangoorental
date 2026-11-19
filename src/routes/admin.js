import { Router } from 'express';
import {
  firestore, col, allDocs, docData, nowIso, getSettings, setSettings, audit, FieldValue,
} from '../db.js';
import { HttpError, requireAdmin, requireSuperadmin, hashPassword, destroyAllSessions, isStaff } from '../security.js';
import {
  str, int, validDate, brisbaneToday, brisbaneDate, brisbaneTime, addDays, quote, floorWhole, maxRentalDays, handoverRules,
  isHandoverDay, PATTERNS, formatAud,
} from '../util.js';
import { computeLedger, ledgerToCsv, splitGstFromGross } from '../ledger.js';
import { publicUser, getUser, createUser } from './auth.js';
import { cancelBooking } from './bookings.js';
import { postMessage, readThread, MESSAGE_RETENTION_YEARS } from './account.js';

export const router = Router();
router.use('/admin', requireAdmin);

const customerView = (u, { full = false } = {}) => publicUser(u, {
  disabled: Boolean(u.disabled),
  deletedAt: u.deletedAt || null,
  regDistanceKm: u.regDistanceKm,
  licenceMethod: u.licenceMethod,
  ...(full ? {
    licenceExtracted: u.licenceExtracted || null,
    acceptedTermsAt: u.acceptedTermsAt || null,
    acceptedAiCheckAt: u.acceptedAiCheckAt || null,
  } : {}),
});

/* ---------- Dashboard ---------- */

router.get('/admin/stats', async (req, res) => {
  const now = Date.now();
  const since = new Date(now - 30 * 86400000).toISOString();
  const customers = col.users.where('role', '==', 'supporter');
  const [customerCount, pending, liveBookings, threads, paymentSnap, allPaymentsSnap, ledgerSnap, settings] = await Promise.all([
    customers.where('disabled', '==', false).count().get(),
    customers.where('licenceStatus', '==', 'pending').count().get(),
    col.bookings.where('status', 'in', ['confirmed', 'active']).get(),
    col.threads.where('unreadForAdmin', '>', 0).get(),
    col.payments.where('createdAt', '>=', since).get(),
    col.payments.get(),
    col.ledgerEntries.get(),
    getSettings(),
  ]);
  const live = allDocs(liveBookings);
  const revenueAudCents30d = allDocs(paymentSnap).reduce((n, p) => n + (p.amountCents || 0), 0);
  const ledger = computeLedger({
    payments: allDocs(allPaymentsSnap),
    ledgerEntries: allDocs(ledgerSnap),
    settings,
  });
  res.json({
    customers: customerCount.data().count,
    pendingLicences: pending.data().count,
    upcomingBookings: live.filter((b) => b.status === 'confirmed' && b.startAt > now).length,
    activeBookings: live.filter((b) => b.status === 'active').length,
    unreadMessages: threads.docs.reduce((n, d) => n + d.data().unreadForAdmin, 0),
    revenueAudCents30d,
    owedAToBCents: ledger.summary.owedAToBCents,
    settlement: ledger.summary.settlement,
  });
});

/* ---------- Settings: AUD pricing and site options (superadmin) ---------- */

const wholeCents = (cents) => floorWhole(cents / 100) * 100;

const SETTING_RULES = {
  business_name: (v) => str(v, { field: 'Business name', max: 80 }),
  // Total price for a 1, 2, 3... day hire, whole AUD ex GST (comma-separated). Longer hires can't cost less.
  price_table: (v) => {
    const prices = String(v).split(',').map((s) => Math.floor(Number(s.trim())));
    if (prices.length < 1 || prices.length > 30 || prices.some((n) => !(n >= 1 && n <= 100000))) {
      throw new HttpError(400, 'Enter a price of at least AUD$1 for every hire length.');
    }
    if (prices.some((n, i) => i > 0 && n < prices[i - 1])) throw new HttpError(400, "A longer hire can't cost less than a shorter one.");
    return prices.join(',');
  },
  discount_table: (v) => {
    const discounts = String(v).split(',').map((s) => Number(s.trim()));
    if (discounts.length < 1 || discounts.length > 30 || discounts.some((n) => !Number.isFinite(n) || n < 0 || n > 99)) {
      throw new HttpError(400, 'Enter a valid discount percentage between 0 and 99 for each hire length.');
    }
    return discounts.map((n) => Math.round(n * 100) / 100).join(',');
  },
  gst_rate_bp: (v) => int(v, { field: 'GST rate', min: 0, max: 5000 }),
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
  first_return_hour: (v) => int(v, { field: 'First drop-off hour', min: 0, max: 23 }),
  last_return_hour: (v) => int(v, { field: 'Last drop-off hour', min: 0, max: 23 }),
  required_indemnity_cents: (v) => wholeCents(int(v, { field: 'Required indemnity', min: 0, max: 100000000000 })),
  contact_email: (v) => str(v, { field: 'Contact email', required: false, max: 120 }),
  contact_phone: (v) => str(v, { field: 'Contact phone', required: false, max: 30 }),
  announcement: (v) => str(v, { field: 'Announcement', required: false, max: 300 }),
  contractor_a_name: (v) => str(v, { field: 'Contractor A name', min: 2, max: 80 }),
  contractor_a_role: (v) => str(v, { field: 'Contractor A responsibilities', min: 2, max: 200 }),
  contractor_a_share_pct: (v) => int(v, { field: 'Contractor A share (%)', min: 0, max: 100 }),
  contractor_b_name: (v) => str(v, { field: 'Contractor B name', min: 2, max: 80 }),
  contractor_b_role: (v) => str(v, { field: 'Contractor B responsibilities', min: 2, max: 200 }),
  contractor_b_share_pct: (v) => int(v, { field: 'Contractor B share (%)', min: 0, max: 100 }),
  distribution_gst_basis: (v) => {
    if (!['ex_gst', 'inc_gst'].includes(v)) throw new HttpError(400, 'Distribution GST basis must be ex_gst or inc_gst.');
    return v;
  },
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
  const list = Array.from({ length: maxRentalDays(settings) }, (_, i) => quote(settings, i + 1));
  return { settings, currency: 'AUD', dailyQuote: list[0], list };
}

router.get('/admin/settings', async (req, res) => res.json(pricingView(await getSettings())));

router.put('/admin/settings', requireSuperadmin, async (req, res) => {
  const clean = cleanSettings(req.body?.settings);
  const merged = { ...(await getSettings()), ...clean };
  if (Number(merged.first_pickup_hour) > Number(merged.last_pickup_hour)) {
    throw new HttpError(400, 'First pickup hour must be before the last pickup hour.');
  }
  if (Number(merged.first_return_hour) > Number(merged.last_return_hour)) {
    throw new HttpError(400, 'First drop-off hour must be before the last drop-off hour.');
  }
  if (Number(merged.contractor_a_share_pct) + Number(merged.contractor_b_share_pct) !== 100) {
    throw new HttpError(400, 'Contractor split percentages must add up to 100%.');
  }
  await setSettings(clean);
  audit(req.user.id, 'settings.update', Object.entries(clean).map(([k, v]) => `${k}=${v}`).join(' '), req.ip);
  res.json(pricingView(await getSettings()));
});

// Shows what customers would pay with unsaved pricing changes, using the same formula as bookings.
router.post('/admin/pricing/preview', requireSuperadmin, async (req, res) => {
  res.json(pricingView({ ...(await getSettings()), ...cleanSettings(req.body?.settings) }));
});

/* ---------- Bookings ---------- */

router.get('/admin/bookings', async (req, res) => {
  const status = String(req.query.status || '');
  const query = ['confirmed', 'active', 'completed', 'cancelled', 'pending_payment'].includes(status)
    ? col.bookings.where('status', '==', status)
    : col.bookings.orderBy('startAt', 'desc').limit(500);
  const rows = allDocs(await query.get())
    .filter((b) => (status ? b.status === status : b.status !== 'expired'))
    .sort((a, b) => b.startAt - a.startAt)
    .slice(0, 500);
  res.json({ bookings: rows });
});

router.post('/admin/bookings/:id/status', async (req, res) => {
  const id = String(req.params.id);
  const status = String(req.body?.status || '');
  const note = str(req.body?.note, { field: 'Note', required: false, max: 500 });

  if (status === 'cancelled') {
    await cancelBooking(id, {
      refundAudCents: (b) => (req.body?.refund === true ? (b.paidAudCents ?? b.totalCents) : 0),
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
  const status = String(req.query.status || '').trim().toLowerCase();
  const isSuper = req.user.role === 'superadmin';
  let users = allDocs(await col.users.get()).filter((u) => !isStaff(u) && (isSuper || !u.deletedAt));
  if (status === 'disabled') users = users.filter((u) => Boolean(u.disabled));
  else if (status === 'deleted') users = users.filter((u) => Boolean(u.deletedAt));
  else if (['pending', 'verified', 'rejected', 'unverified'].includes(status)) {
    users = users.filter((u) => u.licenceStatus === status);
  }
  if (q) {
    users = users.filter((u) => [
      u.fullName, u.email, u.licenceNumber, u.licenceCardNumber, u.phone,
      u.suburb, u.postcode, u.licenceAddressFront, u.licenceAddressBack,
    ].some((v) => String(v || '').toLowerCase().includes(q)));
  }
  users.sort((a, b) => (b.licenceStatus === 'pending') - (a.licenceStatus === 'pending') || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json({ users: users.slice(0, 500).map((u) => customerView(u, { full: isSuper })), total: users.length });
});

router.get('/admin/users/:id', async (req, res) => {
  const u = await requireCustomer(req.params.id);
  const isSuper = req.user.role === 'superadmin';
  const [bookings, payments] = await Promise.all([
    col.bookings.where('userId', '==', u.id).get(),
    col.payments.where('userId', '==', u.id).get(),
  ]);
  res.json({
    user: customerView(u, { full: isSuper }),
    bookings: allDocs(bookings).filter((b) => b.status !== 'expired').sort((a, b) => b.startAt - a.startAt),
    payments: allDocs(payments).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100),
  });
});

async function requireCustomer(id) {
  const u = await getUser(id);
  if (!u || isStaff(u)) throw new HttpError(404, 'Customer not found.');
  return u;
}

router.post('/admin/users/:id/licence', async (req, res) => {
  const u = await requireCustomer(req.params.id);
  if (u.deletedAt) throw new HttpError(409, 'Deleted accounts cannot be modified.');
  const status = String(req.body?.status || '');
  if (!['verified', 'rejected', 'pending'].includes(status)) throw new HttpError(400, 'Invalid licence status.');
  const notes = str(req.body?.notes, { field: 'Notes', required: false, max: 300 }) ||
    (status === 'verified' ? 'Verified by our team.' : status === 'rejected' ? 'Rejected by our team. Please message us.' : '');
  await col.users.doc(u.id).update({ licenceStatus: status, licenceNotes: notes, licenceMethod: 'manual', licenceCheckedAt: nowIso() });
  audit(req.user.id, 'licence.manual', `user ${u.id} -> ${status}`, req.ip);
  res.json({ ok: true });
});

router.post('/admin/users/:id/disabled', async (req, res) => {
  const u = await requireCustomer(req.params.id);
  if (u.deletedAt) throw new HttpError(409, 'Deleted accounts cannot be re-enabled.');
  const disabled = req.body?.disabled === true;
  await col.users.doc(u.id).update({ disabled });
  if (disabled) await destroyAllSessions(u.id);
  audit(req.user.id, disabled ? 'user.disable' : 'user.enable', `user ${u.id}`, req.ip);
  res.json({ ok: true });
});

router.delete('/admin/users/:id', requireSuperadmin, async (req, res) => {
  const u = await requireCustomer(req.params.id);
  if (u.deletedAt) throw new HttpError(409, 'This account has already been deleted.');
  const now = Date.now();
  const userBookings = allDocs(await col.bookings.where('userId', '==', u.id).get());
  const live = userBookings.filter((b) =>
    b.status === 'confirmed' || b.status === 'active' || (b.status === 'pending_payment' && b.paymentExpiresAt > now));
  if (live.length) {
    throw new HttpError(409, 'Cancel or complete this customer\'s current bookings before deleting their account.');
  }

  // Booking, payment, and message records (7 years) are retained for compliance and tax law; personal details are removed.
  const del = FieldValue.delete();
  const batch = firestore.batch();
  batch.update(col.users.doc(u.id), {
    email: `deleted-${u.id}@invalid`, passwordHash: 'deleted', googleSub: del, fullName: 'Deleted customer', disabled: true,
    phone: del, dob: del, addressLine: del, suburb: del, state: del, postcode: del, licenceNumber: del,
    licenceCardNumber: del, licenceState: del, licenceAuthority: del, licenceType: del, licenceExpiry: del,
    licenceIssueDate: del, licenceClass: del, licenceConditions: del, licenceAddressFront: del,
    licenceAddressBack: del, licenceBriefDescription: del, licenceExtracted: del, licenceNotes: del,
    licenceFrontProvided: del, licenceBackProvided: del, regLat: del, regLng: del,
    regAccuracyM: del, insurer: del, policyNumber: del, policyExpiry: del,
    deletedAt: nowIso(), deletedBy: req.user.id,
  });
  if (u.email) batch.delete(col.emails.doc(u.email));
  for (const b of userBookings) {
    batch.update(col.bookings.doc(b.id), { userName: 'Deleted customer', userEmail: del, userPhone: del });
  }
  const threadSnap = await col.threads.doc(u.id).get();
  if (threadSnap.exists) {
    batch.update(col.threads.doc(u.id), {
      fullName: 'Deleted customer',
      email: del,
      archivedAt: nowIso(),
      unreadForAdmin: 0,
      unreadForCustomer: 0,
    });
  }
  await batch.commit();
  await destroyAllSessions(u.id);
  audit(req.user.id, 'user.delete', `user ${u.id}`, req.ip);
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
  res.json({ user: customerView(u), messages, archived: Boolean(u.deletedAt), retentionYears: MESSAGE_RETENTION_YEARS });
});

router.post('/admin/threads/:userId', async (req, res) => {
  const u = await requireCustomer(req.params.userId);
  if (u.deletedAt) {
    throw new HttpError(409, 'This account has been deleted. The message history is archived for 7-year retention and is read-only.');
  }
  const body = str(req.body?.body, { field: 'Message', min: 1, max: 2000 });
  const message = await postMessage(u, 'admin', body);
  res.status(201).json({ ok: true, message });
});

/* ---------- Staff accounts (superadmin) ---------- */

router.get('/admin/staff', requireSuperadmin, async (req, res) => {
  const staff = allDocs(await col.users.where('role', 'in', ['admin', 'superadmin']).get())
    .filter((u) => !u.deletedAt)
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
  if (!u || !['admin', 'superadmin'].includes(u.role) || u.deletedAt) throw new HttpError(404, 'Staff member not found.');
  const disabled = req.body?.disabled === true;
  await col.users.doc(id).update({ disabled });
  if (disabled) await destroyAllSessions(id);
  audit(req.user.id, disabled ? 'staff.disable' : 'staff.enable', `user ${id}`, req.ip);
  res.json({ ok: true });
});

router.delete('/admin/staff/:id', requireSuperadmin, async (req, res) => {
  const id = String(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'Nobody can delete their own account.');
  const u = await getUser(id);
  if (!u || !['admin', 'superadmin'].includes(u.role) || u.deletedAt) {
    throw new HttpError(404, 'Staff member not found.');
  }
  const del = FieldValue.delete();
  const batch = firestore.batch();
  batch.update(col.users.doc(id), {
    email: `deleted-${id}@invalid`,
    passwordHash: 'deleted',
    googleSub: del,
    fullName: 'Deleted staff',
    disabled: true,
    deletedAt: nowIso(),
    deletedBy: req.user.id,
  });
  if (u.email) batch.delete(col.emails.doc(u.email));
  await batch.commit();
  await destroyAllSessions(id);
  audit(req.user.id, 'staff.delete', `user ${id}`, req.ip);
  res.json({ ok: true });
});

/* ---------- Contractor distribution ledger ---------- */

function parseLedgerRange(query = {}) {
  const from = query.from ? validDate(query.from, 'From date', false) : '';
  const to = query.to ? validDate(query.to, 'To date', false) : '';
  if (from && to && to < from) throw new HttpError(400, 'End date must be on or after start date.');
  return { from, to };
}

function parseAudCents(value, field = 'Amount (AUD)') {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100000) {
    throw new HttpError(400, `${field} must be between $0.01 and $100,000.`);
  }
  const cents = Math.round(n * 100);
  if (cents < 1) throw new HttpError(400, `${field} must be at least $0.01.`);
  return cents;
}

async function loadLedgerView(from = '', to = '') {
  const [settings, paymentsSnap, ledgerSnap] = await Promise.all([
    getSettings(),
    col.payments.get(),
    col.ledgerEntries.get(),
  ]);
  return computeLedger({
    payments: allDocs(paymentsSnap),
    ledgerEntries: allDocs(ledgerSnap),
    settings,
    from,
    to,
  });
}

router.get('/admin/ledger', async (req, res) => {
  const { from, to } = parseLedgerRange(req.query);
  res.json(await loadLedgerView(from, to));
});

router.get('/admin/ledger/export.csv', async (req, res) => {
  const { from, to } = parseLedgerRange(req.query);
  const view = await loadLedgerView(from, to);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="kangoo-distribution-ledger.csv"');
  res.send(ledgerToCsv(view));
});

const LEDGER_CONFIG_KEYS = new Set([
  'contractor_a_name',
  'contractor_a_role',
  'contractor_a_share_pct',
  'contractor_b_name',
  'contractor_b_role',
  'contractor_b_share_pct',
  'distribution_gst_basis',
]);

router.put('/admin/ledger/config', requireSuperadmin, async (req, res) => {
  const raw = req.body || {};
  const updates = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!LEDGER_CONFIG_KEYS.has(k)) throw new HttpError(400, `Unknown ledger setting: ${k}`);
    updates[k] = v;
  }
  const clean = cleanSettings(updates);
  const merged = { ...(await getSettings()), ...clean };
  if (Number(merged.contractor_a_share_pct) + Number(merged.contractor_b_share_pct) !== 100) {
    throw new HttpError(400, 'Contractor split percentages must add up to 100%.');
  }
  await setSettings(clean);
  audit(req.user.id, 'ledger.config', `${merged.contractor_a_name}=${merged.contractor_a_share_pct}%/${merged.contractor_b_name}=${merged.contractor_b_share_pct}% (${merged.distribution_gst_basis})`, req.ip);
  res.json(await loadLedgerView());
});

router.post('/admin/ledger/cash', async (req, res) => {
  const b = req.body || {};
  const allowedKeys = new Set(['entryDate', 'amountAud', 'collectedBy', 'bookingRef', 'note']);
  for (const k of Object.keys(b)) {
    if (!allowedKeys.has(k)) throw new HttpError(400, `Unknown field: ${k}`);
  }
  const entryDate = b.entryDate ? validDate(b.entryDate, 'Payment date') : brisbaneToday();
  const grossAudCents = parseAudCents(b.amountAud, 'Cash amount (AUD)');
  const bookingRef = str(b.bookingRef, { field: 'Booking reference', required: false, max: 40 });
  const note = str(b.note, { field: 'Note', min: 3, max: 300 });
  const collectedBy = req.user.role === 'superadmin' && b.collectedBy === 'contractor_a'
    ? 'contractor_a'
    : 'contractor_b';

  const settings = await getSettings();
  const gstRateBp = Number(settings.gst_rate_bp) || 1000;
  const { gstCents, exGstCents } = splitGstFromGross(grossAudCents, gstRateBp);
  const doc = {
    kind: 'cash_payment',
    entryDate,
    grossAudCents,
    gstAudCents: gstCents,
    netExGstAudCents: exGstCents,
    currency: 'AUD',
    collectedBy,
    bookingRef: bookingRef || null,
    note,
    createdByUserId: req.user.id,
    createdByName: req.user.fullName || req.user.email,
    createdAt: nowIso(),
  };
  const ref = await col.ledgerEntries.add(doc);
  audit(req.user.id, 'ledger.cash', `${formatAud(grossAudCents)} (${collectedBy}): ${note}`, req.ip);
  res.status(201).json({ entry: { id: ref.id, ...doc }, ledger: await loadLedgerView() });
});

router.post('/admin/ledger/distributions', requireSuperadmin, async (req, res) => {
  const b = req.body || {};
  const allowedKeys = new Set(['entryDate', 'fromContractor', 'toContractor', 'amountAud', 'method', 'reference', 'note']);
  for (const k of Object.keys(b)) {
    if (!allowedKeys.has(k)) throw new HttpError(400, `Unknown field: ${k}`);
  }
  const entryDate = b.entryDate ? validDate(b.entryDate, 'Distribution date') : brisbaneToday();
  const fromContractor = String(b.fromContractor || '');
  const toContractor = String(b.toContractor || '');
  if (!['contractor_a', 'contractor_b'].includes(fromContractor) || !['contractor_a', 'contractor_b'].includes(toContractor) || fromContractor === toContractor) {
    throw new HttpError(400, 'Choose two different contractors for the distribution.');
  }
  const amountAudCents = parseAudCents(b.amountAud, 'Distribution amount (AUD)');
  const method = String(b.method || 'bank_transfer');
  if (!['bank_transfer', 'cash', 'stripe_payout', 'other'].includes(method)) {
    throw new HttpError(400, 'Invalid distribution payment method.');
  }
  const reference = str(b.reference, { field: 'Reference', required: false, max: 80 });
  const note = str(b.note, { field: 'Note', min: 3, max: 300 });

  const doc = {
    kind: 'distribution',
    entryDate,
    fromContractor,
    toContractor,
    amountAudCents,
    currency: 'AUD',
    method,
    reference: reference || null,
    note,
    createdByUserId: req.user.id,
    createdByName: req.user.fullName || req.user.email,
    createdAt: nowIso(),
  };
  const ref = await col.ledgerEntries.add(doc);
  audit(req.user.id, 'ledger.distribution', `${fromContractor} -> ${toContractor} ${formatAud(amountAudCents)} (${method}): ${note}`, req.ip);
  res.status(201).json({ entry: { id: ref.id, ...doc }, ledger: await loadLedgerView() });
});

router.delete('/admin/ledger/:id', requireSuperadmin, async (req, res) => {
  const id = String(req.params.id);
  const ref = col.ledgerEntries.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Ledger entry not found.');
  const e = snap.data();
  await ref.delete();
  audit(req.user.id, 'ledger.delete', `${e.kind} ${id}`, req.ip);
  res.json({ ok: true, ledger: await loadLedgerView() });
});

/* ---------- Audit log ---------- */

router.get('/admin/audit', async (req, res) => {
  res.json({ entries: allDocs(await col.auditLog.orderBy('createdAt', 'desc').limit(300).get()) });
});
