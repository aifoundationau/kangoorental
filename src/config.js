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
const googleClientId = (env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
const googleClientSecret = (env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();

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

  // Stripe (optional). Without a key, direct AUD booking payments run in demo mode outside production.
  stripeSecretKey: env.STRIPE_PAYMENTS === 'off' ? '' : (env.STRIPE_SECRET_KEY || ''),
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  allowDemoPayments: env.ALLOW_DEMO_PAYMENTS
    ? env.ALLOW_DEMO_PAYMENTS === 'true'
    : env.NODE_ENV !== 'production',

  // Gemini licence verification (optional). Without credentials, licences go to manual admin review.
  geminiApiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '',
  licenceAiEnabled: Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY) && env.LICENCE_AI !== 'off',
  licenceModel: env.LICENCE_MODEL || 'gemini-3.8-flash',

  // Google OAuth 2.0 (Authorization Code + PKCE, plus ID token verification).
  // Credentials come strictly from environment variables (never hardcoded).
  googleClientId,
  googleClientSecret,
  googleOAuthEnabled: Boolean(googleClientId && googleClientSecret),

  // Google accounts that are always superadmin when they sign in with Google (comma-separated). Defaults to the
  // Firebase project owner. Only Google sign-in counts: it proves the email, a password sign-up doesn't.
  superadminEmails: (env.SUPERADMIN_EMAILS ?? 'support@aifoundation.net.au').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),

  adminEmail: env.ADMIN_EMAIL || '',
  adminPassword: env.ADMIN_PASSWORD || '',

  sessionDays: 14,
  // Vercel rejects request bodies over 4.5 MB; browsers shrink photos before upload, so this is rarely reached.
  maxLicenceBytes: 4 * 1024 * 1024,
};

// Defaults written to the settings table on first run; all editable by the superadmin.
// AUD-only pricing; `price_table` holds whole AUD ex-GST per hire length, +10% GST added.
export const DEFAULT_SETTINGS = {
  business_name: 'Kangoo Rental',
  gst_rate_bp: '1000',               // 10% GST, in basis points
  // Price list: total whole AUD ex GST for a 1, 2, 3... day hire (superadmin edits it under Pricing).
  price_table: '90,171,257,342,428,513,599',
  // Configured discount percentages for hire lengths 1..7 (day 1 is 0%, days 2..7 default to 5%).
  discount_table: '0,5,5,5,5,5,5',
  min_driver_age: '21',
  registration_radius_km: '50',
  pickup_label: 'Arundel QLD 4214',
  pickup_lat: '-27.9377',
  pickup_lng: '153.3630',
  cancellation_hours: '48',
  buffer_hours: '1',
  min_notice_hours: '4',
  max_rental_days: '7',
  // Days the van can be picked up or returned (the owner works on other days). handover_weekdays is the usual week
  // (0 = Sunday ... 6 = Saturday); handover_overrides switches single dates on or off: "2026-11-03:0,2026-11-07:1".
  handover_weekdays: '0,1,2,3,4,5,6',
  handover_overrides: '',
  max_advance_days: '180',
  first_pickup_hour: '7',
  last_pickup_hour: '18',
  required_indemnity_cents: '200000000', // AUD $2,000,000
  contact_email: '',
  contact_phone: '',
  announcement: '',
  // Contractor distribution ledger defaults (editable by superadmin)
  contractor_a_name: 'David Robertson',
  contractor_a_role: 'Maintains booking system, Stripe payments, distributions',
  contractor_a_share_pct: '50',
  contractor_b_name: 'Car Shop (TBD)',
  contractor_b_role: 'Maintains registration, insurance, cash payments',
  contractor_b_share_pct: '50',
  distribution_gst_basis: 'ex_gst', // 'ex_gst' | 'inc_gst'
};
