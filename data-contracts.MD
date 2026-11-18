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
