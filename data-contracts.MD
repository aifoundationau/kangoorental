# Data Contracts (`data-contracts.MD`)

All API, UI, and SuperAdmin settings inputs are validated on the server with strict rules (`additionalProperties: false` semantics via `SETTING_RULES` and field validators in `src/util.js` and `src/routes/admin.js`).

## 1. Pricing, Token Economy & Currency Conversion Contract (`PUT /api/admin/settings`)

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "price_basis": { "type": "string", "enum": ["aud", "tokens"] },
    "token_price_aud": { "type": "integer", "minimum": 1, "maximum": 1000, "description": "Default 1 token = AUD$1" },
    "token_share_fee": { "type": "integer", "minimum": 0, "maximum": 1000, "description": "Token fee to transfer/share tokens" },
    "price_table": {
      "type": "string",
      "pattern": "^\\d+(,\\d+){0,29}$",
      "description": "Comma-separated whole AUD ex-GST prices for 1..N day hires (monotonic non-decreasing)"
    },
    "token_table": {
      "type": "string",
      "pattern": "^\\d+(,\\d+){0,29}$",
      "description": "Comma-separated customizable whole token amounts for 1..N day hires (defaults to 1 token per AUD$1 inc GST)"
    },
    "discount_table": {
      "type": "string",
      "pattern": "^\\d+(\\.\\d+)?(,\\d+(\\.\\d+)?){0,29}$",
      "description": "Comma-separated discount percentages for 1..N day hires (day 1 is 0%, days 2..N default to 5%)"
    },
    "gst_rate_bp": { "type": "integer", "minimum": 0, "maximum": 5000, "description": "Australian GST in basis points (1000 = 10%)" },
    "fx_mode": { "type": "string", "enum": ["live", "manual"] },
    "fx_manual_rate": { "type": "string", "pattern": "^\\d+(\\.\\d{1,4})?$", "description": "USD per AUD$1 conversion rate for visitors outside AU & NZ" },
    "token_packs": { "type": "string", "pattern": "^\\d+(,\\d+)*$" }
  }
}
```

## 2. Quote Response Contract (`GET /api/quote?days=1..7`)

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "days", "priceBasis", "fxRate", "usdPerAud", "gstRateBp",
    "listSubtotalCents", "discountCents", "subtotalCents", "gstCents", "totalCents",
    "listSubtotalTokenCents", "subtotalTokenCents", "tokenCents",
    "usdListSubtotalCents", "usdDiscountCents", "usdSubtotalCents", "usdGstCents", "usdTotalCents"
  ],
  "properties": {
    "days": { "type": "integer", "minimum": 1, "maximum": 7 },
    "priceBasis": { "type": "string", "enum": ["aud", "tokens"] },
    "fxRate": { "type": "number", "description": "USD per AUD$1 conversion rate" },
    "usdPerAud": { "type": "number", "description": "USD per AUD$1 conversion rate" },
    "gstRateBp": { "type": "integer" },
    "listSubtotalCents": { "type": "integer", "multipleOf": 100 },
    "discountCents": { "type": "integer", "multipleOf": 100 },
    "subtotalCents": { "type": "integer", "multipleOf": 100 },
    "gstCents": { "type": "integer", "multipleOf": 100 },
    "totalCents": { "type": "integer", "multipleOf": 100 },
    "listSubtotalTokenCents": { "type": "integer", "multipleOf": 100 },
    "subtotalTokenCents": { "type": "integer", "multipleOf": 100 },
    "tokenCents": { "type": "integer", "multipleOf": 100 },
    "usdListSubtotalCents": { "type": "integer", "multipleOf": 100 },
    "usdDiscountCents": { "type": "integer", "multipleOf": 100 },
    "usdSubtotalCents": { "type": "integer", "multipleOf": 100 },
    "usdGstCents": { "type": "integer", "multipleOf": 100 },
    "usdTotalCents": { "type": "integer", "multipleOf": 100 }
  }
}
```

## 3. Booking Creation Contract (`POST /api/bookings`)

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

## 4. Stripe Token Checkout Contract (`POST /api/tokens/checkout`)

- All Stripe Checkout sessions and automated tax invoices are issued in **Australian Dollars (`AUD`)**.
- Line Item 1: Base amount ex-GST (`AUD`).
- Line Item 2: Australian Goods & Services Tax (10% GST) (`AUD`).

