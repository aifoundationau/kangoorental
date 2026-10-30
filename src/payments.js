import crypto from 'node:crypto';
import { config } from './config.js';
import { firestore, col, FieldValue, nowIso, audit } from './db.js';
import { HttpError } from './security.js';

// Tokens cost USD $1.00 each and are charged in USD through Stripe Checkout. Credits are idempotent
// on the Stripe session id, so the success redirect and the webhook can both run without double-crediting.

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

export async function createCheckout(user, tokens) {
  return stripe('POST', '/checkout/sessions', {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(tokens * 100),
    'line_items[0][price_data][product_data][name]': `${tokens} Kangoo Rental tokens`,
    'line_items[0][price_data][product_data][description]': 'Prepaid rental credit - 1 token = USD $1.00',
    customer_email: user.email,
    client_reference_id: String(user.id),
    'metadata[user_id]': String(user.id),
    'metadata[tokens]': String(tokens),
    success_url: `${config.baseUrl}/account?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.baseUrl}/account?purchase=cancelled`,
  });
}

export async function creditTokens({ userId, tokens, provider, providerRef, note }) {
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
      amountCents: tokens * 100,
      currency: 'USD',
      provider,
      providerRef: providerRef ?? null,
      note: note ?? null,
      createdAt: nowIso(),
    });
    t.update(userRef, { tokenCents: FieldValue.increment(tokens * 100) });
    return true;
  });
  if (credited) audit(userId, 'tokens.purchase', `${tokens} tokens via ${provider}`);
  return credited;
}

async function creditFromSession(session) {
  if (session.payment_status !== 'paid') return false;
  const userId = String(session.metadata?.user_id || session.client_reference_id || '');
  const tokens = Number(session.metadata?.tokens);
  if (!userId || !Number.isInteger(tokens) || tokens <= 0) return false;
  if (session.currency !== 'usd' || session.amount_total !== tokens * 100) {
    console.error('[stripe] amount mismatch on', session.id);
    return false;
  }
  return creditTokens({ userId, tokens, provider: 'stripe', providerRef: session.id });
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
