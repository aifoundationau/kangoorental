import crypto from 'node:crypto';
import { config } from './config.js';
import { firestore, col, FieldValue, nowIso, audit } from './db.js';
import { HttpError } from './security.js';
import { formatAud } from './util.js';

// All bookings are charged directly in AUD through Stripe Checkout with native Stripe Tax
// (automatic_tax: { enabled: true }, tax_behavior: "exclusive", and invoice_creation: { enabled: true }).
// Credits/confirmations are idempotent on the Stripe checkout session id.

export const paymentsMode = config.stripeSecretKey ? 'stripe' : config.allowDemoPayments ? 'demo' : 'disabled';

// 31-minute checkout hold (Stripe requires expires_at >= now + 30 minutes).
export const HOLD_MS = 31 * 60 * 1000;

async function stripe(method, path, params, { idempotencyKey } = {}) {
  const headers = {
    Authorization: `Bearer ${config.stripeSecretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers,
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('[stripe]', data?.error?.message || res.status);
    throw new HttpError(502, 'Payment provider error. Please try again.');
  }
  return data;
}

export async function createBookingCheckout(user, booking, pickupLabel = 'Arundel QLD 4214') {
  return stripe('POST', '/checkout/sessions', {
    mode: 'payment',
    currency: 'aud',
    customer_email: user.email,
    client_reference_id: String(booking.id),
    expires_at: String(Math.floor(booking.paymentExpiresAt / 1000)),
    'metadata[booking_id]': String(booking.id),
    'metadata[booking_ref]': String(booking.ref),
    'metadata[user_id]': String(user.id),
    'metadata[days]': String(booking.days),
    'metadata[subtotal_aud_cents]': String(booking.subtotalCents),
    'metadata[gst_aud_cents]': String(booking.gstCents),
    'metadata[total_aud_cents]': String(booking.totalCents),

    // Automatic Stripe Tax (adds 10% GST in Australia on top of ex-GST unit_amount)
    'automatic_tax[enabled]': 'true',

    // Official Tax Invoices on one-time payments
    'invoice_creation[enabled]': 'true',
    'invoice_creation[invoice_data][description]': `Tax Invoice - Renault Kangoo MAXI Van Hire (${booking.ref})`,
    'invoice_creation[invoice_data][footer]': `Kangoo Rental · Renault Kangoo MAXI Diesel 1.5 Manual 6-Speed · ${pickupLabel} · All prices and tax invoices are in Australian dollars (AUD).`,

    // Single line item in AUD with exclusive tax behavior
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'aud',
    'line_items[0][price_data][tax_behavior]': 'exclusive',
    'line_items[0][price_data][unit_amount]': String(booking.subtotalCents),
    'line_items[0][price_data][product_data][name]': `Renault Kangoo MAXI Van Hire - ${booking.days} day${booking.days > 1 ? 's' : ''} (${booking.ref})`,
    'line_items[0][price_data][product_data][description]': `Renault Kangoo MAXI Diesel 1.5 Manual 6-Speed · ${pickupLabel} depot`,

    success_url: `${config.baseUrl}/account?booking_paid=1&session_id={CHECKOUT_SESSION_ID}#bookings`,
    cancel_url: `${config.baseUrl}/account?booking_cancelled=1&booking_id=${encodeURIComponent(booking.id)}#bookings`,
  }, { idempotencyKey: `booking_checkout_${booking.id}` });
}

export async function markBookingPaid(session) {
  if (session.payment_status !== 'paid') return { confirmed: false, alreadyPaid: false, booking: null };
  if (session.currency !== 'aud') {
    console.error('[stripe] unexpected non-AUD currency on', session.id, session.currency);
    return { confirmed: false, alreadyPaid: false, booking: null };
  }
  const bookingId = String(session.metadata?.booking_id || session.client_reference_id || '');
  if (!bookingId) return { confirmed: false, alreadyPaid: false, booking: null };

  const payRef = col.payments.doc(`stripe_${session.id}`);
  const bookingRef = col.bookings.doc(bookingId);

  const result = await firestore.runTransaction(async (t) => {
    const [existingPay, bookingSnap] = await Promise.all([t.get(payRef), t.get(bookingRef)]);
    if (!bookingSnap.exists) return { confirmed: false, alreadyPaid: false, booking: null };
    const b = { id: bookingSnap.id, ...bookingSnap.data() };
    if (existingPay.exists || ['confirmed', 'active', 'completed'].includes(b.status)) {
      return { confirmed: false, alreadyPaid: true, booking: b };
    }

    const paidAudCents = session.amount_total ?? b.totalCents;
    const paidAt = nowIso();
    t.update(bookingRef, {
      status: 'confirmed',
      paymentStatus: 'paid',
      currency: 'AUD',
      paidAudCents,
      stripeSessionId: session.id,
      stripePaymentIntentId: session.payment_intent || null,
      stripeInvoiceId: session.invoice || null,
      paidAt,
      paymentExpiresAt: FieldValue.delete(),
    });
    t.create(payRef, {
      bookingId: b.id,
      bookingRef: b.ref,
      userId: b.userId,
      kind: 'payment',
      amountCents: paidAudCents,
      subtotalCents: b.subtotalCents,
      gstCents: b.gstCents,
      currency: 'AUD',
      provider: 'stripe',
      providerRef: session.id,
      paymentIntentId: session.payment_intent || null,
      invoiceId: session.invoice || null,
      note: `Booking ${b.ref}${session.invoice ? ` · Invoice ${session.invoice}` : ''}`,
      createdAt: paidAt,
    });
    t.set(col.locks.doc('calendar'), { updatedAt: paidAt });

    return {
      confirmed: true,
      alreadyPaid: false,
      booking: {
        ...b,
        status: 'confirmed',
        paymentStatus: 'paid',
        currency: 'AUD',
        paidAudCents,
        stripeSessionId: session.id,
        stripePaymentIntentId: session.payment_intent || null,
        stripeInvoiceId: session.invoice || null,
        paidAt,
      },
    };
  });

  if (result.confirmed && result.booking) {
    audit(result.booking.userId, 'booking.paid', `${result.booking.ref} ${formatAud(result.booking.paidAudCents)} via stripe (${session.id})`);
  }
  return result;
}

export async function expirePendingBooking(bookingId, ownerId = null) {
  const ref = col.bookings.doc(String(bookingId));
  await firestore.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) return;
    const b = snap.data();
    if (b.status !== 'pending_payment') return;
    if (ownerId && b.userId !== ownerId) throw new HttpError(403, 'This booking belongs to another account.');
    t.update(ref, { status: 'expired', paymentStatus: 'expired', expiredAt: nowIso() });
    t.set(col.locks.doc('calendar'), { updatedAt: nowIso() });
  });
}

export async function confirmBookingCheckout(sessionId, userId) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new HttpError(400, 'Invalid payment reference.');
  const session = await stripe('GET', `/checkout/sessions/${sessionId}`);
  const ownerId = session.metadata?.user_id;
  if (ownerId && ownerId !== userId) throw new HttpError(403, 'This payment belongs to another account.');
  if (session.payment_status !== 'paid') return { paid: false, booking: null };
  const result = await markBookingPaid(session);
  if (result.booking && result.booking.userId !== userId) throw new HttpError(403, 'This payment belongs to another account.');
  return { paid: true, booking: result.booking };
}

export async function refundStripePayment({ paymentIntentId, amountCents, bookingId }) {
  return stripe('POST', '/refunds', {
    payment_intent: String(paymentIntentId),
    amount: String(amountCents),
  }, { idempotencyKey: `refund_${bookingId}` });
}

export async function handleWebhook(rawBody, signatureHeader) {
  if (!config.stripeWebhookSecret) throw new HttpError(400, 'Webhook secret not configured.');
  const pairs = String(signatureHeader || '').split(',').map((p) => p.split('='));
  const timestamp = pairs.find(([k]) => k === 't')?.[1];
  const signatures = pairs.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new HttpError(400, 'Stale webhook.');
  const expected = Buffer.from(crypto.createHmac('sha256', config.stripeWebhookSecret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`).digest('hex'));
  const valid = signatures.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), expected));
  if (!valid) throw new HttpError(400, 'Bad signature.');

  const event = JSON.parse(rawBody.toString('utf8'));
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    await markBookingPaid(event.data.object);
  } else if (event.type === 'checkout.session.expired') {
    const bid = event.data.object?.metadata?.booking_id || event.data.object?.client_reference_id;
    if (bid) await expirePendingBooking(bid);
  }
}
