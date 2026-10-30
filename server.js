import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { config, ROOT } from './src/config.js';
import { col, getSettings, initSettings, num } from './src/db.js';
import {
  HttpError, loadSession, csrfGuard, securityHeaders, purgeExpiredSessions, hashPassword, isStaff,
} from './src/security.js';
import { handleWebhook, paymentsMode } from './src/payments.js';
import { startFxUpdates } from './src/fx.js';
import { router as authRouter, createUser } from './src/routes/auth.js';
import { router as bookingsRouter } from './src/routes/bookings.js';
import { router as accountRouter } from './src/routes/account.js';
import { router as adminRouter } from './src/routes/admin.js';
import { router as hubRouter } from './src/routes/hub.js';

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

app.use(securityHeaders);
app.use(express.static(path.join(ROOT, 'public'), { maxAge: config.isProduction ? '1h' : 0 }));

// Stripe needs the raw body to verify its signature, so this route comes before the JSON parser.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  await handleWebhook(req.body, req.get('stripe-signature'));
  res.json({ received: true });
});

app.use(express.json({ limit: '100kb' }));
app.use(loadSession);
app.use('/api', csrfGuard);
app.use('/api', authRouter, bookingsRouter, accountRouter, adminRouter, hubRouter);
app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found.')));

/* ---------- Server-rendered pages ---------- */

// Templates are read per request so edits show up without a restart. Only src/ is watched in dev:
// on drives that record last-access times, watching folders the server reads from triggers restart loops.
const readView = (name) => fs.readFileSync(path.join(ROOT, 'views', name), 'utf8');
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PAGES = {
  '/': { view: 'pages/home.html', title: 'Renault Kangoo van hire in Wishart, Brisbane', script: 'home.js' },
  '/login': { view: 'pages/login.html', title: 'Log in', script: 'login.js' },
  '/register': { view: 'pages/register.html', title: 'Create your account', script: 'register.js' },
  '/account': { view: 'pages/account.html', title: 'My account', script: 'account.js', auth: 'user' },
  '/admin': { view: 'pages/admin.html', title: 'Admin panel', script: 'admin.js', auth: 'staff' },
  '/rental-disclaimer': { view: 'legal/disclaimer.html', title: 'Rental disclaimer & insurance requirements' },
  '/founder-welcome': { view: 'legal/founder-welcome.html', title: 'Founder Welcome' },
  '/privacy': { view: 'legal/privacy.html', title: 'Privacy Policy' },
  '/terms': { view: 'legal/terms.html', title: 'Terms of Service' },
  '/ai-policy': { view: 'legal/ai-policy.html', title: 'AI Policy (ISO/IEC 42001)' },
  '/security-policy': { view: 'legal/security-policy.html', title: 'Security Policy (ISO/IEC 27001)' },
};
const NOT_FOUND = { view: 'pages/404.html', title: 'Page not found' };

async function pageContext() {
  const s = await getSettings();
  return {
    business_name: s.business_name,
    pickup_label: s.pickup_label,
    radius_km: s.registration_radius_km,
    min_age: s.min_driver_age,
    gst_percent: String(num(s, 'gst_rate_bp') / 100),
    cancellation_hours: s.cancellation_hours,
    indemnity: `$${(num(s, 'required_indemnity_cents') / 100).toLocaleString('en-AU')}`,
    contact_email: s.contact_email ? `at ${s.contact_email}` : 'through the message centre in your account',
    contact_phone: s.contact_phone || '',
    session_days: String(config.sessionDays),
  };
}

async function render(page) {
  const ctx = await pageContext();
  const fill = (tpl) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in ctx ? escapeHtml(ctx[k]) : m));
  const body = readView(page.view);
  return fill(readView('layout.html')
    .replace('{{page_title}}', () => escapeHtml(`${page.title} | ${ctx.business_name}`))
    .replace('{{page_script}}', () => (page.script ? `<script type="module" src="/js/${page.script}"></script>` : ''))
    .replace('{{body}}', () => body));
}

for (const [route, page] of Object.entries(PAGES)) {
  app.get(route, async (req, res) => {
    if (page.auth && !req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (page.auth === 'staff' && !isStaff(req.user)) return res.redirect('/account');
    if (page.auth === 'user' && isStaff(req.user)) return res.redirect('/admin');
    res.type('html').send(await render(page));
  });
}

app.use(async (req, res) => res.status(404).type('html').send(await render(NOT_FOUND)));

/* ---------- Errors ---------- */

app.use((err, req, res, next) => {
  let status = err.status || 500;
  let message = err.message;
  if (err instanceof multer.MulterError) {
    status = 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'Licence photo must be smaller than 5 MB.' : 'Upload failed. Please try again.';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Invalid request.';
  } else if (!(err instanceof HttpError || err.expose) || status >= 500) {
    console.error(err);
    status = 500;
    message = 'Something went wrong on our side. Please try again.';
  }
  if (req.path.startsWith('/api')) return res.status(status).json({ error: message });
  res.status(status).type('text').send(message);
});

/* ---------- Startup ---------- */

async function ensureSuperadmin() {
  const existing = await col.users.where('role', '==', 'superadmin').limit(1).get();
  if (!existing.empty) return;
  const email = (config.adminEmail || 'superadmin@kangoo.local').toLowerCase();
  const password = config.adminPassword || crypto.randomBytes(12).toString('base64url');
  await createUser({ role: 'superadmin', email, fullName: 'Superadmin', passwordHash: await hashPassword(password) });
  console.log('\n  Superadmin account created');
  console.log(`    email:    ${email}`);
  if (!config.adminPassword) console.log(`    password: ${password}   <- shown once; change it after logging in`);
  console.log('');
}

const housekeeping = () => purgeExpiredSessions().catch((err) => console.warn('[sessions] purge failed:', err.message));

console.log(`Connecting to Firestore database "${config.firestoreDatabase}"${process.env.FIRESTORE_EMULATOR_HOST ? ` (emulator ${process.env.FIRESTORE_EMULATOR_HOST})` : ''}…`);
await initSettings();
await ensureSuperadmin();
housekeeping();
setInterval(housekeeping, 3600 * 1000).unref();
startFxUpdates();

// Express 5 passes listen errors (e.g. port in use) to this callback instead of throwing.
app.listen(config.port, (err) => {
  if (err) {
    console.error(err.code === 'EADDRINUSE'
      ? `\nPort ${config.port} is already in use. Stop the other server, or set a different PORT in .env.\n`
      : err);
    process.exit(1);
  }
  console.log(`Kangoo Rental running at ${config.baseUrl}`);
  console.log(`  payments: ${paymentsMode}   licence AI: ${config.licenceAiEnabled ? config.licenceModel : 'off (manual review)'}`);
});
