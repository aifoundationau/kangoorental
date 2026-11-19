import { Router } from 'express';
import { firestore, col, allDocs, nowIso, getSettings, num, audit } from '../db.js';
import { HttpError, requireUser } from '../security.js';
import {
  paymentsMode, createBookingCheckout, confirmBookingCheckout, expirePendingBooking, refundStripePayment, HOLD_MS,
} from '../payments.js';
import { checkServiceArea } from './auth.js';
import { config } from '../config.js';
import {
  quote, maxRentalDays, priceTable, handoverRules, isHandoverDay, isWeekend, dayLabel, brisbaneTime, brisbaneToday, addDays,
  bookingRef, int, validDate, str, DAY,
} from '../util.js';

export const router = Router();

const CALENDAR_LOCK = col.locks.doc('calendar');

export function publicConfig(settings) {
  return {
    businessName: settings.business_name,
    currency: 'AUD',
    dailyRateAudCents: priceTable(settings)[0] * 100,
    gstRateBp: num(settings, 'gst_rate_bp'),
    dailyQuote: quote(settings, 1),
    // Price for each hire length in AUD (ex-GST, GST, and inc-GST).
    priceList: Array.from({ length: maxRentalDays(settings) }, (_, i) => {
      const q = quote(settings, i + 1);
      return {
        days: q.days,
        subtotalCents: q.subtotalCents,
        gstCents: q.gstCents,
        totalCents: q.totalCents,
        listTotalCents: q.listTotalCents,
        discountIncGstCents: q.discountIncGstCents,
      };
    }),
    minDriverAge: num(settings, 'min_driver_age'),
    bookingRadiusKm: num(settings, 'registration_radius_km'),
    pickup: { label: settings.pickup_label, lat: num(settings, 'pickup_lat'), lng: num(settings, 'pickup_lng') },
    cancellationHours: num(settings, 'cancellation_hours'),
    bufferHours: num(settings, 'buffer_hours'),
    minNoticeHours: num(settings, 'min_notice_hours'),
    maxRentalDays: maxRentalDays(settings),
    handover: handoverRules(settings),
    maxAdvanceDays: num(settings, 'max_advance_days'),
    firstPickupHour: num(settings, 'first_pickup_hour'),
    lastPickupHour: num(settings, 'last_pickup_hour'),
    firstReturnHour: num(settings, 'first_return_hour'),
    lastReturnHour: num(settings, 'last_return_hour'),
    requiredIndemnityCents: num(settings, 'required_indemnity_cents'),
    contactEmail: settings.contact_email,
    contactPhone: settings.contact_phone,
    announcement: settings.announcement,
    paymentsMode,
    licenceAi: config.licenceAiEnabled,
    googleClientId: config.googleClientId,
    googleOAuthEnabled: config.googleOAuthEnabled,
    today: brisbaneToday(),
  };
}

/**
 * Busy intervals (epoch ms) overlapping [fromMs, toMs): live bookings (plus active checkout holds)
 * padded by the turnaround buffer, plus admin blocks. Pass a transaction `t` to read inside it.
 */
export async function busyRanges(fromMs, toMs, settings, t = null) {
  const buffer = num(settings, 'buffer_hours') * 3600000;
  const read = (q) => (t ? t.get(q) : q.get());
  const now = Date.now();
  // Single-field range query (no composite index needed); the rest is filtered here.
  const [bookingSnap, blockSnap] = await Promise.all([
    read(col.bookings.where('endAt', '>', fromMs - buffer)),
    read(col.blocks),
  ]);
  const bookings = allDocs(bookingSnap)
    .filter((b) => (
      b.status === 'confirmed' ||
      b.status === 'active' ||
      (b.status === 'pending_payment' && b.paymentExpiresAt > now)
    ) && b.startAt - buffer < toMs)
    .map((b) => ({ start: b.startAt - buffer, end: b.endAt + buffer, kind: 'booking' }));
  const blocks = allDocs(blockSnap)
    .map((b) => ({ start: brisbaneTime(b.startDate), end: brisbaneTime(addDays(b.endDate, 1)), kind: 'blocked' }))
    .filter((b) => b.start < toMs && b.end > fromMs);
  return [...bookings, ...blocks];
}

router.get('/config', async (req, res) => res.json(publicConfig(await getSettings())));

router.get('/availability', async (req, res) => {
  const from = validDate(req.query.from, 'From date');
  const to = validDate(req.query.to, 'To date');
  if (to < from || Date.parse(to) - Date.parse(from) > 120 * DAY) throw new HttpError(400, 'Date range is too large.');
  const settings = await getSettings();
  // Include a tail so multi-day rentals starting late in the range can be checked in the browser.
  const ranges = await busyRanges(brisbaneTime(from), brisbaneTime(addDays(to, maxRentalDays(settings) + 1)), settings);
  res.json({ busy: ranges });
});

router.get('/quote', async (req, res) => {
  const settings = await getSettings();
  const days = int(req.query.days ?? 1, { field: 'Days', min: 1, max: maxRentalDays(settings) });
  res.json(quote(settings, days));
});

export function bookingView(b) {
  return {
    id: b.id,
    ref: b.ref,
    startAt: b.startAt,
    endAt: b.endAt,
    days: b.days,
    currency: 'AUD',
    subtotalCents: b.subtotalCents,
    gstCents: b.gstCents,
    totalCents: b.totalCents,
    paidAudCents: b.paidAudCents ?? b.totalCents,
    refundedAudCents: b.refundedAudCents || 0,
    status: b.status,
    paymentStatus: b.paymentStatus || (b.status === 'cancelled' ? 'cancelled' : 'paid'),
    paymentProvider: b.paymentProvider || 'demo',
    customerNote: b.customerNote,
    createdAt: b.createdAt,
  };
}

function bookingBlockers(user) {
  const reasons = [];
  if (user.licenceStatus !== 'verified') reasons.push('licence');
  // Insurance details are optional at booking time (still editable under Account -> Insurance).
  return reasons;
}

router.post('/bookings', requireUser, async (req, res) => {
  if (req.user.role !== 'supporter') throw new HttpError(403, 'Staff accounts cannot make bookings.');
  if (paymentsMode === 'disabled') throw new HttpError(503, 'Online payments are not available right now. Please message us.');

  const settings = await getSettings();
  const b = req.body || {};
  const date = validDate(b.date, 'Pickup date');
  const time = str(b.time, { field: 'Pickup time', pattern: /^\d{2}:00$/, max: 5 });
  const days = int(b.days, { field: 'Number of days', min: 1, max: maxRentalDays(settings) });
  const note = str(b.note, { field: 'Note', required: false, max: 500 });
  if (b.acceptDisclaimer !== true) throw new HttpError(400, 'You must accept the rental disclaimer and insurance requirements.');
  // The van can only be picked up and returned on the owner's available days (set by the superadmin).
  const handover = handoverRules(settings);
  const returnDate = addDays(date, days);
  if (!isHandoverDay(handover, date)) {
    throw new HttpError(400, isWeekend(date)
      ? `Saturday and Sunday pickups (${dayLabel(date)}) require messaging admin first. Please message us in your account or choose a Monday–Friday date.`
      : `Pickups aren't available on ${dayLabel(date)}. Please choose another pickup day or message admin.`);
  }
  if (!isHandoverDay(handover, returnDate)) {
    throw new HttpError(400, isWeekend(returnDate)
      ? `Saturday and Sunday drop-offs (${dayLabel(returnDate)}) require messaging admin first. Please message us or choose a hire length returning Monday–Friday.`
      : `Returns aren't available on ${dayLabel(returnDate)}. Please choose a hire length that's returned on another day or message admin.`);
  }
  // Anyone can register, but bookings are only for people near the depot: the browser sends its location with every booking.
  const area = checkServiceArea(b.lat, b.lng, settings);
  if (!area.inArea) {
    audit(req.user.id, 'booking.outside_area', `${area.distanceKm} km`, req.ip);
    throw new HttpError(403, `Bookings are only open to people within ${area.radiusKm} km of our ${settings.pickup_label} depot. You appear to be ${area.distanceKm} km away.`);
  }

  const firstPickupHour = num(settings, 'first_pickup_hour');
  const lastPickupHour = num(settings, 'last_pickup_hour');
  const firstReturnHour = num(settings, 'first_return_hour');
  const hour = Number(time.slice(0, 2));
  if (hour < firstPickupHour || hour > lastPickupHour) {
    throw new HttpError(400, `Pickup is ${firstPickupHour}:00–${lastPickupHour}:00 (for an earlier time, please message admin).`);
  }
  const startAt = brisbaneTime(date, time);
  const endAt = brisbaneTime(returnDate, `${String(firstReturnHour).padStart(2, '0')}:00`);
  if (startAt < Date.now() + num(settings, 'min_notice_hours') * 3600000) {
    throw new HttpError(400, `Bookings need at least ${settings.min_notice_hours} hours notice.`);
  }
  if (startAt > Date.now() + num(settings, 'max_advance_days') * DAY) {
    throw new HttpError(400, `Bookings can be made up to ${settings.max_advance_days} days ahead.`);
  }

  const q = quote(settings, days);
  const userRef = col.users.doc(req.user.id);
  const bookingRefDoc = col.bookings.doc();
  const ref = bookingRef();
  const createdAt = nowIso();
  const isStripe = paymentsMode === 'stripe';
  const paymentExpiresAt = isStripe ? Date.now() + HOLD_MS : null;

  const docPayload = {
    ref,
    userId: req.user.id,
    userName: req.user.fullName,
    userEmail: req.user.email,
    userPhone: req.user.phone,
    startAt,
    endAt,
    days,
    currency: 'AUD',
    gstRateBp: q.gstRateBp,
    bookedFromKm: area.distanceKm,
    listSubtotalCents: q.listSubtotalCents,
    discountCents: q.discountCents,
    subtotalCents: q.subtotalCents,
    gstCents: q.gstCents,
    totalCents: q.totalCents,
    paidAudCents: isStripe ? 0 : q.totalCents,
    refundedAudCents: 0,
    status: isStripe ? 'pending_payment' : 'confirmed',
    paymentStatus: isStripe ? 'unpaid' : 'paid',
    paymentProvider: paymentsMode,
    ...(isStripe ? { paymentExpiresAt } : { paidAt: createdAt }),
    insurer: req.user.insurer || null,
    policyNumber: req.user.policyNumber || null,
    disclaimerAcceptedAt: createdAt,
    customerNote: note || null,
    createdAt,
  };

  await firestore.runTransaction(async (t) => {
    // Every booking transaction reads and writes the calendar lock, so two overlapping requests can't both commit.
    const [, userSnap, busy] = await Promise.all([
      t.get(CALENDAR_LOCK),
      t.get(userRef),
      busyRanges(startAt, endAt, settings, t),
    ]);
    const user = { id: userSnap.id, ...userSnap.data() };
    const blockers = bookingBlockers(user);
    if (blockers.includes('licence')) throw new HttpError(409, 'Your driver licence must be verified before you can book.');
    if (busy.some((r) => r.start < endAt && r.end > startAt)) {
      throw new HttpError(409, 'Sorry, the van is not available for that time. Please choose another slot.');
    }

    docPayload.insurer = user.insurer || null;
    docPayload.policyNumber = user.policyNumber || null;

    t.set(CALENDAR_LOCK, { updatedAt: createdAt });
    t.create(bookingRefDoc, docPayload);
    if (!isStripe) {
      t.create(col.payments.doc(), {
        bookingId: bookingRefDoc.id,
        bookingRef: ref,
        userId: user.id,
        kind: 'payment',
        amountCents: q.totalCents,
        subtotalCents: q.subtotalCents,
        gstCents: q.gstCents,
        currency: 'AUD',
        provider: 'demo',
        note: `Booking ${ref} (demo mode - no money taken)`,
        createdAt,
      });
    }
  });

  if (isStripe) {
    let session;
    try {
      session = await createBookingCheckout(req.user, { id: bookingRefDoc.id, ...docPayload }, settings.pickup_label);
    } catch (err) {
      await expirePendingBooking(bookingRefDoc.id).catch(() => {});
      throw err;
    }
    await bookingRefDoc.update({ stripeSessionId: session.id });
    audit(req.user.id, 'booking.checkout', `${ref} ${date} ${time} x${days} ${session.id}`, req.ip);
    return res.status(201).json({ booking: bookingView({ id: bookingRefDoc.id, ...docPayload }), checkoutUrl: session.url });
  }

  audit(req.user.id, 'booking.create', `${ref} ${date} ${time} x${days}`, req.ip);
  res.status(201).json({ booking: bookingView({ id: bookingRefDoc.id, ...docPayload }), demo: true });
});

router.get('/bookings/confirm', requireUser, async (req, res) => {
  if (paymentsMode !== 'stripe') throw new HttpError(400, 'Stripe is not configured.');
  const result = await confirmBookingCheckout(String(req.query.session_id || ''), req.user.id);
  res.json({ paid: result.paid, booking: result.booking ? bookingView(result.booking) : null });
});

router.post('/bookings/:id/abandon', requireUser, async (req, res) => {
  await expirePendingBooking(String(req.params.id), req.user.id);
  res.json({ ok: true });
});

router.get('/bookings', requireUser, async (req, res) => {
  const rows = allDocs(await col.bookings.where('userId', '==', req.user.id).get())
    .filter((b) => b.status !== 'expired')
    .sort((a, b) => b.startAt - a.startAt);
  res.json({ bookings: rows.map(bookingView) });
});

/** Cancels a confirmed booking and optionally refunds the AUD payment. */
export async function cancelBooking(bookingId, { refundAudCents, byUserId, ip, reason, ownerId = null }) {
  const bookingDoc = col.bookings.doc(bookingId);
  const booking = await firestore.runTransaction(async (t) => {
    const snap = await t.get(bookingDoc);
    if (!snap.exists || (ownerId && snap.data().userId !== ownerId)) throw new HttpError(404, 'Booking not found.');
    const b = snap.data();
    if (b.status !== 'confirmed') throw new HttpError(409, 'Only upcoming bookings can be cancelled.');
    const refund = typeof refundAudCents === 'function' ? refundAudCents(b) : refundAudCents;
    const needsStripeRefund = refund > 0 && b.paymentProvider === 'stripe' && Boolean(b.stripePaymentIntentId) && Boolean(config.stripeSecretKey);
    const ts = nowIso();
    t.update(bookingDoc, {
      status: 'cancelled',
      cancelledAt: ts,
      refundedAudCents: refund,
      paymentStatus: refund > 0 ? (needsStripeRefund ? 'refund_pending' : 'refunded') : (b.paymentStatus || 'paid'),
      ...(reason ? { adminNote: reason } : {}),
    });
    t.set(CALENDAR_LOCK, { updatedAt: ts });
    if (refund > 0 && !needsStripeRefund) {
      t.create(col.payments.doc(), {
        bookingId,
        bookingRef: b.ref,
        userId: b.userId,
        kind: 'refund',
        amountCents: -refund,
        currency: 'AUD',
        provider: b.paymentProvider || 'demo',
        note: `Cancelled ${b.ref}`,
        createdAt: ts,
      });
    }
    return { ...b, refund, needsStripeRefund };
  });

  if (booking.needsStripeRefund) {
    try {
      const r = await refundStripePayment({
        paymentIntentId: booking.stripePaymentIntentId,
        amountCents: booking.refund,
        bookingId,
      });
      const ts = nowIso();
      await firestore.batch()
        .update(bookingDoc, { paymentStatus: 'refunded', stripeRefundId: r.id })
        .create(col.payments.doc(), {
          bookingId,
          bookingRef: booking.ref,
          userId: booking.userId,
          kind: 'refund',
          amountCents: -booking.refund,
          currency: 'AUD',
          provider: 'stripe',
          providerRef: r.id,
          note: `Cancelled ${booking.ref} · Refund ${r.id}`,
          createdAt: ts,
        })
        .commit();
    } catch (err) {
      await bookingDoc.update({ paymentStatus: 'refund_failed' }).catch(() => {});
      audit(byUserId, 'booking.refund_failed', `${booking.ref} ${err.message}`, ip);
      throw new HttpError(502, 'Booking was cancelled, but the automatic Stripe refund failed. Our team has been alerted.');
    }
  }

  audit(byUserId, 'booking.cancel', `${booking.ref} refundAudCents=${booking.refund}`, ip);
  return booking;
}

router.post('/bookings/:id/cancel', requireUser, async (req, res) => {
  const settings = await getSettings();
  const cutoffMs = num(settings, 'cancellation_hours') * 3600000;
  await cancelBooking(String(req.params.id), {
    ownerId: req.user.id,
    byUserId: req.user.id,
    ip: req.ip,
    refundAudCents: (b) => {
      if (Date.now() > b.startAt - cutoffMs) {
        throw new HttpError(409, `Bookings can only be cancelled online more than ${settings.cancellation_hours} hours before pickup. Please message us.`);
      }
      return b.paidAudCents ?? b.totalCents;
    },
  });
  res.json({ ok: true });
});

export async function purgeExpiredPendingBookings() {
  const qs = await col.bookings.where('status', '==', 'pending_payment').limit(200).get();
  if (qs.empty) return;
  const now = Date.now();
  const expired = qs.docs.filter((d) => (d.data().paymentExpiresAt || 0) < now);
  if (!expired.length) return;
  const ts = nowIso();
  const batch = firestore.batch();
  for (const d of expired) batch.update(d.ref, { status: 'expired', paymentStatus: 'expired', expiredAt: ts });
  batch.set(CALENDAR_LOCK, { updatedAt: ts });
  await batch.commit();
}
