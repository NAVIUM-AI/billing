# Frontend readiness inventory

_Last updated: 2026-07-23. Reviewers: TBD._

A single-file reference for a frontend developer starting work against Modules 1-4 of this API. Assumes zero backend context. Sourced entirely from the actual route files, validators, and services — every claim below is checkable against `src/` if it looks wrong.

## 1. Base URL and auth

- Base URL (dev): `http://localhost:8000/api/v1`.
- Auth: JWT bearer tokens. Send `Authorization: Bearer <accessToken>` on every request to a protected endpoint.
- Access token expiry: 15 minutes (`JWT_ACCESS_TTL`, default `"15m"` — `src/config/env.js`).
- Refresh token: an HttpOnly cookie (`refresh_token`), scoped to path `/api/v1/auth` so the browser only sends it back on auth endpoints, not on every request. It is never present in any JSON response body. Default expiry 30 days (`JWT_REFRESH_TTL`).
- Refresh rotation: every successful `POST /auth/refresh` issues a brand-new access token *and* a brand-new refresh token, replacing the cookie. The old refresh token is immediately revoked. If a client ever presents a refresh token that was already rotated away from, the server treats that as a signal of token theft: it revokes every refresh token for that user (forcing every session to re-login) and returns `401 REFRESH_TOKEN_REUSED`.
- CORS: currently permissive in this dev environment. Production origin allowlisting is not yet configured — treat this as an infrastructure task for whenever this ships beyond local dev, not something to build UI logic around today.

## 2. Auth flow

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    C->>S: POST /auth/signup { businessName, email, password, fullName }
    S-->>C: 201 { tenant, user }

    C->>S: POST /auth/login { email, password }
    S-->>C: 200 { user, accessToken } + Set-Cookie: refresh_token (HttpOnly)

    C->>S: GET /trips (Authorization: Bearer accessToken)
    S-->>C: 200 { ... }

    Note over C,S: 15 minutes pass, access token expires

    C->>S: GET /trips (Authorization: Bearer <expired>)
    S-->>C: 401 ACCESS_TOKEN_EXPIRED

    C->>S: POST /auth/refresh (cookie sent automatically)
    S-->>C: 200 { accessToken } + Set-Cookie: refresh_token (rotated)

    C->>S: GET /trips (Authorization: Bearer <new accessToken>)
    S-->>C: 200 { ... }

    C->>S: POST /auth/logout (cookie sent automatically)
    S-->>C: 204 No Content
```

`GET /auth/me` (requires `Authorization`) returns `{ "user": { ... } }` for the currently authenticated user — useful for a page-load "who am I" check without a full login round trip.

## 3. Response envelopes

There is **no uniform success envelope** — each endpoint documents its own shape, and they genuinely differ:

```json
{ "trip": { "...": "..." } }
{ "trips": [ "..." ], "pagination": { "...": "..." }, "aggregates": { "...": "..." } }
{ "vehicles": [ "..." ], "pagination": { "...": "..." } }
{ "groups": [ "..." ], "grand_total": { "...": "..." }, "filters_applied": { "...": "..." } }
```

Error responses **are** uniform:

```json
{
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "Human-readable text, safe to show as-is for 4xx.",
    "details": { "...": "optional, code-specific" }
  }
}
```

Always branch on `error.code`. `error.message` can change wording without notice; `error.code` is the stable contract. Every 4xx `message` is written to be shown directly to a user. 5xx messages are selectively masked (`500`/`502`/`503`/`504` become a generic `"Internal server error"`; other 5xx codes, notably `501`, pass their real message through — see ADR-007) — in practice, no endpoint in Modules 1-3 currently returns a 501, so this mostly matters for future-proofing.

## 4. Permission model

Reproduced from `src/config/accessMatrix.js` (the authoritative source — cross-check there if this table and the code ever disagree):

| Permission key | Roles allowed |
| --- | --- |
| `settings:read` | owner, admin, accountant, staff, viewer |
| `settings:update` | owner, admin |
| `users:list` | owner, admin, accountant, viewer |
| `users:create` | owner, admin |
| `users:update_role` | owner, admin |
| `users:deactivate` | owner, admin |
| `customers:read` | owner, admin, accountant, staff, viewer |
| `customers:write` | owner, admin, accountant, staff |
| `vehicles:read` | owner, admin, accountant, staff, viewer |
| `vehicles:write` | owner, admin, accountant, staff |
| `drivers:read` | owner, admin, accountant, staff, viewer |
| `drivers:write` | owner, admin, accountant, staff |
| `pricing:read` | owner, admin, accountant, staff, viewer |
| `pricing:write` | owner, admin |
| `trips:read` | owner, admin, accountant, staff, viewer |
| `trips:write` | owner, admin, accountant, staff |
| `trips:finalize` | owner, admin, accountant |
| `trips:cancel` | owner, admin, accountant |
| `invoices:read` | owner, admin, accountant, staff, viewer |
| `invoices:draft` | owner, admin, accountant, staff |
| `invoices:issue` | owner, admin, accountant |
| `invoices:cancel` | owner, admin |
| `payments:record` | owner, admin, accountant, staff |
| `payments:cancel` | owner, admin, accountant |
| `payments:read` | owner, admin, accountant, staff, viewer |
| `reports:read` | owner, admin, accountant, viewer |

Rough role hierarchy for UI-gating purposes: `owner` and `admin` can do nearly everything; `accountant` handles financial/closing operations (finalize, cancel, issue invoices) plus read access everywhere, including the receivables aging report; `staff` does day-to-day data entry (create/edit/finalize trips and masters, draft invoices, record payments) but cannot issue or cancel an invoice, cannot cancel a payment, and cannot access financial reports; `viewer` is read-only everywhere, including the aging report (widened to include it in Task 4.6 — it was previously accountant-and-above only). This is a paraphrase for UI-design purposes, not a substitute for checking the table above against a specific permission key.

**UX pattern for 403s:** the response includes `error.details.required` naming the permission key that was missing (e.g. `"trips:cancel"`). A reasonable default UI treatment is "You need the `<required>` permission to do this" or a role-aware friendlier string mapped from the same key client-side.

## 5. Endpoint inventory

Every endpoint across Modules 1-3, grouped by area. `(public)` means no `Authorization` header is required.

**Auth** — `src/api/v1/auth.routes.js`, mounted at `/api/v1/auth`

```
POST   /auth/signup   — public          — Create a new tenant + its owner user
POST   /auth/login    — public          — Log in, returns accessToken + sets refresh cookie
POST   /auth/refresh  — public (cookie) — Rotate refresh token, returns a new accessToken
POST   /auth/logout   — public (cookie) — Revoke the current refresh token
GET    /auth/me       — authenticated   — Return the current user
```

**Settings** — `src/api/v1/settings.routes.js`, mounted at `/api/v1/settings`

```
GET    /settings/business  — settings:read   — Read the tenant's business profile
PATCH  /settings/business  — settings:update — Update it (includes state_code, trip_sheet_prefix)
```

**Users** — `src/api/v1/users.routes.js`, mounted at `/api/v1/users`

```
GET    /users              — users:list        — List users in the current tenant
POST   /users              — users:create       — Create a user
PATCH  /users/:userId/role   — users:update_role  — Change a user's role
PATCH  /users/:userId/status — users:deactivate   — Activate/deactivate a user
```

**Vehicles** — `src/api/v1/vehicles.routes.js`, mounted at `/api/v1/vehicles`

```
GET    /vehicles                    — vehicles:read  — List, with search/type/archived filters
POST   /vehicles                    — vehicles:write — Create
GET    /vehicles/:vehicleId          — vehicles:read  — Get one
PATCH  /vehicles/:vehicleId          — vehicles:write — Update (vehicle_number immutable)
POST   /vehicles/:vehicleId/archive   — vehicles:write — Soft-delete (idempotent)
POST   /vehicles/:vehicleId/unarchive — vehicles:write — Reverse archive (idempotent)
```

**Drivers** — `src/api/v1/drivers.routes.js`, mounted at `/api/v1/drivers`

```
GET    /drivers                   — drivers:read  — List
POST   /drivers                   — drivers:write — Create (only full_name required)
GET    /drivers/:driverId          — drivers:read  — Get one
PATCH  /drivers/:driverId          — drivers:write — Update (every field editable)
POST   /drivers/:driverId/archive   — drivers:write — Soft-delete (idempotent)
POST   /drivers/:driverId/unarchive — drivers:write — Reverse archive (idempotent)
```

**Customers** — `src/api/v1/customers.routes.js`, mounted at `/api/v1/customers`

```
GET    /customers                              — customers:read  — List (search/type/archived)
POST   /customers                              — customers:write — Create (B2C or B2B)
GET    /customers/:customerId                   — customers:read  — Get one (optional ?withContacts=true)
PATCH  /customers/:customerId                   — customers:write — Update (customer_type immutable)
POST   /customers/:customerId/archive            — customers:write — Soft-delete (idempotent)
POST   /customers/:customerId/unarchive          — customers:write — Reverse archive (idempotent)
GET    /customers/:customerId/contacts           — customers:read  — List B2B contacts
POST   /customers/:customerId/contacts           — customers:write — Add a contact (B2B only)
DELETE /customers/:customerId/contacts/:contactId — customers:write — Remove a contact (hard delete)
```

**Pricing rules** — `src/api/v1/pricing.routes.js`, mounted at `/api/v1/pricing`

```
GET    /pricing/rules              — pricing:read  — List, with rule_type/vehicle_type/date filters
POST   /pricing/rules              — pricing:write — Create (owner/admin only)
GET    /pricing/rules/applicable   — pricing:read  — Look up the rule in effect for a date
GET    /pricing/rules/:ruleId       — pricing:read  — Get one
PATCH  /pricing/rules/:ruleId       — pricing:write — Update (only label/notes/effective_to)
POST   /pricing/rules/:ruleId/supersede — pricing:write — The only way to change a rate
POST   /pricing/preview            — pricing:read  — Run usage through the pricing calculator, no DB write
```

**Trips** — `src/api/v1/trips.routes.js`, mounted at `/api/v1/trips`

```
GET    /trips/performance-sheet            — trips:read     — Blue UI cost-sheet projection, JSON
GET    /trips/performance-sheet/export.csv — trips:read     — Same, as a CSV download
POST   /trips                              — trips:write    — Create a trip sheet (DRAFT)
GET    /trips                              — trips:read     — List, with filters/sort/pagination/aggregates
GET    /trips/:tripId                       — trips:read     — Get one, full detail
PATCH  /trips/:tripId                       — trips:write    — Edit a DRAFT trip
POST   /trips/:tripId/finalize              — trips:finalize — DRAFT → FINALIZED
POST   /trips/:tripId/cancel                — trips:cancel   — DRAFT/FINALIZED → CANCELLED
```

**Invoices** — `src/api/v1/invoices.routes.js`, mounted at `/api/v1/invoices`

```
POST   /invoices                       — invoices:draft  — Create a DRAFT invoice from FINALIZED trips
GET    /invoices/:invoiceId             — invoices:read   — Get one, with lines + customer/tenant refs
PATCH  /invoices/:invoiceId             — invoices:draft  — Edit a DRAFT invoice
DELETE /invoices/:invoiceId             — invoices:draft  — Delete a DRAFT invoice
POST   /invoices/:invoiceId/issue       — invoices:issue  — DRAFT -> ISSUED (allocates number, freezes snapshots)
POST   /invoices/:invoiceId/cancel      — invoices:cancel — -> CANCELLED (issues a credit note if ISSUED/PAID)
PATCH  /invoices/:invoiceId/lines/:lineId — invoices:draft — Edit one line's description (DRAFT only)
POST   /invoices/:invoiceId/payments    — payments:record — Record a payment against this invoice
POST   /invoices/:invoiceId/apply-advance — payments:record — Apply an unallocated advance to this invoice
POST   /invoices/:invoiceId/pdf         — invoices:read   — Generate (or regenerate) the invoice PDF
GET    /invoices/:invoiceId/pdf         — invoices:read   — Download the generated PDF
```

There is no `GET /invoices` list endpoint — invoice listing/search is not built yet (see `docs/modules/module-4-invoices/known-issues.md`).

**Invoiceable trips picker** — nested under `/api/v1/customers`

```
GET    /customers/:customerId/invoiceable-trips — invoices:draft — FINALIZED, unheld trips grouped LOCAL/OUTSTATION
```

**Credit notes** — `src/api/v1/creditNotes.routes.js`, mounted at `/api/v1/credit-notes`. Read-only from the API's perspective — created internally by cancelling an ISSUED/PAID invoice, never via a POST here.

```
GET    /credit-notes                      — invoices:read — List
GET    /credit-notes/:creditNoteId         — invoices:read — Get one
POST   /credit-notes/:creditNoteId/pdf     — invoices:read — Generate (or regenerate) the credit-note PDF
GET    /credit-notes/:creditNoteId/pdf     — invoices:read — Download the generated PDF
```

**Payments** — `src/api/v1/payments.routes.js`, mounted at `/api/v1/payments`, plus two routes nested under `/customers`

```
GET    /payments                        — payments:read   — List with filters
GET    /payments/:paymentId              — payments:read   — Get one
POST   /payments/:paymentId/cancel       — payments:cancel — The ONLY way to reverse a payment (no DELETE)
POST   /customers/:customerId/advances   — payments:record — Standalone advance, not tied to any invoice
GET    /customers/:customerId/ledger     — payments:read   — Full statement: invoices + payments, running balance
```

**Reports** — `src/api/v1/reports.routes.js`, mounted at `/api/v1/reports`

```
GET    /reports/receivables-aging — reports:read — Outstanding ISSUED invoices bucketed by days overdue
```

**Customer quick-create** — nested under `/api/v1/customers` (Task 4.6)

```
POST   /customers/quick-create — customers:write — Minimal-field customer creation for an inline modal
```

Not for frontend use: `src/api/v1/pings.routes.js` (`/pings`, `/pings/leak-test`) is a throwaway internal demo used to prove tenant isolation during Module 1's development. It's still mounted, but nothing in a real UI should call it.

## 6. Response shapes for TypeScript

Paste-ready types, sourced from the actual DB columns and response envelopes documented in each module's `03-database-schema.md`/`04-api-reference.md`. Money fields that appear as both `*_paise` and `*_rupees` are typed accordingly; fields shown as possibly `null` reflect an actual nullable column, not a guess.

```typescript
type Role = "owner" | "admin" | "accountant" | "staff" | "viewer";

type Tenant = {
  id: string;
  name: string;
  slug: string;
  state_code: string | null;
  trip_sheet_prefix: string; // default "TS"
  created_at: string;
  updated_at: string;
};

type User = {
  id: string;
  tenant_id: string;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  // password_hash is NEVER present in any API response
};

type VehicleType =
  | "SEDAN" | "SUV" | "HATCHBACK" | "INNOVA" | "KIA_CARNIVAL"
  | "TEMPO_TRAVELLER" | "MINI_BUS" | "BUS_50_SEATER" | "OTHER";

type Vehicle = {
  id: string;
  tenant_id: string;
  vehicle_number: string;         // canonical, e.g. "KA51AK1031"
  vehicle_number_display: string | null; // as typed, e.g. "KA 51 AK 1031"
  vehicle_type: VehicleType;
  make_model: string | null;
  registration_state: string | null; // 2-letter
  seating_capacity: number | null;
  fuel_type: string | null;       // free text at the DB layer
  year_of_manufacture: number | null;
  notes: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type Driver = {
  id: string;
  tenant_id: string;
  full_name: string; // the only required field
  phone: string | null;           // canonical, 91-prefixed
  phone_display: string | null;
  license_number: string | null;  // uppercased
  license_expiry_date: string | null; // YYYY-MM-DD
  address_line: string | null;
  emergency_contact: string | null; // canonical only, no display twin
  notes: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type CustomerType = "B2C" | "B2B";

type Address = {
  line1?: string; line2?: string; city?: string;
  district?: string; state?: string; pincode?: string;
  country?: string; // defaults to "India"
};

type Customer = {
  id: string;
  tenant_id: string;
  customer_type: CustomerType; // immutable after create
  name: string | null;            // required for B2C, optional billing-contact name for B2B
  company_name: string | null;    // required for B2B, forbidden for B2C
  gstin: string | null;           // required for B2B, rare for B2C
  pan: string | null;
  state_code: string | null;      // required for B2B; drives IGST vs CGST+SGST later
  phone: string | null;
  phone_display: string | null;
  email: string | null;           // NOT unique — shared emails are expected
  address: Address;
  credit_days: number;            // 0-365, default 0
  notes: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  contacts?: CustomerContact[];    // present only when ?withContacts=true
};

type CustomerContact = {
  id: string;
  customer_id: string;
  name: string;
  role: string | null;
  phone: string | null;
  phone_display: string | null;
  email: string | null;
  is_primary: boolean; // at most one true per customer
  created_at: string;
  updated_at: string;
};

type PricingRuleType = "LOCAL_PACKAGE" | "OUTSTATION_SLAB" | "PERFORMANCE";

type PricingRule = {
  id: string;
  tenant_id: string;
  rule_type: PricingRuleType;
  vehicle_type: VehicleType;
  label: string; // display only, never used in calculation
  // LOCAL_PACKAGE only:
  base_hours: number | null;
  base_km: number | null;
  base_price_paise: number | null;
  extra_km_rate_paise: number | null;
  extra_hr_rate_paise: number | null;
  // OUTSTATION_SLAB only:
  slab_rate_paise: number | null;
  min_km_per_day: number | null;
  driver_batta_per_day_paise: number | null;
  // PERFORMANCE only:
  per_km_rate_paise: number | null;
  performance_batta_paise: number | null;
  effective_from: string; // YYYY-MM-DD
  effective_to: string | null; // null = still active
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type TripServiceType = "LOCAL" | "OUTSTATION";
type TripBillingMode = "GST" | "PERFORMANCE";
type TripStatus = "DRAFT" | "FINALIZED" | "INVOICED" | "CANCELLED";

// The lean shape returned by GET /trips (list). Omits breakdown,
// every snap_* field, and tolls — see TripSheetDetail for those.
type TripSheetListItem = {
  id: string;
  tenant_id: string;
  trip_sheet_number: string; // "{prefix}-{seq}/{FY}", e.g. "TS-1586/26-27"
  service_type: TripServiceType;
  billing_mode: TripBillingMode;
  status: TripStatus;
  customer_id: string;
  vehicle_id: string;
  driver_id: string | null;
  snapshot_vehicle_number: string;
  snapshot_vehicle_type: VehicleType;
  snapshot_customer_name: string;
  snapshot_customer_gstin: string | null;
  trip_date: string; // YYYY-MM-DD
  total_km: number;
  total_hours: number;
  total_days: number;
  subtotal_paise: number;
  gross_paise: number;
  net_payable_paise: number;
  advance_paise: number;
  finalized_at: string | null;
  cancelled_at: string | null;
  invoice_id: string | null;
  created_at: string;
  updated_at: string;
};

// GET /trips/:id, and the response of POST/PATCH/finalize/cancel.
type TripSheetDetail = TripSheetListItem & {
  pricing_rule_id: string | null;
  start_datetime: string | null;
  end_datetime: string | null;
  opening_km: number | null;
  closing_km: number | null;
  toll_paise: number;
  parking_paise: number;
  permit_paise: number;
  fasttag_paise: number;
  base_amount_paise: number;
  extras_amount_paise: number;
  driver_batta_paise: number;
  breakdown: Array<{ label: string; value_paise: number; detail?: string }>;
  // Rule snapshot — nullable per rule_type (see 03-database-schema.md)
  snap_base_hours: number | null;
  snap_base_km: number | null;
  snap_base_price_paise: number | null;
  snap_extra_km_rate_paise: number | null;
  snap_extra_hr_rate_paise: number | null;
  snap_slab_rate_paise: number | null;
  snap_min_km_per_day: number | null;
  snap_driver_batta_per_day_paise: number | null;
  snap_per_km_rate_paise: number | null;
  snap_performance_batta_paise: number | null;
  booked_by: string | null;
  pax_note: string | null;
  remarks: string | null;
  created_by: string | null;
  finalized_by: string | null;
  invoiced_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  tolls: TripToll[];
};

type TripToll = {
  id: string;
  trip_sheet_id: string;
  plaza_name: string;
  toll_id: string | null;
  amount_paise: number;
  crossed_at: string | null;
  vehicle_number: string | null;
  closing_balance_paise: number | null;
  notes: string | null;
  line_number: number;
  created_at: string;
};

// One row of GET /trips/performance-sheet's Blue UI projection.
type PerformanceSheetRow = {
  SL: number;
  DATE: string; // YYYY-MM-DD
  VEHICLE_TYPE: VehicleType;
  VEHICLE_NUMBER: string;
  TOTAL_RUNNING_KM: number;
  PER_KM_COST_RUPEES: number;
  PER_KM_COST_PAISE: number;
  TOTAL_COST_RUPEES: number;   // base running cost (per_km * km)
  TOTAL_COST_PAISE: number;
  BATA_RUPEES: number;
  BATA_PAISE: number;
  TOLL_CHARGES_RUPEES: number;
  TOLL_CHARGES_PAISE: number;
  GRAND_TOTAL_RUPEES: number;  // final total, including batta + tolls
  GRAND_TOTAL_PAISE: number;
  TRIP_ID: string;
  STATUS: TripStatus;
};

type PerformanceSheetGroup = {
  customer_id: string;
  customer_name: string;
  customer_type: CustomerType | null; // null if the customer record no longer resolves
  rows: PerformanceSheetRow[];
  subtotal: {
    total_running_km: number;
    running_cost_paise: number;
    batta_paise: number;
    toll_paise: number;
    total_paise: number;
  };
};

type PerformanceSheet = {
  groups: PerformanceSheetGroup[];
  grand_total: {
    total_running_km: number;
    running_cost_paise: number;
    batta_paise: number;
    toll_paise: number;
    total_paise: number;
    row_count: number;
    group_count: number;
  };
  filters_applied: Record<string, unknown>;
};

type InvoiceType = "TAX" | "PERFORMANCE";
type InvoiceStatus = "DRAFT" | "ISSUED" | "PAID" | "CANCELLED";

type InvoiceLine = {
  id: string;
  invoice_id: string;
  trip_sheet_id: string;
  line_number: number;
  service_type: TripServiceType; // snapshot from the trip
  trip_date: string; // YYYY-MM-DD
  vehicle_number: string;
  vehicle_type: VehicleType;
  total_km: number;
  total_hours: number | null;
  total_days: number | null;
  base_amount_paise: number;
  extras_amount_paise: number; // LOCAL only — always 0 for OUTSTATION lines
  driver_batta_paise: number;
  line_amount_paise: number; // = base + extras + batta
  hsn_sac_code: string; // "996601" on every line
  description: string; // the ONLY user-editable field on a line
  created_at: string;
};

// GET /invoices/:id, and the response of POST/PATCH/issue/cancel.
type Invoice = {
  id: string;
  tenant_id: string;
  invoice_number: string | null; // null until ISSUED
  invoice_type: InvoiceType;
  status: InvoiceStatus;
  customer_id: string;
  invoice_date: string; // YYYY-MM-DD
  due_date: string;
  notes: string | null;
  terms: string | null;
  subtotal_paise: number;
  gst_rate_snapshot: number | null; // null for PERFORMANCE
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  total_gst_paise: number;
  toll_paise: number;
  parking_paise: number;
  permit_paise: number;
  fasttag_paise: number;
  toll_manual_override: boolean;
  parking_manual_override: boolean;
  permit_manual_override: boolean;
  fasttag_manual_override: boolean;
  discount_paise: number;
  discount_reason: string | null;
  round_off_paise: number; // signed
  grand_total_paise: number;
  net_payable_paise: number;
  amount_in_words: string | null;
  tenant_snapshot: Record<string, unknown> | null; // null until ISSUED, then permanently frozen
  customer_snapshot: Record<string, unknown> | null; // same
  pdf_url: string | null;
  pdf_generated_at: string | null;
  pdf_template_version: string | null;
  pdf_file_size_bytes: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  issued_at: string | null;
  issued_by: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  credit_note_id: string | null;
  lines: InvoiceLine[];
  // present only on GET /invoices/:id, not on POST/PATCH/issue/cancel responses:
  customer?: { id: string; customer_type: CustomerType; name: string | null; company_name: string | null; gstin: string | null; state_code: string | null };
  tenant?: { id: string; name: string; gstin: string | null; state_code: string | null };
};

type CreditNote = {
  id: string;
  tenant_id: string;
  credit_note_number: string;
  original_invoice_id: string;
  customer_id: string;
  customer_snapshot: Record<string, unknown>; // as of CANCELLATION, not copied from the invoice
  tenant_snapshot: Record<string, unknown>;
  subtotal_paise: number;
  total_gst_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  toll_paise: number;
  parking_paise: number;
  permit_paise: number;
  fasttag_paise: number;
  discount_paise: number;
  grand_total_paise: number;
  net_payable_paise: number; // mirrors the original invoice's frozen total — the reversal amount
  credit_note_date: string; // YYYY-MM-DD, the cancellation date
  reason: string;
  amount_in_words: string | null;
  pdf_url: string | null;
  pdf_generated_at: string | null;
  pdf_template_version: string | null;
  pdf_file_size_bytes: number | null;
  issued_by: string | null;
  created_at: string;
};

// One entry from GET /customers/:id/invoiceable-trips — a lean
// projection of trip_sheets, not the full TripSheetDetail shape.
type InvoiceableTrip = {
  id: string;
  trip_sheet_number: string;
  service_type: TripServiceType;
  billing_mode: TripBillingMode;
  trip_date: string;
  snapshot_vehicle_number: string;
  snapshot_vehicle_type: VehicleType;
  total_km: number;
  total_hours: number;
  total_days: number;
  base_amount_paise: number;
  extras_amount_paise: number;
  driver_batta_paise: number;
  toll_paise: number;
  parking_paise: number;
  permit_paise: number;
  fasttag_paise: number;
  advance_paise: number;
  subtotal_paise: number;
  gross_paise: number;
  net_payable_paise: number;
  held_by_invoice_id: string | null;
  created_at: string;
};

type InvoiceableTripsGroupSummary = {
  count: number;
  total_km: number;
  total_subtotal_paise: number;
  total_gross_paise: number;
  total_net_payable_paise: number;
};

type InvoiceableTrips = {
  customer: { id: string; name: string | null; company_name: string | null; customer_type: CustomerType; gstin: string | null; state_code: string | null; credit_days: number };
  groups: {
    LOCAL: { trips: InvoiceableTrip[]; summary: InvoiceableTripsGroupSummary };
    OUTSTATION: { trips: InvoiceableTrip[]; summary: InvoiceableTripsGroupSummary };
  };
  total_summary: InvoiceableTripsGroupSummary;
};

type PaymentMode = "CASH" | "UPI" | "NEFT" | "RTGS" | "IMPS" | "CHEQUE" | "CARD" | "BANK_TRANSFER";
type PaymentStatus = "RECORDED" | "CANCELLED";

type Payment = {
  id: string;
  tenant_id: string;
  customer_id: string;
  invoice_id: string | null; // null = unallocated advance
  parent_payment_id: string | null; // set on a split spillover or a partial advance application
  amount_paise: number; // always > 0
  payment_mode: PaymentMode;
  reference_number: string | null; // null only for CASH
  received_at: string;
  status: PaymentStatus;
  notes: string | null;
  recorded_by: string | null;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
};

type CustomerLedgerEntry =
  | { type: "INVOICE"; invoice_id: string; invoice_number: string; invoice_date: string; due_date: string; debit_paise: number; status: InvoiceStatus; running_balance_paise: number }
  | { type: "PAYMENT"; payment_id: string; invoice_id: string | null; received_at: string; credit_paise: number; payment_mode: PaymentMode; reference_number: string | null; running_balance_paise: number };

type CustomerLedger = {
  customer: { id: string; customer_type: CustomerType; name: string | null; company_name: string | null; gstin: string | null; state_code: string | null; credit_days: number };
  summary: {
    total_invoiced_paise: number;
    total_paid_paise: number;
    total_cancelled_paise: number;
    unallocated_advance_paise: number;
    outstanding_paise: number;
  };
  entries: CustomerLedgerEntry[];
};

type AgingBucketName = "CURRENT" | "DAYS_1_30" | "DAYS_31_60" | "DAYS_61_90" | "DAYS_90_PLUS";

type AgingEntry = {
  invoice_id: string;
  invoice_number: string;
  customer_id: string;
  customer_name: string | null;
  due_date: string;
  net_payable_paise: number;
  paid_paise: number;
  outstanding_paise: number;
  days_overdue: number;
};

type ReceivablesAgingReport = {
  as_of_date: string;
  summary: {
    total_outstanding_paise: number;
    total_invoices: number;
    buckets_summary: Record<AgingBucketName, { count: number; total_paise: number }>;
  };
  buckets: Record<AgingBucketName, { count: number; total_paise: number; entries: AgingEntry[] }>;
};
```

## 7. Money handling

Every monetary field on the wire is one of two conventions: `*_paise` (integer, exact, the value to do arithmetic on) or `*_rupees` (number, formatted for display). Many responses carry both for the same figure — `PER_KM_COST_PAISE`/`PER_KM_COST_RUPEES` on a performance-sheet row, for instance. Always compute with the `_paise` value; treat `_rupees` as display-only, already-converted output, not something to re-derive math from (floating-point rupee arithmetic is exactly the failure mode the backend avoids internally by never doing it — see ADR-002). For display formatting, `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100)` matches the backend's own `formatINR` convention (`₹` symbol, Indian digit grouping, two decimal places).

## 8. Pagination

Every list endpoint (`GET /vehicles`, `/drivers`, `/customers`, `/pricing/rules`, `/trips`, `/users`, `/payments`, `/credit-notes`) uses offset/limit:

```
GET /trips?limit=25&offset=50
```

Response includes:

```json
{ "pagination": { "total": 143, "limit": 25, "offset": 50, "has_more": true } }
```

Note: Module 2's list endpoints (`vehicles`, `drivers`, `customers`, `pricing/rules`, `users`) return `pagination: { total, limit, offset }` **without** `has_more` — computing it client-side is `offset + <items returned> < total`. `GET /trips`, `GET /payments`, and `GET /credit-notes` all include `has_more` directly in the response. The performance-sheet endpoints have no pagination at all — they return the full filtered/grouped set, capped at 10,000 rows (`EXPORT_TOO_LARGE` beyond that).

## 9. Filter conventions

- IDs: a single UUID v4 per filter (e.g. `customer_id=<uuid>`), never a comma-separated list of IDs anywhere in Modules 1-3.
- Dates: `YYYY-MM-DD` for date-only filters (`from_date`, `to_date`, `trip_date`, `on_date`); full ISO 8601 datetime strings for timestamp fields (`start_datetime`, `crossed_at`).
- Multi-value enums: a single comma-separated string, e.g. `status=DRAFT,FINALIZED` on `GET /trips` and the performance-sheet endpoints. Not repeated query params (`status=DRAFT&status=FINALIZED` does not work).
- Substring search: a `search` query param, present on every Module 2 list endpoint and on `GET /trips`; which columns it matches varies per endpoint (see each module's `04-api-reference.md`).
- Booleans: the literal strings `"true"`/`"false"` in the query string (`includeArchived=true`, `includeCancelled=true`) — Joi coerces them, but send them as strings, not JSON booleans, since they travel in a URL.

## 10. Error codes to handle specially

| Code | UX action |
| --- | --- |
| `AUTH_REQUIRED` | Redirect to login |
| `ACCESS_TOKEN_EXPIRED` | Attempt `POST /auth/refresh` silently, then retry the original request once with the new token |
| `AUTH_INVALID` | Redirect to login (token is malformed, or the account behind it no longer exists) |
| `INVALID_CREDENTIALS` | Show a generic "email or password incorrect" — the backend deliberately doesn't distinguish which one was wrong |
| `REFRESH_TOKEN_REUSED` | Force logout, clear all local auth state — this is a possible-theft signal, not a routine expiry |
| `REFRESH_TOKEN_MISSING` / `REFRESH_TOKEN_INVALID` | Redirect to login |
| `FORBIDDEN` | Show role-restricted UI / a "you need the `<details.required>` permission" message |
| `VALIDATION_ERROR` | Highlight the specific fields named in `details.fields` (an array of `{ field, message }`) |
| `TRIP_NOT_EDITABLE` | Disable the edit form, show the trip read-only, surface `details.current_status` |
| `INVALID_STATE_TRANSITION` | Reload the trip's current state; `details.allowed_transitions` lists what's actually available from here |
| `TRIP_STATUS_CHANGED` / `TRIP_STATUS_CHANGED_DURING_UPDATE` | Reload and let the user retry — a concurrent transition won the race |
| `EXPORT_TOO_LARGE` | Suggest narrowing with a date range or customer filter; `details.max_rows` names the cap |
| `NO_APPLICABLE_PRICING_RULE` | Point the user at the pricing rules screen for the named `details.vehicle_type`/`details.rule_type` |
| `TOLL_INPUT_CONFLICT` | Clear whichever of the lump-sum/itemized toll inputs the user isn't actively using |
| `GSTIN_STATE_MISMATCH` | Highlight both the GSTIN and state fields; `details.gstin_state` names what the GSTIN actually encodes |
| `*_ALREADY_EXISTS` (vehicle/driver/customer number/phone/gstin) | Offer to navigate to the existing record instead of retrying the create |
| `*_ARCHIVED_EXISTS` | Offer an "unarchive instead" action, pointing at the id in `details` |
| `INVOICE_NOT_FOUND` | 404 — treat like any other not-found; the id doesn't exist or belongs to a different tenant |
| `INVOICE_NOT_EDITABLE` | Disable the edit form, show the invoice read-only, surface `details.current_status` |
| `TRIP_ALREADY_HELD` | Explain the trip is already on another DRAFT invoice (`details.held_by_invoice_id`); offer to navigate there or pick a different trip |
| `TRIP_ALREADY_ON_INVOICE` | Should not occur given the picker already excludes held trips — treat as an unexpected-state reload prompt if seen |
| `CUSTOMER_MISMATCH` | Every trip on one invoice must belong to the same customer — surface which trip (`details.trip_id`) doesn't match |
| `TRIP_NOT_FINALIZED` | The trip isn't ready to invoice yet; `details.current_status` names its actual status — finalize it first |
| `INVALID_INVOICE_STATE_TRANSITION` | Reload the invoice's current state; `details.allowed_transitions` lists what's actually available from here |
| `INVOICE_HAS_NO_LINES` | Should not occur for a normally-created invoice — reload and retry PDF generation |
| `INVOICE_NOT_ISSUED` | PDF generation was attempted on a DRAFT — issue the invoice first |
| `PDF_NOT_GENERATED` | Prompt to generate the PDF (`POST .../pdf`) before offering a download link |
| `PDF_FILE_MISSING` | A 500 — the PDF was generated once but the file is gone server-side; regenerating (`POST .../pdf` again) is the fix, since generation is idempotent |
| `PDF_RENDER_FAILED` | A 500 — offer a retry; this is a transient rendering failure, not a data problem |
| `PAYMENT_REFERENCE_DUPLICATE` | This reference number is already recorded as an active payment for this mode — check whether it was already entered before retrying |
| `PAYMENT_NOT_ALLOWED_STATE` | The invoice isn't ISSUED/PAID yet (or is CANCELLED) — `details.current_status` names it; payments can't be recorded against a DRAFT |
| `PAYMENT_ALREADY_CANCELLED` | Reload — someone else already cancelled this payment |
| `ADVANCE_CUSTOMER_MISMATCH` | The chosen advance belongs to a different customer than the invoice — only same-customer advances can be applied |
| `INVOICE_ALREADY_FULLY_PAID` | Nothing left to apply an advance toward — the advance remains available for a different invoice |
| `B2B_REQUIRED_FIELDS` | On `POST /customers/quick-create`: a B2B customer without a GSTIN was rejected — this is a hard database constraint, not something quick-create can waive; prompt for a GSTIN or use B2C |

## 11. Gotchas that will save days

- Trip sheet numbers are per-tenant, per-fiscal-year (`{prefix}-{seq}/{FY}`, Indian FY = April-March). Don't cache or predict the next number client-side; always use what the create response returns.
- Snapshot fields on a trip (`snapshot_*`, every `snap_*`) are immutable by design (ADR-005). Do not build a "resync from current rule/vehicle/customer" action — there is no such endpoint, and it would defeat the entire point of the snapshot.
- Every `PATCH /trips/:id` recomputes all derived totals from scratch via the pricing engine, using the trip's *original* rule. There's no partial-recompute mode. For a pre-submit cost estimate before creating or editing a trip, use `POST /pricing/preview` instead of guessing client-side.
- Trip cancellation requires a reason, minimum 3 characters — there is no cancel-without-reason path; don't build a one-click cancel button without a text input.
- The performance-sheet endpoints filter to `billing_mode = 'PERFORMANCE'` and cannot be pointed at GST trips — an "internal cost sheet" screen should call these, not `GET /trips` with a client-side filter.
- CSV downloads (`GET /trips/performance-sheet/export.csv`) carry `X-Row-Count` and `X-Group-Count` response headers — read them for a "showing N rows across M customers" message instead of parsing the CSV body client-side to count.
- GSTIN's state cross-check happens server-side (`GSTIN_STATE_MISMATCH`); the UI should still validate the format (`^[0-9A-Z]{15}$`) locally to fail fast before a round trip.
- `includeArchived`/`includeCancelled` default to `false` everywhere they exist; an explicit `status` filter on `GET /trips` (or the performance sheet) always overrides `includeCancelled`, in both directions.
- Invoice numbers are gap-free per fiscal year, per invoice type, per tenant (Indian GST requirement) — never cache or predict the next number client-side; a DRAFT invoice has `invoice_number: null` and only gets a real one at `POST .../issue`.
- `tenant_snapshot`/`customer_snapshot` on an ISSUED/PAID/CANCELLED invoice (and both snapshot fields on a credit note) are IMMUTABLE, frozen at the moment of issue/cancellation. There is no "refresh from current customer/tenant info" endpoint and none should be built — a legal document's own copy of who it was billed to/from is not supposed to change after the fact, even if the live customer or tenant record is edited later.
- PDF generation (`POST .../pdf`, both invoices and credit notes) is idempotent — safe to call again; it overwrites the same file and just updates `pdf_generated_at`/`pdf_file_size_bytes`. There's no need to guard against double-clicking a "Generate PDF" button.
- Payments cancel, they don't delete — there is no `DELETE /payments/:id`. `POST /payments/:id/cancel` is the only reversal path and always requires a reason.
- An over-payment on an invoice auto-splits: the outstanding portion applies to the invoice, the excess becomes a brand-new unallocated advance on the same customer (linked via `parent_payment_id`). The response's `spillover_advance` names it — surface both the applied payment AND the new advance to the user, not just the applied portion.
- Advance application supports partial consumption — applying part of one advance to an invoice leaves the remainder (a decremented, still-active `payments` row) available to apply again, to a different invoice. A UI offering "apply this advance" should expect to potentially call the endpoint more than once against the same advance id over its lifetime.
- `reports:read` includes `viewer` as of Task 4.6 (previously accountant-and-above only) — a read-only user CAN see the receivables aging report; don't gate that screen more strictly than the API actually requires.
- There is no `GET /invoices` list/search endpoint — don't build an "all invoices" browse screen against this API yet; only single-invoice fetch (`GET /invoices/:id`) exists.

## 12. Local development

- Server: `npm run dev`, port `8000` by default (`PORT` env var).
- Database: a host-installed Postgres instance, connection string in `.env`'s `DATABASE_URL`. No Docker is required or used anywhere in this codebase's current setup.
- CORS is currently open in this dev environment; a frontend on a different port needs no extra configuration to reach the API locally.

## 13. Testing against a fresh tenant

```bash
curl -X POST http://localhost:8000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"businessName":"My Test Co","email":"me@example.com","password":"Passw0rd123","fullName":"Test Owner"}'

curl -X POST http://localhost:8000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"me@example.com","password":"Passw0rd123"}'
# -> use the returned accessToken as the Bearer token for everything else
```

The `scripts/verify-*.sh` files in this repo build much larger fixture sets (vehicles, drivers, customers, pricing rules, trips) the same way, with real request bodies — they're a good source of realistic example payloads for every endpoint if a specific request shape is unclear.

## 14. Modules 1-4 are stable and complete

Modules 1-4's API surface is considered stable — any breaking change to an existing endpoint's shape would go through a new `/v2` path rather than changing what's documented here in place. Module 4 (invoicing, GST computation, payments, PDF rendering) is complete: invoice drafting/lifecycle/numbering, payment recording/advances/cancellation, the customer ledger, the receivables aging report, and PDF generation for both invoices and credit notes are all built and documented above. The one explicitly-known gap is invoice listing/search (`GET /invoices` doesn't exist — only single-invoice fetch) — see `docs/modules/module-4-invoices/known-issues.md`. Module 5 has not been started.
