import crypto from 'node:crypto';
import { config } from './config.js';
import { firestore, col, FieldValue, nowIso, audit, getSettings } from './db.js';
import { currentRate } from './fx.js';
import { HttpError } from './security.js';

// Rentals and token packs are charged in AUD through Stripe Checkout with native Stripe Tax
// (automatic_tax: { enabled: true }, tax_behavior: "exclusive", and invoice_creation: { enabled: true }).
// Stripe Checkout automatically detects the buyer's country on the payment page, adding 10% GST on top
// if the buyer is in Australia and $0 tax if outside Australia. Credits are idempotent on the Stripe session id.

export const paymentsMode = config.stripeSecretKey ? 'stripe' : config.allowDemoPayments ? 'demo' : 'disabled';

async function stripe(method, path, params) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('[stripe]', data?.error?.message || res.status);
    throw new HttpError(502, 'Payment provider error. Please try again.');
  }
  return data;
}

export async function createCheckout(user, tokens, { days } = {}) {
  const settings = await getSettings();
  const tokenPriceAud = Number(settings.token_price_aud) || 1;

  // Base price in AUD (always whole AUD dollars, rounded up; Stripe Tax adds 10% GST for AU, $0 outside AU)
  const baseAud = Math.ceil(tokens * tokenPriceAud);
  const unitAmountCents = baseAud * 100;

  return stripe('POST', '/checkout/sessions', {
    mode: 'payment',
    customer_email: user.email,
    client_reference_id: String(user.id),
    'metadata[user_id]': String(user.id),
    'metadata[tokens]': String(tokens),
    'metadata[base_aud]': String(baseAud),

    // Automatic Stripe Tax (detects buyer country automatically on payment page)
    'automatic_tax[enabled]': 'true',

    // Official Tax Invoices on one-time payments
    'invoice_creation[enabled]': 'true',
    'invoice_creation[invoice_data][description]': 'Tax Invoice - Renault Kangoo MAXI Van Hire',
    'invoice_creation[invoice_data][footer]': 'Kangoo Rental · Renault Kangoo MAXI Diesel 1.5 Manual 6-Speed · Wishart QLD 4122 · All invoices are in Australian dollars (AUD).',

    // Single line item with exclusive tax behavior (Stripe adds 10% GST in Australia, $0 outside Australia)
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'aud',
    'line_items[0][price_data][tax_behavior]': 'exclusive',
    'line_items[0][price_data][unit_amount]': String(unitAmountCents),
    'line_items[0][price_data][product_data][name]': days
      ? `Renault Kangoo MAXI Van Hire - ${days} day${days > 1 ? 's' : ''}`
      : `${tokens} Kangoo Rental Tokens`,
    'line_items[0][price_data][product_data][description]': 'Renault Kangoo MAXI Diesel 1.5 Manual 6-Speed · Wishart QLD 4122 depot',

    success_url: `${config.baseUrl}/account?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.baseUrl}/account?purchase=cancelled`,
  });
}

export async function creditTokens({ userId, tokens, provider, providerRef, note, amountCents, currency }) {
  // A provider reference becomes the ledger document id, so the same payment can only be credited once.
  const txRef = providerRef ? col.tokenTransactions.doc(`${provider}_${providerRef}`) : col.tokenTransactions.doc();
  const userRef = col.users.doc(userId);
  const credited = await firestore.runTransaction(async (t) => {
    const [existing, user] = await Promise.all([t.get(txRef), t.get(userRef)]);
    if (existing.exists || !user.exists) return false;
    t.create(txRef, {
      userId,
      deltaCents: tokens * 100,
      kind: 'purchase',
      amountCents: amountCents ?? tokens * 100,
      currency: currency ?? 'AUD',
      provider,
      providerRef: providerRef ?? null,
      note: note ?? null,
      createdAt: nowIso(),
    });
    t.update(userRef, { tokenCents: FieldValue.increment(tokens * 100) });
    return true;
  });
  if (credited) audit(userId, 'tokens.purchase', `${tokens} tokens via ${provider} (${currency || 'AUD'}${(amountCents || tokens * 100) / 100})`);
  return credited;
}

async function creditFromSession(session) {
  if (session.payment_status !== 'paid') return false;
  const userId = String(session.metadata?.user_id || session.client_reference_id || '');
  const tokens = Number(session.metadata?.tokens);
  if (!userId || !Number.isInteger(tokens) || tokens <= 0) return false;
  if (session.currency !== 'aud' && session.currency !== 'usd') {
    console.error('[stripe] unexpected currency on', session.id, session.currency);
    return false;
  }
  return creditTokens({
    userId,
    tokens,
    provider: 'stripe',
    providerRef: session.id,
    amountCents: session.amount_total,
    currency: (session.currency || 'aud').toUpperCase(),
    note: `Stripe invoice ${session.invoice || session.id}`,
  });
}

export async function confirmCheckout(sessionId, userId) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new HttpError(400, 'Invalid payment reference.');
  const session = await stripe('GET', `/checkout/sessions/${sessionId}`);
  if (session.client_reference_id !== userId) throw new HttpError(403, 'This payment belongs to another account.');
  if (session.payment_status !== 'paid') return { credited: false, paid: false };
  return { credited: await creditFromSession(session), paid: true };
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
    await creditFromSession(event.data.object);
  }
}
