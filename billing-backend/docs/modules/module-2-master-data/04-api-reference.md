# API reference

_Last updated: 2026-07-18. Reviewers: TBD._

All endpoints below require `Authorization: Bearer <accessToken>` and are mounted under `/api/v1`. Every route runs `authenticate` (verifies the JWT) then `tenantContext` (attaches `req.tenantId` and the tenant-scoped `req.db` helpers) before any permission check — see Module 1 docs (not yet written) for those middleware. Permission keys are checked against `src/config/accessMatrix.js`; a role not listed for a given key gets `403 FORBIDDEN` with `error.details.required` naming the key and `error.details.role` naming the caller's role. Full error code definitions are in `06-error-reference.md`; this document lists only which codes each endpoint can realistically raise.

## Vehicles

Source: `src/api/v1/vehicles.routes.js`. Field-level validation: `src/validators/vehicle.validator.js`.

### GET /api/v1/vehicles

**Permission:** `vehicles:read`
**Purpose:** List vehicles for the current tenant with optional filters.

**Query params:**

| Name | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `limit` | integer | no | `50` | 1–100 |
| `offset` | integer | no | `0` | ≥ 0 |
| `search` | string | no | — | 1–30 chars; substring match on `vehicle_number` (canonical) and `make_model` |
| `type` | string | no | — | One of `vehicle_type_enum`'s values |
| `includeArchived` | boolean | no | `false` | Include `is_active = false` rows |

**Response 200:**

```json
{
  "vehicles": [ { "id": "...", "vehicle_number": "KA51AK1031", "vehicle_type": "SEDAN", "is_active": true, "...": "..." } ],
  "pagination": { "total": 12, "limit": 50, "offset": 0 }
}
```

**Errors:** `400 VALIDATION_ERROR` — bad query params.

### POST /api/v1/vehicles

**Permission:** `vehicles:write`
**Purpose:** Create a vehicle.

**Body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `vehicle_number` | string | yes | Normalized to canonical form (uppercase, no separators) server-side; the raw string is kept as `vehicle_number_display` |
| `vehicle_type` | string | yes | One of `vehicle_type_enum`'s values |
| `make_model` | string | no | 2–255 chars |
| `registration_state` | string | no | 2-letter uppercase; auto-derived from the vehicle number's first 2 characters if omitted |
| `seating_capacity` | integer | no | 1–60 |
| `fuel_type` | string | no | One of `PETROL`, `DIESEL`, `CNG`, `ELECTRIC`, `HYBRID` (Joi-level only, not a DB enum) |
| `year_of_manufacture` | integer | no | 1990–(current year + 1) |
| `notes` | string | no | Max 2000 chars |

**Response 201:**

```json
{ "vehicle": { "id": "...", "vehicle_number": "KA51AK1031", "vehicle_number_display": "KA 51 AK 1031", "registration_state": "KA", "is_active": true, "...": "..." } }
```

**Errors:** `400 VALIDATION_ERROR`, `409 VEHICLE_ALREADY_EXISTS`, `409 VEHICLE_ARCHIVED_EXISTS`.

### GET /api/v1/vehicles/:vehicleId

**Permission:** `vehicles:read`
**Purpose:** Fetch one vehicle by id.

**Params:** `vehicleId` (UUID, path).

**Response 200:** `{ "vehicle": { ... } }`

**Errors:** `400 VALIDATION_ERROR` (malformed UUID), `404 VEHICLE_NOT_FOUND` (missing, or belongs to a different tenant — RLS makes the two indistinguishable by design).

### PATCH /api/v1/vehicles/:vehicleId

**Permission:** `vehicles:write`
**Purpose:** Update a vehicle's editable fields.

**Body:** Same fields as create, all optional, **except `vehicle_number`**, which is immutable — see `05-design-decisions.md`. At least one field required.

**Response 200:** `{ "vehicle": { ... } }`

**Errors:** `400 VALIDATION_ERROR` (empty patch, or an attempt to set `vehicle_number`, which isn't in the schema and so is stripped, leaving an empty patch), `404 VEHICLE_NOT_FOUND`.

### POST /api/v1/vehicles/:vehicleId/archive

**Permission:** `vehicles:write`
**Purpose:** Soft-delete (`is_active = false`). Idempotent — archiving an already-archived vehicle returns 200 with its current state, not an error.

**Response 200:** `{ "vehicle": { "is_active": false, "...": "..." } }`

**Errors:** `404 VEHICLE_NOT_FOUND`.

### POST /api/v1/vehicles/:vehicleId/unarchive

**Permission:** `vehicles:write`
**Purpose:** Reverse of archive. Also idempotent.

**Response 200:** `{ "vehicle": { "is_active": true, "...": "..." } }`

**Errors:** `404 VEHICLE_NOT_FOUND`.

There is no `DELETE /api/v1/vehicles/:vehicleId` — the route is not registered, so a `DELETE` request 404s at the router level (`NOT_FOUND`, not `VEHICLE_NOT_FOUND`). Archive is the only supported removal path.

## Drivers

Source: `src/api/v1/drivers.routes.js`. Field-level validation: `src/validators/driver.validator.js`. Same six-endpoint shape as Vehicles; only the field-level details differ.

### GET /api/v1/drivers

**Permission:** `drivers:read`

**Query params:**

| Name | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `limit` | integer | no | `50` | 1–100 |
| `offset` | integer | no | `0` | ≥ 0 |
| `search` | string | no | — | 1–50 chars; substring match on `full_name`, substring match on canonical `phone` |
| `includeArchived` | boolean | no | `false` | |

**Response 200:** `{ "drivers": [...], "pagination": { "total", "limit", "offset" } }`

**Errors:** `400 VALIDATION_ERROR`.

### POST /api/v1/drivers

**Permission:** `drivers:write`
**Purpose:** Create a driver. `full_name` is the only required field — see `01-planning-context.md`, requirement 5.

**Body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `full_name` | string | yes | 2–255 chars |
| `phone` | string | no | Normalized to canonical (`91`-prefixed) form; unique per tenant when present |
| `license_number` | string | no | 5–30 chars, uppercased on write; unique per tenant when present |
| `license_expiry_date` | date | no | ISO `YYYY-MM-DD`; `null` allowed explicitly |
| `address_line` | string | no | Max 500 chars |
| `emergency_contact` | string | no | Same phone normalization as `phone`; no separate display column |
| `notes` | string | no | Max 2000 chars |

**Response 201:** `{ "driver": { "id": "...", "phone": "919876543210", "phone_display": "+91 98765 43210", "...": "..." } }`

**Errors:** `400 VALIDATION_ERROR`, `409 DRIVER_PHONE_ALREADY_EXISTS`, `409 DRIVER_LICENSE_ALREADY_EXISTS`, `409 DRIVER_ARCHIVED_EXISTS`.

### GET /api/v1/drivers/:driverId

**Permission:** `drivers:read`

**Response 200:** `{ "driver": { ... } }`

**Errors:** `404 DRIVER_NOT_FOUND`.

### PATCH /api/v1/drivers/:driverId

**Permission:** `drivers:write`
**Purpose:** Update. Unlike vehicles, **every** field — including `phone` and `license_number` — is editable here; a driver's contact/license details genuinely change over time, so there's no immutability rule on this table.

**Body:** Same fields as create, all optional. At least one required.

**Response 200:** `{ "driver": { ... } }`

**Errors:** `400 VALIDATION_ERROR`, `404 DRIVER_NOT_FOUND`, `409 DRIVER_PHONE_ALREADY_EXISTS`, `409 DRIVER_LICENSE_ALREADY_EXISTS` (if the patch introduces a duplicate).

### POST /api/v1/drivers/:driverId/archive

**Permission:** `drivers:write` — idempotent, same shape as vehicles.

**Errors:** `404 DRIVER_NOT_FOUND`.

### POST /api/v1/drivers/:driverId/unarchive

**Permission:** `drivers:write` — idempotent, same shape as vehicles.

**Errors:** `404 DRIVER_NOT_FOUND`.

No `DELETE` route exists for drivers either.

## Customers

Source: `src/api/v1/customers.routes.js`. Field-level validation: `src/validators/customer.validator.js`.

### GET /api/v1/customers

**Permission:** `customers:read`

**Query params:**

| Name | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `limit` | integer | no | `50` | 1–100 |
| `offset` | integer | no | `0` | ≥ 0 |
| `search` | string | no | — | 1–50 chars; matches `name`/`company_name`/`email` (substring), `phone` (canonical substring), `gstin` (exact, case-insensitive) |
| `customer_type` | string | no | — | `B2C` or `B2B` |
| `includeArchived` | boolean | no | `false` | |

**Response 200:** `{ "customers": [...], "pagination": { "total", "limit", "offset" } }`

**Errors:** `400 VALIDATION_ERROR`.

### POST /api/v1/customers

**Permission:** `customers:write`
**Purpose:** Create a customer. Required fields depend on `customer_type` — see the table in `README.md`'s "B2C vs B2B" section and `05-design-decisions.md`.

**Body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `customer_type` | string | yes | `B2C` or `B2B` |
| `name` | string | conditional | Required when `customer_type` is `B2C` (personal name); optional when `B2B` (primary billing contact name) |
| `company_name` | string | conditional | Required for B2B; rejected (schema-level) if present alongside `customer_type: "B2C"` |
| `gstin` | string | conditional | Required for B2B; normalized to uppercase, format-validated |
| `pan` | string | no | Uppercased, format-validated |
| `state_code` | string | conditional | Required for B2B; auto-derived from `gstin` if omitted; cross-checked against `gstin` if both given |
| `phone` | string | no | Canonical + display, same as drivers |
| `email` | string | no | Lowercased |
| `address` | object | no | `{ line1, line2, city, district, state, pincode, country }`, all optional; `country` defaults to `"India"` |
| `credit_days` | integer | no | 0–365, default `0` |
| `notes` | string | no | Max 2000 |

**Response 201:** `{ "customer": { "id": "...", "customer_type": "B2B", "state_code": "KA", "...": "..." } }`

**Errors:** `400 VALIDATION_ERROR`, `400 B2B_REQUIRED_FIELDS`, `400 B2C_REQUIRED_FIELDS`, `400 GSTIN_STATE_MISMATCH`, `400 INVALID_FORMAT`, `409 CUSTOMER_GSTIN_ALREADY_EXISTS`, `409 CUSTOMER_PHONE_ALREADY_EXISTS`, `409 CUSTOMER_ARCHIVED_EXISTS`.

### GET /api/v1/customers/:customerId

**Permission:** `customers:read`

**Query params:**

| Name | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `withContacts` | boolean | no | `false` | If true, response includes `customer.contacts` (array, primary contact first) |

**Response 200:** `{ "customer": { "...": "...", "contacts"?: [...] } }`

**Errors:** `404 CUSTOMER_NOT_FOUND`.

### PATCH /api/v1/customers/:customerId

**Permission:** `customers:write`
**Purpose:** Update. `customer_type` is immutable (explicitly `forbidden()` at the Joi layer, not just omitted — a request that includes it at all gets `400 VALIDATION_ERROR` regardless of what else is in the body).

**Body:** Same fields as create except `customer_type`, all optional. At least one required. A patch touching `gstin` or `state_code` re-runs the same derivation/cross-check logic as create, against the *effective* combination of the patch layered on the existing row.

**Response 200:** `{ "customer": { ... } }`

**Errors:** `400 VALIDATION_ERROR`, `400 GSTIN_STATE_MISMATCH`, `404 CUSTOMER_NOT_FOUND`, `409 CUSTOMER_GSTIN_ALREADY_EXISTS`, `409 CUSTOMER_PHONE_ALREADY_EXISTS`.

### POST /api/v1/customers/:customerId/archive

**Permission:** `customers:write` — idempotent.

**Errors:** `404 CUSTOMER_NOT_FOUND`.

### POST /api/v1/customers/:customerId/unarchive

**Permission:** `customers:write` — idempotent.

**Errors:** `404 CUSTOMER_NOT_FOUND`.

### GET /api/v1/customers/:customerId/contacts

**Permission:** `customers:read`
**Purpose:** List a customer's contacts, primary first then most recent.

**Response 200:** `{ "contacts": [ { "id": "...", "name": "...", "is_primary": true, "...": "..." } ] }`

**Errors:** `404 CUSTOMER_NOT_FOUND`.

### POST /api/v1/customers/:customerId/contacts

**Permission:** `customers:write`
**Purpose:** Add a contact. B2B customers only.

**Body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | 2–255 chars |
| `role` | string | no | Max 100 chars |
| `phone` | string | no | Canonical + display |
| `email` | string | no | |
| `is_primary` | boolean | no | Default `false`. Setting `true` atomically flips off any existing primary contact for this customer in the same transaction |

**Response 201:** `{ "contact": { "id": "...", "is_primary": true, "...": "..." } }`

**Errors:** `400 VALIDATION_ERROR`, `400 CONTACTS_B2B_ONLY`, `404 CUSTOMER_NOT_FOUND`, `409 CONTACT_PRIMARY_CONFLICT` (rare — see `06-error-reference.md`).

### DELETE /api/v1/customers/:customerId/contacts/:contactId

**Permission:** `customers:write`
**Purpose:** Remove a contact. Hard delete — contacts, unlike the master entities themselves, have no archive/soft-delete concept.

**Response:** `204 No Content`.

**Errors:** `404 CUSTOMER_NOT_FOUND`. (Deleting a nonexistent `contactId` under a valid `customerId` is a silent no-op — the `DELETE` statement's `WHERE` clause simply matches zero rows — rather than a 404, since the end state the caller wanted, "this contact id does not exist," is already true.)

## Pricing Rules

Source: `src/api/v1/pricing.routes.js`. Field-level validation: `src/validators/pricingRule.validator.js`. All monetary input fields use a `*_rupees` suffix (decimal rupees); all monetary fields in responses use a `*_paise` suffix (integer paise) — see `05-design-decisions.md` and the README's "Money handling" section.

### GET /api/v1/pricing/rules

**Permission:** `pricing:read`

**Query params:**

| Name | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `limit` | integer | no | `50` | 1–100 |
| `offset` | integer | no | `0` | ≥ 0 |
| `rule_type` | string | no | — | `LOCAL_PACKAGE`, `OUTSTATION_SLAB`, or `PERFORMANCE` |
| `vehicle_type` | string | no | — | One of `vehicle_type_enum`'s values |
| `on_date` | string | no | — | `YYYY-MM-DD`; filters to rules effective on this date |
| `activeOnly` | boolean | no | `false` | Exclude rules whose `effective_to` is in the past |

**Response 200:** `{ "rules": [...], "pagination": { "total", "limit", "offset" } }`

**Errors:** `400 VALIDATION_ERROR`.

### POST /api/v1/pricing/rules

**Permission:** `pricing:write` (owner/admin only — see the access matrix note in `01-planning-context.md`)
**Purpose:** Create a pricing rule. Which rate fields are required depends on `rule_type` — enforced in the service layer with a precise `*_FIELDS_MISSING` error before the request ever reaches the database's own CHECK constraints.

**Body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `rule_type` | string | yes | `LOCAL_PACKAGE`, `OUTSTATION_SLAB`, or `PERFORMANCE` |
| `vehicle_type` | string | yes | One of `vehicle_type_enum`'s values |
| `label` | string | yes | 2–255 chars, admin-UI display only |
| `effective_from` | string | yes | `YYYY-MM-DD` |
| `effective_to` | string | no | `YYYY-MM-DD`, must be strictly after `effective_from` if given; omitted = open-ended |
| `notes` | string | no | Max 2000 |
| `base_hours`, `base_km`, `min_km_per_day` | integer | conditional | 0–10000; required per `rule_type` (see `06-error-reference.md`) |
| `base_price_rupees`, `extra_km_rate_rupees`, `extra_hr_rate_rupees`, `slab_rate_rupees`, `driver_batta_per_day_rupees`, `per_km_rate_rupees`, `performance_batta_rupees` | number | conditional | Positive, max 1,000,000; required per `rule_type` |

**Response 201:** `{ "rule": { "id": "...", "base_price_paise": 220000, "effective_from": "2026-01-01", "effective_to": null, "...": "..." } }`

**Errors:** `400 VALIDATION_ERROR`, `400 LOCAL_FIELDS_MISSING` / `400 OUTSTATION_FIELDS_MISSING` / `400 PERFORMANCE_FIELDS_MISSING`, `400 INVALID_DATE_RANGE`, `409 PRICING_RULE_OVERLAP`.

### GET /api/v1/pricing/rules/applicable

**Permission:** `pricing:read`
**Purpose:** Look up the single rule in effect for a (rule type, vehicle type) pair on a given date — the query trip sheets (Module 3+) and the preview endpoint below both use.

**Query params:**

| Name | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `rule_type` | string | yes | — | |
| `vehicle_type` | string | yes | — | |
| `on_date` | string | no | today | `YYYY-MM-DD` |

**Response 200:** `{ "rule": { ... } }`

**Errors:** `400 VALIDATION_ERROR`, `404 NO_APPLICABLE_RULE`.

> **Route order note:** this path is registered before `GET /rules/:ruleId` in `pricing.routes.js` specifically so Express's literal-path matching doesn't let `:ruleId` capture the string `"applicable"` and fail UUID validation instead of reaching this handler.

### GET /api/v1/pricing/rules/:ruleId

**Permission:** `pricing:read`

**Response 200:** `{ "rule": { ... } }`

**Errors:** `404 PRICING_RULE_NOT_FOUND`.

### PATCH /api/v1/pricing/rules/:ruleId

**Permission:** `pricing:write`
**Purpose:** Update. Only `label`, `notes`, and `effective_to` are editable — every rate field and `effective_from`/`rule_type`/`vehicle_type` are `forbidden()` at the Joi layer (immutable; see ADR-005 and `05-design-decisions.md`).

**Body:** `label` (string, optional), `notes` (string, optional), `effective_to` (date, optional). At least one required.

**Response 200:** `{ "rule": { ... } }`

**Errors:** `400 VALIDATION_ERROR` (empty patch, or any attempt to include a forbidden field), `404 PRICING_RULE_NOT_FOUND`.

### POST /api/v1/pricing/rules/:ruleId/supersede

**Permission:** `pricing:write`
**Purpose:** The only way to change a rate. Atomically closes the target rule's `effective_to` at the new rule's `effective_from` and inserts the new rule as the current, open-ended version.

**Body:** Same rate/label/notes fields as create, minus `rule_type` and `vehicle_type` (inherited from the rule being superseded) and minus `effective_to` (always `NULL` on the new row — a supersede always creates an open-ended version). `effective_from` is required and must be today or later — you cannot retroactively supersede a rate for a date that's already passed.

**Response 200:**

```json
{
  "superseded": { "id": "...", "effective_to": "2026-07-18", "...": "..." },
  "new_rule": { "id": "...", "effective_from": "2026-07-18", "effective_to": null, "...": "..." }
}
```

**Errors:** `400 VALIDATION_ERROR` (including `effective_from` in the past), `400 LOCAL_FIELDS_MISSING` / `400 OUTSTATION_FIELDS_MISSING` / `400 PERFORMANCE_FIELDS_MISSING`, `400 ALREADY_SUPERSEDED`, `404 PRICING_RULE_NOT_FOUND`, `409 PRICING_RULE_OVERLAP`.

### POST /api/v1/pricing/preview

**Permission:** `pricing:read` (a calculation preview is read-only from a data-mutation standpoint, despite being a `POST`)
**Purpose:** Run the applicable rule for a (rule type, vehicle type, date) through the matching calculator in `src/domain/pricing/` and return the result, with both paise and formatted-rupee values.

**Body:**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `rule_type` | string | yes | |
| `vehicle_type` | string | yes | |
| `on_date` | string | no | Defaults to today |
| `usage` | object | yes | Shape depends on `rule_type` — validated loosely at the Joi layer (`Joi.object().unknown(true)`); the calculator itself throws a `TypeError` on a genuinely missing field, which the route lets propagate as a 500 today (see `07-debugging-playbook.md` — this is a real, currently-unmapped gap, not a documented error code) |

`usage` field names follow the same `*_rupees` wire convention as rule creation for any monetary field (e.g. `toll_rupees`, `advance_rupees`); plain counts (`total_km`, `total_hours`, `total_days`, `running_km`) are unitless integers, not money, and are passed through unchanged.

**Response 200:**

```json
{
  "rule": { "id": "...", "rule_type": "LOCAL_PACKAGE", "vehicle_type": "SEDAN", "label": "...", "effective_from": "...", "effective_to": null },
  "usage": { "total_km": 217, "total_hours": 12, "toll_paise": 0 },
  "result": {
    "base_paise": 220000,
    "extra_km": 137,
    "extra_km_paise": 191800,
    "extra_hours": 4,
    "extra_hours_paise": 72000,
    "toll_paise": 0,
    "subtotal_paise": 483800,
    "total_paise": 483800,
    "breakdown": [ { "label": "Base package", "value_paise": 220000 }, "..." ],
    "formatted": { "total_rupees": "₹4,838.00", "...": "..." }
  }
}
```

The exact keys inside `result` depend on `rule_type` — see `src/domain/pricing/local.js` / `outstation.js` / `performance.js` for each shape.

**Errors:** `400 VALIDATION_ERROR`, `404 NO_APPLICABLE_RULE`.
