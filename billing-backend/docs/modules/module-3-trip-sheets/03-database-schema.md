# Database schema

_Last updated: 2026-07-19. Reviewers: TBD._

Module 3 adds three tables across three migrations: `trip_sheets` + `trip_sheet_sequences` (one migration), a follow-up migration adding `trip_sheet_prefix` to `tenants`, and `trip_tolls`. Every table follows the tenant-isolation shape established in Modules 1-2 — a `tenant_id` column, forced row-level security, and (for `trip_sheets`) `created_at`/`updated_at` maintained by the shared trigger function.

## Table: `trip_sheets`

**Migration:** `migrations/1784355025158_trip-sheets.sql`

Purpose: one row per trip — the transactional core of the module. Carries the trip's identity, its party references, a full snapshot of the rate/vehicle/customer data used to cost it, the usage inputs an operator entered, the computed totals, and lifecycle/audit metadata.

| Column | Type | Nullable | Default | Description |
| --- | --- | --- | --- | --- |
| `id` | UUID | no | `gen_random_uuid()` | Primary key |
| `tenant_id` | UUID | no | — | FK to `tenants(id)`, `ON DELETE CASCADE` |
| `trip_sheet_number` | VARCHAR(30) | no | — | `{prefix}-{seq}/{FY}`, e.g. `TS-1586/26-27`; `prefix` from `tenants.trip_sheet_prefix` |
| `service_type` | `trip_service_type_enum` | no | — | `LOCAL` or `OUTSTATION` |
| `billing_mode` | `trip_billing_mode_enum` | no | — | `GST` or `PERFORMANCE` |
| `status` | `trip_status_enum` | no | `DRAFT` | `DRAFT`, `FINALIZED`, `INVOICED`, `CANCELLED` |
| `customer_id` | UUID | no | — | FK to `customers(id)`, `ON DELETE RESTRICT` |
| `vehicle_id` | UUID | no | — | FK to `vehicles(id)`, `ON DELETE RESTRICT` |
| `driver_id` | UUID | yes | — | FK to `drivers(id)`, `ON DELETE SET NULL` |
| `pricing_rule_id` | UUID | yes | — | FK to `pricing_rules(id)`, `ON DELETE SET NULL` — nullable because a superseded or (hypothetically) hard-deleted rule shouldn't block reads; the snapshot columns below are the fallback source of truth if this goes `NULL` |
| `snapshot_vehicle_number` | VARCHAR(20) | no | — | Vehicle's canonical number at trip-creation time |
| `snapshot_vehicle_type` | `vehicle_type_enum` | no | — | |
| `snapshot_customer_name` | VARCHAR(255) | no | — | `company_name` for B2B, `name` for B2C |
| `snapshot_customer_gstin` | VARCHAR(15) | yes | — | |
| `snap_base_hours` | SMALLINT | yes | — | LOCAL_PACKAGE rule snapshot |
| `snap_base_km` | INTEGER | yes | — | LOCAL_PACKAGE |
| `snap_base_price_paise` | INTEGER | yes | — | LOCAL_PACKAGE |
| `snap_extra_km_rate_paise` | INTEGER | yes | — | LOCAL_PACKAGE |
| `snap_extra_hr_rate_paise` | INTEGER | yes | — | LOCAL_PACKAGE |
| `snap_slab_rate_paise` | INTEGER | yes | — | OUTSTATION_SLAB |
| `snap_min_km_per_day` | INTEGER | yes | — | OUTSTATION_SLAB |
| `snap_driver_batta_per_day_paise` | INTEGER | yes | — | OUTSTATION_SLAB |
| `snap_per_km_rate_paise` | INTEGER | yes | — | PERFORMANCE |
| `snap_performance_batta_paise` | INTEGER | yes | — | PERFORMANCE |
| `trip_date` | DATE | no | — | Cannot be in the future (Joi-enforced at request time, not a DB CHECK) |
| `start_datetime` | TIMESTAMPTZ | yes | — | |
| `end_datetime` | TIMESTAMPTZ | yes | — | |
| `opening_km` | INTEGER | yes | — | |
| `closing_km` | INTEGER | yes | — | |
| `total_km` | INTEGER | no | — | `CHECK (total_km >= 0)` |
| `total_hours` | INTEGER | no | — | `CHECK (total_hours >= 0)` |
| `total_days` | SMALLINT | no | `1` | `CHECK (total_days >= 1)` |
| `toll_paise` | INTEGER | no | `0` | `CHECK (>= 0)`. Either the lump-sum `toll_rupees` input, converted, or the sum of `trip_tolls` rows when an itemized array was sent |
| `parking_paise` | INTEGER | no | `0` | `CHECK (>= 0)` |
| `permit_paise` | INTEGER | no | `0` | `CHECK (>= 0)` |
| `fasttag_paise` | INTEGER | no | `0` | `CHECK (>= 0)` |
| `advance_paise` | INTEGER | no | `0` | `CHECK (>= 0)` |
| `base_amount_paise` | INTEGER | no | `0` | Calculator output — meaning depends on `rule_type` (base package price / slab amount / running-km cost) |
| `extras_amount_paise` | INTEGER | no | `0` | Extra-km + extra-hours (LOCAL) or parking+permit+fasttag (OUTSTATION); `0` for PERFORMANCE |
| `driver_batta_paise` | INTEGER | no | `0` | `0` for LOCAL_PACKAGE; batta for OUTSTATION_SLAB and PERFORMANCE |
| `subtotal_paise` | INTEGER | no | — | See per-`rule_type` formula below |
| `gross_paise` | INTEGER | no | — | `= subtotal_paise` in every case (advance is not subtracted before gross) |
| `net_payable_paise` | INTEGER | no | — | `= gross_paise` for LOCAL/PERFORMANCE; `= gross_paise - advance_paise` for OUTSTATION |
| `breakdown` | JSONB | no | — | The full calculator output, stored verbatim for audit and future PDF regeneration; frozen at creation/last-PATCH time |
| `booked_by` | VARCHAR(255) | yes | — | Free text, from the Yellow/Blue UI's "Bkd by" field |
| `pax_note` | VARCHAR(255) | yes | — | Free text, "PAX : ..." |
| `remarks` | TEXT | yes | — | |
| `created_by` | UUID | yes | — | FK to `users(id)` |
| `created_at` / `updated_at` | TIMESTAMPTZ | no | `NOW()` | `updated_at` maintained by `trg_trip_sheets_updated_at` |
| `finalized_at` / `finalized_by` | TIMESTAMPTZ / UUID | yes | — | Set by `POST .../finalize` |
| `invoiced_at` / `invoice_id` | TIMESTAMPTZ / UUID | yes | — | Reserved for Module 4's `markTripInvoiced`; no route sets these today |
| `cancelled_at` / `cancelled_by` / `cancellation_reason` | TIMESTAMPTZ / UUID / TEXT | yes | — | Set by `POST .../cancel`; `cancellation_reason` is required at the API layer (min 3 chars) even though the column itself is nullable |

Subtotal formula by `rule_type` (derived from `service_type` × `billing_mode`, see `05-design-decisions.md`):

- **LOCAL_PACKAGE**: `subtotal = base_amount + extras_amount + toll`
- **OUTSTATION_SLAB**: `subtotal = base_amount(slab) + driver_batta + toll + parking + permit + fasttag`
- **PERFORMANCE**: `subtotal = base_amount(km cost) + driver_batta + toll`

**Constraints:**

- `trip_sheets_number_per_tenant_unique` — `UNIQUE (tenant_id, trip_sheet_number)`.
- `trip_sheets_km_range` — `CHECK (opening_km IS NULL OR closing_km IS NULL OR closing_km >= opening_km)`.
- `trip_sheets_datetime_range` — `CHECK (start_datetime IS NULL OR end_datetime IS NULL OR end_datetime >= start_datetime)`.

Both range CHECKs are enforced at the Joi/service layer first (`INVALID_KM_RANGE`, `INVALID_DATETIME_RANGE` — see `06-error-reference.md`), with the DB CHECK as the non-bypassable backstop, same convention as Module 2's customer format CHECKs.

**Indexes:**

- `idx_trips_tenant_date` on `(tenant_id, trip_date DESC)` — the default sort for both the general list and the performance sheet.
- `idx_trips_tenant_customer` on `(tenant_id, customer_id, trip_date DESC)` — customer-filtered lookups (used by both `GET /trips?customer_id=` and the performance sheet's per-customer grouping source data).
- `idx_trips_tenant_status` on `(tenant_id, status)` `WHERE status IN ('DRAFT','FINALIZED')` — partial index supporting the common "active trips" query shape without scanning terminal (`INVOICED`/`CANCELLED`) rows.
- `idx_trips_tenant_vehicle` on `(tenant_id, vehicle_id, trip_date DESC)`.

**RLS policy** (`trip_sheets_tenant_isolation`):

```sql
CREATE POLICY trip_sheets_tenant_isolation ON trip_sheets
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
```

Both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` are set (ADR-003).

## Table: `trip_sheet_sequences`

**Migration:** `migrations/1784355025158_trip-sheets.sql` (same file as `trip_sheets`)

Purpose: a concurrency-safe per-tenant, per-fiscal-year counter that trip sheet numbering draws from. One row per `(tenant_id, fiscal_year)` combination that has ever had a trip created in it.

| Column | Type | Nullable | Default | Description |
| --- | --- | --- | --- | --- |
| `tenant_id` | UUID | no | — | FK to `tenants(id)`, `ON DELETE CASCADE`; part of the composite PK |
| `fiscal_year` | VARCHAR(5) | no | — | e.g. `'26-27'`; part of the composite PK |
| `next_seq` | INTEGER | no | `1` | The next sequence number to allocate |
| `updated_at` | TIMESTAMPTZ | no | `NOW()` | Updated on every allocation |

`PRIMARY KEY (tenant_id, fiscal_year)`. `tripSheetSequence.repository.js#allocateSeq` allocates atomically via `INSERT ... ON CONFLICT (tenant_id, fiscal_year) DO UPDATE SET next_seq = next_seq + 1 RETURNING ...`, using an `xmax`-based trick (see the repository's own extensive inline comment) to distinguish "this was the first trip of a new fiscal year" from "this incremented an existing counter" in a single round trip, with no separate `SELECT` needed. Because this always runs inside the same transaction as the parent trip insert (`db.withTenantContext`), a failed insert rolls the sequence allocation back with it — no sequence number is ever burned on a trip that didn't actually get created.

**RLS**: enabled and forced defensively, with the same tenant-isolation policy shape as `trip_sheets`, even though every write goes through a tenant-scoped transaction regardless — the migration's own comment notes this is belt-and-suspenders rather than load-bearing for this specific table.

## Table: `trip_tolls`

**Migration:** `migrations/1784375712640_trip-tolls.sql`

Purpose: itemized per-plaza toll receipts for an OUTSTATION trip (Task 3.2). A trip's `toll_paise` is either a lump-sum figure or the sum of this table's rows for that trip — never both (enforced in the service, `TOLL_INPUT_CONFLICT`).

| Column | Type | Nullable | Default | Description |
| --- | --- | --- | --- | --- |
| `id` | UUID | no | `gen_random_uuid()` | Primary key |
| `trip_sheet_id` | UUID | no | — | FK to `trip_sheets(id)`, `ON DELETE CASCADE` |
| `tenant_id` | UUID | no | — | Denormalized from the parent trip, so RLS can filter this table directly without a join |
| `plaza_name` | VARCHAR(255) | no | — | As printed on the receipt |
| `toll_id` | VARCHAR(50) | yes | — | Optional — some slips omit a numeric ID |
| `amount_paise` | INTEGER | no | — | `CHECK (amount_paise >= 0)` |
| `crossed_at` | TIMESTAMPTZ | yes | — | Nullable — a scanned receipt may not have a readable timestamp |
| `vehicle_number` | VARCHAR(20) | yes | — | As printed on the receipt (may differ in formatting from the trip's own vehicle number) |
| `closing_balance_paise` | INTEGER | yes | — | FASTag closing balance after this toll was deducted, if the receipt shows it |
| `notes` | TEXT | yes | — | |
| `line_number` | SMALLINT | no | — | `CHECK (line_number > 0)`; explicit display ordering, assigned sequentially in request order rather than relying on `crossed_at`/`created_at` |
| `created_at` | TIMESTAMPTZ | no | `NOW()` | No `updated_at` — tolls are append-once, delete-with-parent, with no in-place mutation lifecycle (see below) |

**Constraints:**

- `trip_tolls_line_positive` — `CHECK (line_number > 0)`.
- `trip_tolls_line_per_trip_unique` — `UNIQUE (trip_sheet_id, line_number)`.

**Indexes:**

- `idx_trip_tolls_trip` on `(trip_sheet_id, line_number)` — the ordered read path (`GET /trips/:id`'s `tolls` array).
- `idx_trip_tolls_tenant_date` on `(tenant_id, crossed_at DESC)` `WHERE crossed_at IS NOT NULL`.

**RLS policy** (`trip_tolls_tenant_isolation`): same shape as `trip_sheets_tenant_isolation`, reading the denormalized `tenant_id` column directly — identical pattern to `customer_contacts` in Module 2.

There is no `UPDATE` path for an individual toll row. The only two write operations are `insertBatch` (multi-row `INSERT`, used both on trip creation and, atomically alongside `deleteByTrip`, on a DRAFT PATCH that replaces the array) and `deleteByTrip` — a DRAFT PATCH that touches the `tolls` array does a full delete-then-reinsert inside one transaction rather than diffing individual rows, so there is never a committed state where a trip has a partial or zero-row toll list mid-update.

## Enums

### `trip_service_type_enum`

Defined in `migrations/1784355025158_trip-sheets.sql`.

Values: `LOCAL`, `OUTSTATION`.

### `trip_billing_mode_enum`

Defined in the same migration.

Values: `GST`, `PERFORMANCE`.

### `trip_status_enum`

Defined in the same migration.

Values: `DRAFT`, `FINALIZED`, `INVOICED`, `CANCELLED`.

## Non-table schema change: `tenants.trip_sheet_prefix`

**Migration:** `migrations/1784355065021_tenant-trip-sheet-prefix.sql`

`ALTER TABLE tenants ADD COLUMN trip_sheet_prefix VARCHAR(20) NOT NULL DEFAULT 'TS';` — the string prefix used in every trip sheet number this tenant generates (e.g. `TS-1586/26-27`). Editable via `PATCH /settings/business` (Module 1's settings endpoint, not a Module 3 route); Module 3 only reads it, at trip-creation time.

## Relationships to Module 1/2

- `trip_sheets.customer_id → customers.id`, `ON DELETE RESTRICT` — a customer with existing trips cannot be hard-deleted (moot in practice, since Module 2 exposes no `DELETE` on customers either, but the FK action documents the intent independent of that).
- `trip_sheets.vehicle_id → vehicles.id`, `ON DELETE RESTRICT`.
- `trip_sheets.driver_id → drivers.id`, `ON DELETE SET NULL` — a driver can be hard-deleted (again, not actually exposed) without blocking on trip history; the trip's `driver_id` would just go `NULL`, though the driver's name is not separately snapshotted the way vehicle/customer identity is (TODO: not currently snapshotted — a gap if driver records are ever hard-deleted).
- `trip_sheets.pricing_rule_id → pricing_rules.id`, `ON DELETE SET NULL` — the snapshot columns are the fallback of record if this ever goes `NULL`.
- `trip_tolls.trip_sheet_id → trip_sheets.id`, `ON DELETE CASCADE` — deleting a trip (not exposed via any route today) would take its tolls with it.

## ER Diagram

See [`diagrams/er-diagram.md`](diagrams/er-diagram.md) for the full mermaid diagram, scoped to Module 3's own tables plus their foreign keys into Module 1/2.

## Extensions used

No new Postgres extensions. `pgcrypto` (`gen_random_uuid()`) was already enabled in Module 1; Module 3 introduces no trigram search or exclusion constraints of its own.
