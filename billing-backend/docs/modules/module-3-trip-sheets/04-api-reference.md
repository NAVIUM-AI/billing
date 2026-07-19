# API reference

_Last updated: 2026-07-19. Reviewers: TBD._

All endpoints below require `Authorization: Bearer <accessToken>`, are mounted under `/api/v1/trips`, and are defined in `src/api/v1/trips.routes.js` — the only route file Module 3 adds. Every route runs `authenticate` then `tenantContext` before any permission check, same as every other module. Permission keys are checked against `src/config/accessMatrix.js`; a role not listed for a given key gets `403 FORBIDDEN` with `error.details.required` naming the key. Full error code definitions are in `06-error-reference.md`.

## Summary

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/trips/performance-sheet` | `trips:read` | Blue UI performance-sheet projection, grouped by customer, JSON |
| `GET` | `/api/v1/trips/performance-sheet/export.csv` | `trips:read` | Same projection, RFC 4180 CSV |
| `POST` | `/api/v1/trips` | `trips:write` | Create a trip sheet in `DRAFT` |
| `GET` | `/api/v1/trips` | `trips:read` | List trips with filters, sort, pagination, aggregates |
| `GET` | `/api/v1/trips/:tripId` | `trips:read` | Fetch one trip, full detail |
| `PATCH` | `/api/v1/trips/:tripId` | `trips:write` | Edit a `DRAFT` trip |
| `POST` | `/api/v1/trips/:tripId/finalize` | `trips:finalize` | `DRAFT → FINALIZED` |
| `POST` | `/api/v1/trips/:tripId/cancel` | `trips:cancel` | `DRAFT`/`FINALIZED` `→ CANCELLED` |

The performance-sheet routes are registered ahead of `GET /trips` and `GET /trips/:tripId` in the router file specifically so the literal paths read clearly ahead of the parameterized one, following the same convention Module 2's `pricing.routes.js` uses for `/rules/applicable` ahead of `/rules/:ruleId` — Express would disambiguate the two regardless, since `/performance-sheet` never collides with `/:tripId` as a pattern, but the ordering is kept as a readability convention.

## Trip creation

### POST /api/v1/trips

**Permission:** `trips:write`
**Purpose:** Create a new trip sheet in `DRAFT` status. Handles all four `service_type` × `billing_mode` combinations through the same endpoint; which pricing calculator runs is derived internally from those two fields.

**Body** (`createTripSheetSchema`, `src/validators/tripSheet.validator.js`):

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `service_type` | string | yes | `LOCAL` or `OUTSTATION` |
| `billing_mode` | string | yes | `GST` or `PERFORMANCE` |
| `customer_id` | UUID | yes | Must be an active customer in this tenant |
| `vehicle_id` | UUID | yes | Must be an active vehicle in this tenant |
| `driver_id` | UUID | no | Nullable; an inactive driver is accepted (a trip may reference a since-archived driver) |
| `trip_date` | string | yes | `YYYY-MM-DD`, cannot be in the future (evaluated at request time) |
| `start_datetime` / `end_datetime` | ISO datetime | no | `end_datetime` must be `>= start_datetime` if both given |
| `opening_km` / `closing_km` | integer | no | `closing_km` must be `>= opening_km` if both given |
| `total_km` | integer | yes | `>= 0` |
| `total_hours` | integer | yes | `>= 0` |
| `total_days` | integer | no | `1`-`90`, default `1` |
| `toll_rupees`, `parking_rupees`, `permit_rupees`, `fasttag_rupees`, `advance_rupees` | number | no | `>= 0`, default `0`; converted to paise at the service boundary |
| `tolls` | array | no | Itemized toll receipts (see `tollReceiptSchema`); default `[]`. Mutually exclusive with a nonzero `toll_rupees` — see `TOLL_INPUT_CONFLICT` |
| `booked_by`, `pax_note`, `remarks` | string | no | Free text metadata |

Each `tolls[]` item: `plaza_name` (string, 2-255, required), `toll_id` (string, optional), `amount_rupees` (number, positive, max 50000, required), `crossed_at` (ISO datetime, optional), `vehicle_number` (string, optional), `closing_balance_rupees` (number, optional), `notes` (string, optional). Array capped at 50 items.

**Response 201:**

```json
{
  "trip": {
    "id": "...",
    "trip_sheet_number": "TS-1/26-27",
    "service_type": "OUTSTATION",
    "billing_mode": "GST",
    "status": "DRAFT",
    "customer_id": "...",
    "vehicle_id": "...",
    "driver_id": null,
    "snapshot_vehicle_number": "KA01AM7323",
    "snapshot_customer_name": "...",
    "trip_date": "2026-07-08",
    "total_km": 1699,
    "base_amount_paise": 8495000,
    "driver_batta_paise": 480000,
    "subtotal_paise": 9219000,
    "gross_paise": 9219000,
    "net_payable_paise": 9219000,
    "breakdown": [ "..." ],
    "tolls": []
  }
}
```

The exact set of populated `snap_*`/computed-total fields depends on `service_type`/`billing_mode` — see `03-database-schema.md`'s subtotal formulas.

**Error codes:** `400 VALIDATION_ERROR`, `400 INVALID_KM_RANGE`, `400 INVALID_DATETIME_RANGE`, `400 TOLL_INPUT_CONFLICT`, `400 NO_APPLICABLE_PRICING_RULE`, `400 INVALID_CALCULATION_INPUT`, `403 FORBIDDEN`, `404 CUSTOMER_NOT_FOUND`, `404 VEHICLE_NOT_FOUND`, `404 DRIVER_NOT_FOUND`, `409 TRIP_NUMBER_COLLISION`.

## Trip retrieval

### GET /api/v1/trips/:tripId

**Permission:** `trips:read`
**Purpose:** Fetch one trip with full detail, including fields the list endpoint omits.

**Path params:** `tripId` (UUID v4).

**Response 200:**

```json
{
  "trip": {
    "id": "...",
    "trip_sheet_number": "...",
    "...": "all trip_sheets columns",
    "breakdown": [ "..." ],
    "snap_base_hours": null,
    "snap_slab_rate_paise": 5000,
    "tolls": [ { "id": "...", "plaza_name": "...", "amount_paise": 49000, "line_number": 1 } ]
  }
}
```

`breakdown`, every `snap_*` field, and the `tolls` array are included here and only here — `GET /trips` deliberately omits all three to keep the list payload small (see `05-design-decisions.md`).

**Error codes:** `400 VALIDATION_ERROR` (malformed UUID), `404 TRIP_NOT_FOUND` (missing, or belongs to a different tenant — RLS makes the two indistinguishable by design).

## Trip editing (DRAFT)

### PATCH /api/v1/trips/:tripId

**Permission:** `trips:write`
**Purpose:** Edit a `DRAFT` trip. Every charge/usage field is optional; whatever's present overrides the trip's current value, and derived totals (`base_amount_paise`, `extras_amount_paise`, `driver_batta_paise`, `subtotal_paise`, `gross_paise`, `net_payable_paise`, `breakdown`) are always recomputed together via the pricing engine, using the trip's original pricing rule (never an implicit re-lookup — see `02-architecture.md`).

**Path params:** `tripId` (UUID v4).

**Body** (`updateTripSheetSchema`): the same charge/usage/metadata fields as create (`trip_date`, `start_datetime`, `end_datetime`, `opening_km`, `closing_km`, `total_km`, `total_hours`, `total_days`, `toll_rupees`, `parking_rupees`, `permit_rupees`, `fasttag_rupees`, `advance_rupees`, `tolls`, `booked_by`, `pax_note`, `remarks`, `driver_id`), all optional, at least one required. Deliberately excludes `service_type`, `billing_mode`, `customer_id`, `vehicle_id`, and every identity/audit/snapshot field — those are immutable even in `DRAFT`. The schema calls `.unknown(false)` explicitly so an attempt to patch an immutable field is rejected with `400 VALIDATION_ERROR` rather than silently stripped (see `05-design-decisions.md`).

If `tolls` is present in the body (even as `[]`), the trip's toll list is atomically replaced (delete-then-reinsert in the same transaction); if `tolls` is absent, the existing toll rows are left untouched.

**Response 200:** `{ "trip": { "...": "...", "tolls": [ "..." ] } }` — same shape as `GET /trips/:tripId`.

**Error codes:** `400 VALIDATION_ERROR` (including an attempt to patch an immutable field, or an empty patch), `400 INVALID_KM_RANGE`, `400 INVALID_DATETIME_RANGE`, `400 TOLL_INPUT_CONFLICT`, `400 INVALID_CALCULATION_INPUT`, `403 FORBIDDEN`, `404 TRIP_NOT_FOUND`, `404 DRIVER_NOT_FOUND`, `409 TRIP_NOT_EDITABLE` (trip is not `DRAFT`), `409 TRIP_STATUS_CHANGED_DURING_UPDATE` (defensive — see `07-debugging-playbook.md`).

## Trip lifecycle transitions

### POST /api/v1/trips/:tripId/finalize

**Permission:** `trips:finalize`
**Purpose:** `DRAFT → FINALIZED`. No body. A pure state transition — no recomputation, no fields to supply.

**Path params:** `tripId` (UUID v4).

**Response 200:** `{ "trip": { "...": "...", "status": "FINALIZED", "finalized_at": "...", "finalized_by": "...", "tolls": [ "..." ] } }`.

**Error codes:** `403 FORBIDDEN`, `404 TRIP_NOT_FOUND`, `409 INVALID_STATE_TRANSITION` (trip isn't `DRAFT`), `409 TRIP_STATUS_CHANGED` (defensive, see `07-debugging-playbook.md`).

### POST /api/v1/trips/:tripId/cancel

**Permission:** `trips:cancel`
**Purpose:** `DRAFT` or `FINALIZED` `→ CANCELLED`. Terminal — no un-cancel. Requires a reason.

**Path params:** `tripId` (UUID v4).

**Body** (`cancelTripSchema`): `reason` (string, trimmed, 3-500 chars, required).

**Response 200:** `{ "trip": { "...": "...", "status": "CANCELLED", "cancelled_at": "...", "cancelled_by": "...", "cancellation_reason": "...", "tolls": [ "..." ] } }`. Toll rows are left untouched — they remain part of the audit trail on a cancelled trip.

**Error codes:** `400 VALIDATION_ERROR` (missing/too-short reason), `403 FORBIDDEN`, `404 TRIP_NOT_FOUND`, `409 INVALID_STATE_TRANSITION` (trip is already `CANCELLED`, or is `INVOICED` — which needs a credit-note reversal instead), `409 TRIP_STATUS_CHANGED`.

There is no route for the `INVOICED` transition. `markTripInvoiced` exists as a service function only (`tripSheet.service.js`), reserved for Module 4's invoice-issue flow to call from within its own transaction.

## Trip listing + filters

### GET /api/v1/trips

**Permission:** `trips:read`
**Purpose:** List trips for the current tenant with composable filters, whitelisted sort, offset/limit pagination, and aggregates computed over the full filtered set.

**Query params** (`listTripsQuerySchema`):

| Name | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | integer | `25` | `1`-`100` |
| `offset` | integer | `0` | `>= 0` |
| `customer_id` / `vehicle_id` / `driver_id` | UUID | — | Exact match |
| `from_date` / `to_date` | date | — | Inclusive range on `trip_date`; `from_date` must be `<= to_date` |
| `status` | string | — | Comma-separated `trip_status_enum` values, e.g. `DRAFT,FINALIZED`. Explicit `status` overrides the `includeCancelled` default |
| `service_type` | string | — | `LOCAL` or `OUTSTATION` |
| `billing_mode` | string | — | `GST` or `PERFORMANCE` |
| `search` | string | — | 1-50 chars; substring match on `trip_sheet_number` and `snapshot_customer_name` |
| `sort_by` | string | `trip_date` | `trip_date`, `created_at`, `total_km`, `net_payable_paise` — hardcoded whitelist, other values rejected |
| `sort_dir` | string | `desc` | `asc` or `desc` |
| `includeCancelled` | boolean | `false` | Ignored if `status` is explicitly given |

**Response 200:**

```json
{
  "trips": [
    {
      "id": "...", "trip_sheet_number": "...", "service_type": "LOCAL", "billing_mode": "GST",
      "status": "FINALIZED", "customer_id": "...", "vehicle_id": "...", "driver_id": null,
      "snapshot_vehicle_number": "...", "snapshot_vehicle_type": "SEDAN",
      "snapshot_customer_name": "...", "snapshot_customer_gstin": null,
      "trip_date": "2026-07-08", "total_km": 217, "total_hours": 10, "total_days": 1,
      "subtotal_paise": 447800, "gross_paise": 447800, "net_payable_paise": 447800,
      "advance_paise": 0, "finalized_at": "...", "cancelled_at": null, "invoice_id": null,
      "created_at": "...", "updated_at": "..."
    }
  ],
  "pagination": { "total": 7, "limit": 25, "offset": 0, "has_more": false },
  "aggregates": {
    "sum_net_payable_paise": 13718800,
    "sum_gross_paise": 13718800,
    "count_by_status": { "DRAFT": 4, "FINALIZED": 3, "INVOICED": 0, "CANCELLED": 0 },
    "sum_net_payable_rupees": "₹1,37,188.00",
    "sum_gross_rupees": "₹1,37,188.00"
  }
}
```

Each trip row deliberately omits `breakdown`, every `snap_*` field, and `tolls` — see `GET /trips/:tripId` for the full-detail shape. `aggregates` reflects the same filter as `trips`/`pagination`, computed independent of `limit`/`offset`.

**Error codes:** `400 VALIDATION_ERROR` (including an invalid `status` token, an inverted date range, or an unrecognized `sort_by`), `403 FORBIDDEN`.

## Performance sheet + CSV export

### GET /api/v1/trips/performance-sheet

**Permission:** `trips:read`
**Purpose:** Blue UI performance-sheet projection over `billing_mode = 'PERFORMANCE'` trips only — this filter is fixed and cannot be overridden by any query param. Grouped by customer with per-customer subtotals and a grand total across the filtered set.

**Query params** (`performanceSheetQuerySchema`): `customer_id`, `vehicle_id`, `driver_id`, `from_date`, `to_date`, `service_type`, `status`, `includeCancelled` — same semantics as `GET /trips` above. `sort_by` is a narrower whitelist here: `trip_date` (default), `total_km`, `net_payable_paise` (no `created_at`). `sort_dir` defaults to `asc` (chronological), not `desc`.

**Response 200:**

```json
{
  "groups": [
    {
      "customer_id": "...",
      "customer_name": "Ramesh Iyer",
      "customer_type": "B2C",
      "rows": [
        {
          "SL": 1, "DATE": "2026-07-08", "VEHICLE_TYPE": "SEDAN", "VEHICLE_NUMBER": "...",
          "TOTAL_RUNNING_KM": 300,
          "PER_KM_COST_RUPEES": 14, "PER_KM_COST_PAISE": 1400,
          "TOTAL_COST_RUPEES": 4200, "TOTAL_COST_PAISE": 420000,
          "BATA_RUPEES": 300, "BATA_PAISE": 30000,
          "TOLL_CHARGES_RUPEES": 0, "TOLL_CHARGES_PAISE": 0,
          "GRAND_TOTAL_RUPEES": 4500, "GRAND_TOTAL_PAISE": 450000,
          "TRIP_ID": "...", "STATUS": "DRAFT"
        }
      ],
      "subtotal": { "total_running_km": 550, "running_cost_paise": 770000, "batta_paise": 90000, "toll_paise": 0, "total_paise": 860000 }
    }
  ],
  "grand_total": { "total_running_km": 1750, "running_cost_paise": 7050000, "batta_paise": 220000, "toll_paise": 0, "total_paise": 7270000, "row_count": 6, "group_count": 3 },
  "filters_applied": { "customer_id": null, "vehicle_id": null, "driver_id": null, "from_date": null, "to_date": null, "service_type": null, "status": null, "include_cancelled": false }
}
```

`TOTAL_COST_*` is the row's base running-cost figure (`per_km_rate × total_km`); `GRAND_TOTAL_*` is the row's final total including batta and tolls — the Blue UI reference PDF uses `TOTAL_COST` for both concepts in different columns, disambiguated here by name.

**Error codes:** `400 VALIDATION_ERROR`, `400 EXPORT_TOO_LARGE` (filtered set exceeds 10,000 rows), `403 FORBIDDEN`.

### GET /api/v1/trips/performance-sheet/export.csv

**Permission:** `trips:read`
**Purpose:** Same projection as above, rendered as an RFC 4180 CSV file for download.

**Query params:** identical to `GET /trips/performance-sheet` (`performanceSheetCsvQuerySchema` is the same schema object).

**Response 200:** `text/csv; charset=utf-8` body — not JSON. Header row: `SL,DATE,CUSTOMER,VEHICLE_TYPE,VEHICLE_NUMBER,TOTAL_RUNNING_KM,PER_KM_COST_RUPEES,TOTAL_COST_RUPEES,BATA_RUPEES,TOLL_CHARGES_RUPEES,GRAND_TOTAL_RUPEES,STATUS`, followed by each group's data rows, a `SUBTOTAL` row per group, and one `GRAND TOTAL` row at the end. CRLF line endings; any field containing a comma, double quote, or newline is quote-wrapped with internal quotes doubled.

**Response headers:**

| Header | Value |
| --- | --- |
| `Content-Type` | `text/csv; charset=utf-8` |
| `Content-Disposition` | `attachment; filename="performance-sheet-<YYYY-MM-DD>.csv"` |
| `X-Row-Count` | Total data row count (matches `grand_total.row_count`) |
| `X-Group-Count` | Total group count (matches `grand_total.group_count`) |

**Error codes:** same as the JSON endpoint — `400 VALIDATION_ERROR`, `400 EXPORT_TOO_LARGE`, `403 FORBIDDEN`.
