import { Router } from 'express';
import { firestore, col, allDocs, nowIso, getSettings, num, audit, FieldValue } from '../db.js';
import { HttpError, requireUser } from '../security.js';
import { paymentsMode } from '../payments.js';
import { checkServiceArea } from './auth.js';
import { currentRate } from '../fx.js';
import { config } from '../config.js';
import {
  quote, maxRentalDays, priceTable, tokenTable, handoverRules, isHandoverDay, dayLabel, brisbaneTime, brisbaneToday, addDays, bookingRef, int, validDate, str, DAY,
} from '../util.js';

export const router = Router();

const CALENDAR_LOCK = col.locks.doc('calendar');

export function publicConfig(settings) {
  const fx = currentRate(settings);
  return {
    businessName: settings.business_name,
    priceBasis: settings.price_basis,
    tokenPriceAud: num(settings, 'token_price_aud') || 1,
    tokenShareFee: num(settings, 'token_share_fee') || 1,
    dailyRateAudCents: priceTable(settings)[0] * 100,
    dailyRateTokenCents: tokenTable(settings)[0] * 100,
    gstRateBp: num(settings, 'gst_rate_bp'),
    fx,
    dailyQuote: quote(settings, 1, fx.rate),
    // Price for each hire length, before GST, in AUD, converted USD (for outside AU/NZ), and customizable tokens.
    priceList: Array.from({ length: maxRentalDays(settings) }, (_, i) => {
      const q = quote(settings, i + 1, fx.rate);
      return {
        days: i + 1,
        audCents: q.subtotalCents,
        totalAudCents: q.totalCents,
        usdCents: q.usdSubtotalCents,
        totalUsdCents: q.usdTotalCents,
        tokenCents: q.tokenCents,
      };
    }),
    tokenPacks: settings.token_packs.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0),
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
    requiredIndemnityCents: num(settings, 'required_indemnity_cents'),
    contactEmail: settings.contact_email,
    contactPhone: settings.contact_phone,
    announcement: settings.announcement,
    paymentsMode,
    licenceAi: config.licenceAiEnabled,
    googleClientId: config.googleClientId,
    today: brisbaneToday(),
  };
}

/**
 * Busy intervals (epoch ms) overlapping [fromMs, toMs): live bookings padded by the turnaround buffer,
 * plus admin blocks. Pass a transaction `t` to read inside it.
 */
export async function busyRanges(fromMs, toMs, settings, t = null) {
  const buffer = num(settings, 'buffer_hours') * 3600000;
  const read = (q) => (t ? t.get(q) : q.get());
  // Single-field range query (no composite index needed); the rest is filtered here.
  const [bookingSnap, blockSnap] = await Promise.all([
    read(col.bookings.where('endAt', '>', fromMs - buffer)),
    read(col.blocks),
  ]);
  const bookings = allDocs(bookingSnap)
    .filter((b) => (b.status === 'confirmed' || b.status === 'active') && b.startAt - buffer < toMs)
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
  res.json(quote(settings, days, currentRate(settings).rate));
});

export function bookingView(b) {
  return {
    id: b.id,
    ref: b.ref,
    startAt: b.startAt,
    endAt: b.endAt,
    days: b.days,
    fxRate: b.fxRate,
    subtotalCents: b.subtotalCents,
    gstCents: b.gstCents,
    totalCents: b.totalCents,
    tokenCents: b.tokenCents,
    status: b.status,
    refundedTokenCents: b.refundedTokenCents || 0,
    customerNote: b.customerNote,
    createdAt: b.createdAt,
  };
}

function bookingBlockers(user, endAtMs) {
  const reasons = [];
  if (user.licenceStatus !== 'verified') reasons.push('licence');
  const policyEnd = user.policyExpiry ? brisbaneTime(user.policyExpiry) + DAY : 0;
  if (!user.insurer || !user.policyNumber || !user.indemnityConfirmedAt || policyEnd < endAtMs) reasons.push('insurance');
  return reasons;
}

router.post('/bookings', requireUser, async (req, res) => {
  if (req.user.role !== 'supporter') throw new HttpError(403, 'Staff accounts cannot make bookings.');
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
    throw new HttpError(400, `Pickups aren't available on ${dayLabel(date)}. Please choose another pickup day.`);
  }
  if (!isHandoverDay(handover, returnDate)) {
    throw new HttpError(400, `Returns aren't available on ${dayLabel(returnDate)}. Please choose a hire length that's returned on another day.`);
  }
  // Anyone can register, but bookings are only for people near the depot: the browser sends its location with every booking.
  const area = checkServiceArea(b.lat, b.lng, settings);
  if (!area.inArea) {
    audit(req.user.id, 'booking.outside_area', `${area.distanceKm} km`, req.ip);
    throw new HttpError(403, `Bookings are only open to people within ${area.radiusKm} km of our ${settings.pickup_label} depot. You appear to be ${area.distanceKm} km away.`);
  }

  const hour = Number(time.slice(0, 2));
  if (hour < num(settings, 'first_pickup_hour') || hour > num(settings, 'last_pickup_hour')) {
    throw new HttpError(400, 'Please choose a pickup time within opening hours.');
  }
  const startAt = brisbaneTime(date, time);
  const endAt = startAt + days * DAY;
  if (startAt < Date.now() + num(settings, 'min_notice_hours') * 3600000) {
    throw new HttpError(400, `Bookings need at least ${settings.min_notice_hours} hours notice.`);
  }
  if (startAt > Date.now() + num(settings, 'max_advance_days') * DAY) {
    throw new HttpError(400, `Bookings can be made up to ${settings.max_advance_days} days ahead.`);
  }

  const q = quote(settings, days, currentRate(settings).rate);
  const userRef = col.users.doc(req.user.id);
  const bookingRefDoc = col.bookings.doc();
  const ref = bookingRef();

  await firestore.runTransaction(async (t) => {
    // Every booking transaction reads and writes the calendar lock, so two overlapping requests can't both commit.
    const [, userSnap, busy] = await Promise.all([
      t.get(CALENDAR_LOCK),
      t.get(userRef),
      busyRanges(startAt, endAt, settings, t),
    ]);
    const user = { id: userSnap.id, ...userSnap.data() };
    const blockers = bookingBlockers(user, endAt);
    if (blockers.includes('licence')) throw new HttpError(409, 'Your driver licence must be verified before you can book.');
    if (blockers.includes('insurance')) {
      throw new HttpError(409, 'Please add your insurance details (including $2 million indemnity cover valid for the whole rental) before booking.');
    }
    if (busy.some((r) => r.start < endAt && r.end > startAt)) {
      throw new HttpError(409, 'Sorry, the van is not available for that time. Please choose another slot.');
    }
    if ((user.tokenCents || 0) < q.tokenCents) {
      throw new HttpError(402, `You need ${q.tokenCents / 100} tokens for this booking but have ${Math.floor((user.tokenCents || 0) / 100)}. Please buy more tokens.`);
    }

    t.set(CALENDAR_LOCK, { updatedAt: nowIso() });
    t.create(bookingRefDoc, {
      ref,
      userId: user.id,
      userName: user.fullName,
      userEmail: user.email,
      userPhone: user.phone,
      startAt,
      endAt,
      days,
      priceBasis: q.priceBasis,
      fxRate: q.fxRate,
      gstRateBp: q.gstRateBp,
      bookedFromKm: area.distanceKm,
      listSubtotalCents: q.listSubtotalCents,
      discountCents: q.discountCents,
      subtotalCents: q.subtotalCents,
      gstCents: q.gstCents,
      totalCents: q.totalCents,
      tokenCents: q.tokenCents,
      status: 'confirmed',
      insurer: user.insurer,
      policyNumber: user.policyNumber,
      disclaimerAcceptedAt: nowIso(),
      customerNote: note || null,
      refundedTokenCents: 0,
      createdAt: nowIso(),
    });
    t.update(userRef, { tokenCents: FieldValue.increment(-q.tokenCents) });
    t.create(col.tokenTransactions.doc(), {
      userId: user.id,
      deltaCents: -q.tokenCents,
      kind: 'booking',
      bookingId: bookingRefDoc.id,
      note: `Booking ${ref}`,
      createdAt: nowIso(),
    });
  });

  audit(req.user.id, 'booking.create', `${ref} ${date} ${time} x${days}`, req.ip);
  const snap = await bookingRefDoc.get();
  res.status(201).json({ booking: bookingView({ id: snap.id, ...snap.data() }) });
});

router.get('/bookings', requireUser, async (req, res) => {
  const rows = allDocs(await col.bookings.where('userId', '==', req.user.id).get())
    .sort((a, b) => b.startAt - a.startAt);
  res.json({ bookings: rows.map(bookingView) });
});

/** Cancels a confirmed booking and optionally refunds tokens (in token cents). */
export async function cancelBooking(bookingId, { refundTokenCents, byUserId, ip, reason, ownerId = null }) {
  const bookingDoc = col.bookings.doc(bookingId);
  const booking = await firestore.runTransaction(async (t) => {
    const snap = await t.get(bookingDoc);
    if (!snap.exists || (ownerId && snap.data().userId !== ownerId)) throw new HttpError(404, 'Booking not found.');
    const b = snap.data();
    if (b.status !== 'confirmed') throw new HttpError(409, 'Only upcoming bookings can be cancelled.');
    const refund = typeof refundTokenCents === 'function' ? refundTokenCents(b) : refundTokenCents;
    t.update(bookingDoc, {
      status: 'cancelled',
      cancelledAt: nowIso(),
      refundedTokenCents: refund,
      ...(reason ? { adminNote: reason } : {}),
    });
    t.set(CALENDAR_LOCK, { updatedAt: nowIso() });
    if (refund > 0) {
      t.update(col.users.doc(b.userId), { tokenCents: FieldValue.increment(refund) });
      t.create(col.tokenTransactions.doc(), {
        userId: b.userId, deltaCents: refund, kind: 'refund', bookingId, note: `Cancelled ${b.ref}`, createdAt: nowIso(),
      });
    }
    return { ...b, refund };
  });
  audit(byUserId, 'booking.cancel', `${booking.ref} refund=${booking.refund}`, ip);
  return booking;
}

router.post('/bookings/:id/cancel', requireUser, async (req, res) => {
  const settings = await getSettings();
  const cutoffMs = num(settings, 'cancellation_hours') * 3600000;
  await cancelBooking(String(req.params.id), {
    ownerId: req.user.id,
    byUserId: req.user.id,
    ip: req.ip,
    refundTokenCents: (b) => {
      if (Date.now() > b.startAt - cutoffMs) {
        throw new HttpError(409, `Bookings can only be cancelled online more than ${settings.cancellation_hours} hours before pickup. Please message us.`);
      }
      return b.tokenCents;
    },
  });
  res.json({ ok: true });
});
