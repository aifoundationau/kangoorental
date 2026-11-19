# Data Contracts (`data-contracts.MD`)

All API, UI, and SuperAdmin settings inputs are validated on the server with strict rules (`additionalProperties: false` semantics via `SETTING_RULES` and field validators in `src/util.js`, `src/routes/bookings.js`, and `src/routes/admin.js`). All financial values, quotes, payments, refunds, and Stripe Tax Invoices are strictly in **Australian dollars (`AUD`)**.

## 1. AUD Pricing Contract (`PUT /api/admin/settings`)

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "price_table": {
      "type": "string",
      "pattern": "^\\d+(,\\d+){0,29}$",
      "description": "Comma-separated whole AUD ex-GST prices for 1..N day hires (monotonic non-decreasing)"
    },
    "discount_table": {
      "type": "string",
      "pattern": "^\\d+(\\.\\d+)?(,\\d+(\\.\\d+)?){0,29}$",
      "description": "Comma-separated discount percentages for 1..N day hires (day 1 is 0%, days 2..N default to 5%)"
    },
    "gst_rate_bp": {
      "type": "integer",
      "minimum": 0,
      "maximum": 5000,
      "description": "Australian GST in basis points (1000 = 10%)"
    },
    "first_pickup_hour": {
      "type": "integer",
      "minimum": 0,
      "maximum": 23,
      "description": "Start of standard pickup window in Brisbane/Arundel time (default: 9 = 9:00 AM)"
    },
    "last_pickup_hour": {
      "type": "integer",
      "minimum": 0,
      "maximum": 23,
      "description": "End of standard pickup window in Brisbane/Arundel time (default: 10 = 10:00 AM)"
    },
    "first_return_hour": {
      "type": "integer",
      "minimum": 0,
      "maximum": 23,
      "description": "Start of next-day / return-day drop-off window in Brisbane/Arundel time (default: 8 = 8:00 AM)"
    },
    "last_return_hour": {
      "type": "integer",
      "minimum": 0,
      "maximum": 23,
      "description": "End of next-day / return-day drop-off window in Brisbane/Arundel time (default: 9 = 9:00 AM)"
    },
    "handover_weekdays": {
      "type": "string",
      "pattern": "^([0-6](,[0-6])*)?$",
      "description": "Comma-separated open handover weekdays 0=Sun..6=Sat (default: 1,2,3,4,5 Mon-Fri; Sat/Sun require messaging admin first)"
    }
  }
}
```

## 2. AUD Quote Response Contract (`GET /api/quote?days=1..7`)

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "days",
    "currency",
    "gstRateBp",
    "listSubtotalCents",
    "discountCents",
    "subtotalCents",
    "gstCents",
    "totalCents",
    "listTotalCents",
    "discountIncGstCents"
  ],
  "properties": {
    "days": { "type": "integer", "minimum": 1, "maximum": 7 },
    "currency": { "type": "string", "const": "AUD" },
    "gstRateBp": { "type": "integer", "minimum": 0, "maximum": 5000 },
    "listSubtotalCents": { "type": "integer", "minimum": 100 },
    "discountCents": { "type": "integer", "minimum": 0 },
    "subtotalCents": { "type": "integer", "minimum": 100 },
    "gstCents": { "type": "integer", "minimum": 0 },
    "totalCents": { "type": "integer", "minimum": 100 },
    "listTotalCents": { "type": "integer", "minimum": 100 },
    "discountIncGstCents": { "type": "integer", "minimum": 0 }
  }
}
```

## 3. Direct AUD Booking Creation Contract (`POST /api/bookings`)

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["date", "time", "days", "acceptDisclaimer", "lat", "lng"],
  "properties": {
    "date": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
    "time": { "type": "string", "pattern": "^\\d{2}:00$" },
    "days": { "type": "integer", "minimum": 1, "maximum": 7 },
    "acceptDisclaimer": { "type": "boolean", "const": true },
    "note": { "type": "string", "maxLength": 500 },
    "lat": { "type": "number", "minimum": -90, "maximum": 90 },
    "lng": { "type": "number", "minimum": -180, "maximum": 180 }
  }
}
```
Server invariants for `POST /api/bookings`:
- **Weekdays & weekend rule:** Standard online pickups and drop-offs operate **Monday–Friday** (`handover_weekdays: "1,2,3,4,5"`). Bookings attempting to pick up or drop off on **Saturday or Sunday** (without a SuperAdmin single-date override) are rejected (`400`) and direct the customer to message admin first.
- **Handover hours:** Standard pickup is `first_pickup_hour..last_pickup_hour` (`09:00–10:00`), and `endAt` is scheduled on `addDays(date, days)` at `first_return_hour` (`08:00`, window `08:00–09:00`); pickup hours outside that window return `400` prompting customers to message admin for an earlier time.

## 4. Stripe Direct AUD Booking Checkout & Refund Contract (`src/payments.js`)

- Currency: strictly **`aud`** (`AUD`). Non-AUD sessions are rejected by `markBookingPaid()`.
- Automatic Stripe Tax: `automatic_tax: { enabled: true }` with `tax_behavior: "exclusive"` on the single ex-GST `subtotalCents` line item (Stripe adds 10% Australian GST natively).
- Official Tax Invoices: `invoice_creation: { enabled: true }` on `mode: "payment"`.
- Hold & idempotency: pending Stripe bookings create a 31-minute calendar hold (`status: "pending_payment"`), pass `Idempotency-Key: booking_checkout_<bookingId>` on session creation, and confirm idempotently on `payments/stripe_<sessionId>`.
- Refunds: cancellations eligible for refund call `POST /v1/refunds` with `payment_intent`, `amount` in integer AUD cents, and `Idempotency-Key: refund_<bookingId>`.

## 5. AUD Payment Ledger Response Contract (`GET /api/account/payments`)

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["payments"],
  "properties": {
    "payments": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "bookingId", "bookingRef", "kind", "amountCents", "currency", "provider", "createdAt"],
        "properties": {
          "id": { "type": "string" },
          "bookingId": { "type": "string" },
          "bookingRef": { "type": "string" },
          "kind": { "type": "string", "enum": ["payment", "refund"] },
          "amountCents": { "type": "integer" },
          "subtotalCents": { "type": ["integer", "null"] },
          "gstCents": { "type": ["integer", "null"] },
          "currency": { "type": "string", "const": "AUD" },
          "provider": { "type": "string", "enum": ["stripe", "demo"] },
          "note": { "type": ["string", "null"] },
          "createdAt": { "type": "string" }
        }
      }
    }
  }
}
```

## 6. Google OAuth 2.0 Authentication Contract (`GET /api/auth/google/start`, `GET /api/auth/google/callback`, `POST /api/auth/google`)

- **Authorization Code + PKCE Flow (`GET /api/auth/google/start`):**
  - Accepts optional safe relative `next` query string (`^/(?!/)`).
  - Sets `HttpOnly; SameSite=Lax` state cookie (`kr_goauth` locally, `__Host-kr_goauth` in production) containing `{ state, verifier, next }`.
  - Redirects (`302`) to Google OAuth 2.0 (`https://accounts.google.com/o/oauth2/v2/auth`) with `code_challenge_method=S256` and `scope=openid email profile`.
- **Callback (`GET /api/auth/google/callback`):**
  - Consumes and clears the state cookie, verifies `state` in constant time (`crypto.timingSafeEqual`), exchanges `code` + `codeVerifier` via `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`, and validates the returned `id_token` (`email_verified === true`).
  - First-time registration creates a Firestore `users` document with **`role: "supporter"`** (unless the verified email is listed in `SUPERADMIN_EMAILS`).
- **ID Token Sign-In (`POST /api/auth/google`):**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["credential"],
  "properties": {
    "credential": { "type": "string", "minLength": 100, "maxLength": 5000 }
  }
}
```

## 7. Contractor Distribution Ledger Contracts (`/api/admin/ledger/*`)

### 7.1 Contractor & Split Settings (`PUT /api/admin/ledger/config` — SuperAdmin only)

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "contractor_a_name": { "type": "string", "minLength": 2, "maxLength": 80 },
    "contractor_a_role": { "type": "string", "minLength": 2, "maxLength": 200 },
    "contractor_a_share_pct": { "type": "integer", "minimum": 0, "maximum": 100 },
    "contractor_b_name": { "type": "string", "minLength": 2, "maxLength": 80 },
    "contractor_b_role": { "type": "string", "minLength": 2, "maxLength": 200 },
    "contractor_b_share_pct": { "type": "integer", "minimum": 0, "maxLength": 100 },
    "distribution_gst_basis": { "type": "string", "enum": ["ex_gst", "inc_gst"] }
  }
}
```
Server invariant: `contractor_a_share_pct + contractor_b_share_pct === 100`.

### 7.2 Record Cash Payment (`POST /api/admin/ledger/cash` — Admin & SuperAdmin)

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["amountAud", "note"],
  "properties": {
    "entryDate": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
    "amountAud": { "type": "number", "minimum": 0.01, "maximum": 100000 },
    "collectedBy": { "type": "string", "enum": ["contractor_a", "contractor_b"] },
    "bookingRef": { "type": "string", "maxLength": 40 },
    "note": { "type": "string", "minLength": 3, "maxLength": 300 }
  }
}
```
Server invariant: regular `admin` users are always recorded as `collectedBy: "contractor_b"` (Car Shop).

### 7.3 Record Contractor Distribution (`POST /api/admin/ledger/distributions` — SuperAdmin only)

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["fromContractor", "toContractor", "amountAud", "note"],
  "properties": {
    "entryDate": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
    "fromContractor": { "type": "string", "enum": ["contractor_a", "contractor_b"] },
    "toContractor": { "type": "string", "enum": ["contractor_a", "contractor_b"] },
    "amountAud": { "type": "number", "minimum": 0.01, "maximum": 100000 },
    "method": { "type": "string", "enum": ["bank_transfer", "cash", "stripe_payout", "other"] },
    "reference": { "type": "string", "maxLength": 80 },
    "note": { "type": "string", "minLength": 3, "maxLength": 300 }
  }
}
```
Server invariant: `fromContractor !== toContractor`.

### 7.4 Delete Manual Ledger Entry (`DELETE /api/admin/ledger/:id` — SuperAdmin only)
- Only manual `ledgerEntries` documents (`cash_payment` or `distribution`) can be deleted; Stripe/demo `payments` booking records cannot be deleted.

## 8. Customer–Admin In-App Messaging & 7-Year Retention Contract

- **Direct Entry Route (`GET /messages`):**
  - Unauthenticated guests → `302` `/login?next=%2Fmessages`
  - Customers (any non-staff account, regardless of location or licence status) → `302` `/account?tab=messages#messages`
  - Staff (`admin` / `superadmin`) → `302` `/admin#messages`
- **Customer Message Send (`POST /api/messages`):**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["body"],
  "properties": {
    "body": { "type": "string", "minLength": 1, "maxLength": 2000 }
  }
}
```
- **7-Year Retention Invariant (`threads/{userId}` & `threads/{userId}/messages/{msgId}`):**
  - Every message and thread stores `retentionYears: 7`, `retainUntil` (ISO-8601 UTC timestamp `createdAt + 7 years`), and `retainUntilAt` (Firestore `Timestamp`).
  - Both `GET /api/messages` and `GET /api/admin/threads/:userId` return `retentionYears: 7` and per-message `retainUntil`.
  - **Account Deletion (Superadmin-only: `DELETE /api/admin/users/:id`, `DELETE /api/admin/staff/:id`; `POST /api/account/delete` returns `403`):** Nobody can self-delete their own account (including superadmins attempting to delete themselves via `DELETE /api/admin/staff/:id`, which returns `400`). Only a `superadmin` can delete a customer account (refused with `409` while the customer has active/confirmed/pending bookings) or another staff account via an inline Confirm-delete prompt in `/admin`. On customer deletion, personal profile fields are removed, Sessions are revoked, bookings are anonymised, and the thread header is anonymised (`fullName: "Deleted customer"`, `archivedAt` set), while all messages in `threads/{userId}/messages` are preserved for the full **7 years**. Archived threads remain readable via `GET /api/admin/threads/:userId` (`archived: true`) and become read-only (`POST` returns `409`).

## 9. Front & Back Driver Licence Verification & Superadmin Customer Profiles

- **Upload Endpoints (`POST /api/auth/register`, `POST /api/account/licence`):**
  - Multipart form-data with **both** required JPEG/PNG/WebP image fields (`<= 4 MB` each, processed strictly in memory and zeroed in `finally`):
    - `licence` (front of Australian driver licence)
    - `licenceBack` (back of Australian driver licence)
- **Gemini Extraction Schema (`LicenceSchema` via `@google/genai`, default `gemini-4-hydrogen` with fallback to `gemini-3.5-flash-lite`):**
  - `additionalProperties: false`; extracts and stores on `users/{id}` (`licenceCardNumber`, `licenceAuthority`, `licenceType`, `licenceClass`, `licenceConditions`, `licenceIssueDate`, `licenceExpiry`, `licenceAddressFront`, `licenceAddressBack`, `licenceBriefDescription`, `licenceFrontProvided`, `licenceBackProvided`, plus full `licenceExtracted` forensic object including `automaticOnly`, `hasBarcode`, `securityFeatures`, `backTextSummary`, `tamperingSuspected`, `tamperingIndicators`, `extractedAt`, and `model`).
  - Automatic-only licences (`automatic_only: true` / Condition A) trigger `pending` manual review because the Kangoo MAXI has a 6-speed manual transmission.
- **Superadmin Profile Endpoints (`GET /api/admin/users`, `GET /api/admin/users/:id`):**
  - Lists all non-staff customer profiles (active, disabled, and deleted/archived for `superadmin`; supports `?q=` search across name, email, phone, licence/card numbers, suburb/address and `?status=` filter).
  - Returns full profile details, bookings, AUD payments, and `licenceExtracted` forensic payload for `superadmin`.
