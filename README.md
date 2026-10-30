# Kangoo Rental

Renault Kangoo van hire in Wishart, Brisbane. Customers register (Brisbane area only), get their driver licence checked,
add their insurance, buy tokens and book the van by the 24 hours. Staff run everything from the admin panel.

Node.js + Express, Google Cloud Firestore (database `kangoorental`), Claude for licence checks, Stripe for payments.

## Run it locally

```bash
git clone https://github.com/aifoundationau/kangoorental.git
cd kangoorental
npm install
npm run emulator          # terminal 1: local Firestore emulator (needs Java + Firebase CLI)
npm run dev:emulator      # terminal 2: app on http://localhost:3000 using the emulator
```

On first start the app creates a superadmin and prints the login. Set `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`
to choose them. Without Stripe or Anthropic keys, payments run in **demo mode** and licences go to **manual review**.

To use the live database instead: copy `.env.example` to `.env`, run `gcloud auth application-default login`, then `npm start`.

Smoke test (against the emulator only, never the live database):

```bash
BASE=http://localhost:3000 ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run smoke
```

## How pricing works

Rental prices are in **AUD**; tokens cost **US$1.00 each**. The superadmin chooses, under *Admin → Pricing & currency*:

- **Fixed AUD price** (default A$90 ex GST): tokens = AUD ÷ rate. At US$1 = A$1.43: A$90 → 62.94 tokens, + GST → A$99.00 → **69.23 tokens**.
- **Fixed token price** (e.g. 62 tokens): AUD = tokens × rate. US$62 × 1.43 = A$88.66, + GST = A$97.53 → **68.20 tokens**.
- **Exchange rate:** live (ECB via Frankfurter, refreshed every 6 hours, ExchangeRate-API as backup) or a manual rate.

GST is added on the AUD amount and the customer pays the GST-inclusive total in tokens. Each booking stores the rate
and amounts it was charged at; price changes never affect confirmed bookings.

## Roles

| Role | Can do |
|---|---|
| Customer | Book, buy tokens, manage licence/insurance/profile, message staff |
| Admin | Bookings, customers, licence review, token adjustments, messages, calendar blocks |
| Superadmin | Everything above, plus pricing, currency, site settings and staff accounts |

`npm run create-admin -- <email> <password> [admin|superadmin]` creates staff or resets a staff password.

## Licence checks

The photo is kept in memory, sent once to Claude (`claude-opus-5-5`) to read the licence, compared with the details the
customer typed, then discarded. **It is never written to disk or the database.** Mismatches are rejected with a reason;
provisional licences, possible tampering and any AI outage go to manual review. Set `ANTHROPIC_API_KEY` to enable.
Requests opt into server-side refusal fallback (`fallbacks: "default"`).

## Before going live

- [ ] **Firestore location:** `kangoorental` is in `nam5` (USA). The Privacy Policy discloses this. For Australian data
      residency, create a database in `australia-southeast1` and set `FIRESTORE_DATABASE_ID`.
- [ ] **Backups:** the Security Policy says backups are scheduled. Turn them on, e.g.
      `gcloud firestore backups schedules create --database=kangoorental --recurrence=daily --retention=14d`
- [ ] **Session cleanup:** add a TTL policy on `sessions.expireAt`:
      `gcloud firestore fields ttls update expireAt --collection-group=sessions --enable-ttl --database=kangoorental`
- [ ] **Stripe:** set `STRIPE_SECRET_KEY`, add a webhook to `https://<your-domain>/api/stripe/webhook` for
      `checkout.session.completed` and `checkout.session.async_payment_succeeded`, and set `STRIPE_WEBHOOK_SECRET`.
- [ ] **Production settings:** `NODE_ENV=production`, `BASE_URL=https://<your-domain>`, `TRUST_PROXY=1` behind a load balancer.
      HTTPS is required: browsers only allow geolocation on secure origins.
- [ ] **Single instance:** rate limits are in memory. Run one instance (e.g. Cloud Run `--max-instances=1`) or move them to a shared store.
- [ ] **Policies:** the Privacy Policy, Terms, Rental Disclaimer, AI Policy and Security Policy are templates. Have them reviewed
      by a lawyer, and set the contact email and phone in *Admin → Settings*.
- [ ] **Map:** the OpenStreetMap embed is under OSM's fair-use policy; switch to a keyed map provider if traffic grows.
