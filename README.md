# Kangoo Rental

Renault Kangoo MAXI (1.5L Diesel Manual 6-Speed) van hire in Arundel, Gold Coast. Customers register, get their driver licence checked,
add their insurance, and book the van by the day in Australian dollars (AUD). Staff run everything from the admin panel.

Node.js + Express, Google Cloud Firestore (database `kangoorental`), Google Gemini for licence checks, Stripe for payments.

## Run it locally

```bash
git clone https://github.com/aifoundationau/kangoorental.git
cd kangoorental
npm install
npm run emulator          # terminal 1: local Firestore emulator (needs Java + Firebase CLI)
npm run dev:emulator      # terminal 2: app on http://localhost:3000 using the emulator
```

On first start the app creates a superadmin and prints the login. Set `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`
to choose them. Without Stripe or Gemini keys, payments run in **demo mode** and licences go to **manual review**.

To use the live database instead: copy `.env.example` to `.env`, run `gcloud auth application-default login`, then `npm start`.

Smoke test (against the emulator only, never the live database):

```bash
BASE=http://localhost:3000 ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run smoke
```

## How pricing works

All prices, payments, refunds, and tax invoices are strictly in **Australian dollars (AUD)** with 10% Australian GST added:

- **Default 1-day rate:** `AUD$90` ex. GST + `AUD$9` GST = **`AUD$99` inc. GST** (customizable by the superadmin under *Admin → Pricing (AUD)*).
- **Multi-day discounts:** days 2–7 default to a 5% discount from the 1-day ex-GST rate (`AUD$90, $171, $257, $342, $428, $513, $599` ex. GST; `AUD$99, $188.10, $282.70, $376.20, $470.80, $564.30, $658.90` inc. GST).
- **Stripe Checkout:** charges in `aud` with `automatic_tax: { enabled: true }`, `tax_behavior: "exclusive"`, and official AUD Tax Invoices. Each booking stores the AUD amounts it was charged at; price changes never affect confirmed bookings.

## Roles

| Role | Can do |
|---|---|
| Customer | Book & pay in AUD, manage licence/insurance/profile, cancel eligible bookings for AUD refund, message staff |
| Admin | Bookings, customers, licence review, messages, calendar blocks |
| Superadmin | Everything above, plus AUD pricing, site settings and staff accounts |

`npm run create-admin -- <email> <password> [admin|superadmin]` creates staff or resets a staff password.

## Licence checks

The photo is kept in memory, sent once to Google Gemini (`gemini-3.8-flash`) to read the licence, compared with the details the
customer typed, then discarded. **It is never written to disk or the database.** Mismatches are rejected with a reason;
provisional licences, possible tampering and any AI outage go to manual review. Set `GEMINI_API_KEY` to enable.

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
