import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env here rather than with `node --env-file`: in watch mode that flag also watches the whole project root,
// and on Windows every node_modules read (last-access-time update) then restarts the server in a loop.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

// `--emulator` points the app at the local Firestore emulator (npm run emulator) so dev work never touches live data.
if (process.argv.includes('--emulator')) {
  process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8085';
  process.env.FIRESTORE_PROJECT_ID = 'demo-kangoo';
}

const env = process.env;

// Service account key for hosts without Google credentials (e.g. Vercel): raw JSON or base64-encoded JSON.
function serviceAccount() {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) return null;
  try {
    const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const key = JSON.parse(json);
    return { client_email: key.client_email, private_key: key.private_key, project_id: key.project_id };
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid service account JSON.');
  }
}

const vercelUrl = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '';

export const config = {
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || vercelUrl || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  isProduction: env.NODE_ENV === 'production',
  onVercel: Boolean(env.VERCEL),

  // Firestore (native mode). Locally this uses Application Default Credentials (gcloud auth application-default login);
  // on Vercel set GOOGLE_SERVICE_ACCOUNT_KEY. Set FIRESTORE_EMULATOR_HOST to use the local emulator instead.
  serviceAccount: serviceAccount(),
  firestoreProject: env.FIRESTORE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || '',
  firestoreDatabase: env.FIRESTORE_DATABASE_ID || 'kangoorental',

  // Stripe (optional). Without a key, token purchases run in demo mode outside production.
  stripeSecretKey: env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  allowDemoPayments: env.ALLOW_DEMO_PAYMENTS
    ? env.ALLOW_DEMO_PAYMENTS === 'true'
    : env.NODE_ENV !== 'production',

  // Claude licence verification (optional). Without credentials, licences go to manual admin review.
  licenceAiEnabled: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) && env.LICENCE_AI !== 'off',
  licenceModel: env.LICENCE_MODEL || 'claude-opus-5-5',

  // "Sign in with Google" (Google Identity Services). The client ID is public; no secret is needed because the
  // server verifies Google's signed ID token. Add each site origin to the client's Authorised JavaScript origins.
  googleClientId: env.GOOGLE_OAUTH_CLIENT_ID ?? '614773274800-9pooin0jia9ij91qjlk7r6r6ne02mbhg.apps.googleusercontent.com',

  adminEmail: env.ADMIN_EMAIL || '',
  adminPassword: env.ADMIN_PASSWORD || '',

  sessionDays: 14,
  // Vercel rejects request bodies over 4.5 MB; browsers shrink photos before upload, so this is rarely reached.
  maxLicenceBytes: 4 * 1024 * 1024,
};

// Defaults written to the settings table on first run; all editable by the superadmin.
// Money model: tokens are USD $1.00 each (stored as hundredths, "token cents"). The rental price is
// quoted in AUD; the USD->AUD rate converts between them and GST is added on the AUD amount.
export const DEFAULT_SETTINGS = {
  business_name: 'Kangoo Rental',
  price_basis: 'aud',                // 'aud' = daily rate fixed in AUD; 'tokens' = daily rate fixed in tokens (USD)
  daily_rate_aud_cents: '9000',      // AUD $90 ex GST per 24 hours (used when price_basis = aud)
  daily_rate_token_cents: '6300',    // 63 tokens ex GST per 24 hours (used when price_basis = tokens)
  gst_rate_bp: '1000',               // 10% GST, in basis points
  multiday_discount_step_bp: '1000', // each day after the first is another 10% off...
  multiday_discount_max_bp: '4000',  // ...up to 40% off (day 5), which then applies to every later day
  fx_mode: 'live',                   // 'live' = daily market rate, 'manual' = fx_manual_rate
  fx_manual_rate: '1.4300',          // AUD per USD 1.00
  fx_live_rate: '',
  fx_live_date: '',
  fx_live_source: '',
  fx_live_checked_at: '',
  token_packs: '70,140,210,500',
  min_driver_age: '21',
  registration_radius_km: '50',
  pickup_label: 'Wishart QLD 4122',
  pickup_lat: '-27.5540',
  pickup_lng: '153.1010',
  cancellation_hours: '48',
  buffer_hours: '1',
  min_notice_hours: '4',
  max_rental_days: '30',
  max_advance_days: '180',
  first_pickup_hour: '7',
  last_pickup_hour: '18',
  required_indemnity_cents: '200000000', // AUD $2,000,000
  contact_email: '',
  contact_phone: '',
  announcement: '',
};
