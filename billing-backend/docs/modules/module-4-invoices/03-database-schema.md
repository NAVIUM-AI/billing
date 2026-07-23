# Database schema

_Last updated: 2026-07-23. Reviewers: TBD._

Module 4 adds six tables across three migrations: `invoices` + `invoice_lines` + `invoice_number_sequences` (Task 4.1's `invoice-foundation` migration), `credit_notes` + `credit_note_number_sequences` (Task 4.3), and `payments` (Task 4.4), plus a Task 4.6 migration (`pdf_tracking`) that only adds `pdf_file_size_bytes` to `invoices`/`credit_notes` (the other PDF columns already existed from Tasks 4.1/4.3). Every table follows the tenant-isolation shape established since Module 1 — a `tenant_id` column, forced row-level security.

## Table: `invoices`

**Migration:** `migrations/1784457159086_invoice-foundation.sql` (columns), `migrations/1784573088663_pdf-tracking.sql` (`pdf_file_size_bytes` only — `pdf_url`/`pdf_generated_at`/`pdf_template_version` already existed)

Purpose: one row per invoice, `DRAFT` through its terminal state. Carries identity, the customer reference, every editable charge input, every derived financial total, the immutability snapshots, PDF metadata, and full lifecycle audit fields.

| Column | Type | Nullable | Default | Description |
| --- | --- | --- | --- | --- |
| `id` | UUID | no | `gen_random_uuid()` | Primary key |
| `tenant_id` | UUID | no | — | FK to `tenants(id)`, `ON DELETE CASCADE` |
| `invoice_number` | VARCHAR(30) | yes | — | `NULL` until issued — a DRAFT never consumes a number, preventing gaps in the legal per-FY sequence |
| `invoice_type` | `invoice_type_enum` | no | — | `TAX` or `PERFORMANCE` |
| `status` | `invoice_status_enum` | no | `DRAFT` | `DRAFT` / `ISSUED` / `PAID` / `CANCELLED` |
| `customer_id` | UUID | no | — | FK to `customers(id)`, `ON DELETE RESTRICT` |
| `invoice_date` | DATE | no | — | Cannot be in the future or more than 30 days in the past (service-layer check) |
| `due_date` | DATE | no | — | Derives from `invoice_date + customer.credit_days` at creation; overridable |
| `notes` / `terms` | TEXT | yes | — | Free text |
| `subtotal_paise` | BIGINT | no | `0` | `CHECK (>= 0)`. Sum of every `invoice_lines.line_amount_paise` — the taxable amount |
| `gst_rate_snapshot` | SMALLINT | yes | — | Copied from `tenant.gst_rate` at creation; `NULL` for `PERFORMANCE` |
| `cgst_paise` / `sgst_paise` / `igst_paise` / `total_gst_paise` | BIGINT | no | `0` | Each `CHECK (>= 0)`. Computed by `src/domain/gst/#computeGST` |
| `toll_paise` / `parking_paise` / `permit_paise` / `fasttag_paise` | BIGINT | no | `0` | Each `CHECK (>= 0)`. Invoice-level reimbursement aggregates, added AFTER GST in the grand-total formula (non-taxable pure-agent charges — ADR-010) |
| `discount_paise` | BIGINT | no | `0` | `CHECK (>= 0)`. Applied to the taxable amount BEFORE GST |
| `discount_reason` | VARCHAR(255) | yes | — | |
| `round_off_paise` | INTEGER | no | `0` | `CHECK (BETWEEN -99 AND 99)`. Signed; brings the grand total to a whole rupee |
| `grand_total_paise` | BIGINT | no | `0` | `CHECK (>= 0)`. `= subtotal - discount + gst + toll + parking + permit + fasttag` |
| `net_payable_paise` | BIGINT | no | `0` | `CHECK (>= 0)`. `= grand_total + round_off` (always a whole rupee) |
| `amount_in_words` | VARCHAR(500) | yes | — | Computed at issue (and re-derivable on demand); NOT covered by `transitionStatus`'s own column list, written by a separate `UPDATE` in the same transaction |
| `tenant_snapshot` / `customer_snapshot` | JSONB | yes | — | `NULL` until issue; write-once thereafter (`COALESCE`-guarded) — see `02-architecture.md` |
| `pdf_url` | VARCHAR(500) | yes | — | Relative path under `PDF_STORAGE_ROOT`, e.g. `/pdf-storage/{tenantId}/invoices/{file}` |
| `pdf_generated_at` | TIMESTAMPTZ | yes | — | |
| `pdf_template_version` | VARCHAR(20) | yes | — | The template version used for THIS document's PDF — historical documents keep rendering with their original version even after the current default bumps |
| `pdf_file_size_bytes` | INTEGER | yes | — | Added by the Task 4.6 `pdf_tracking` migration |
| `created_by` | UUID | yes | — | FK to `users(id)` |
| `created_at` / `updated_at` | TIMESTAMPTZ | no | `NOW()` | `updated_at` maintained by `trg_invoices_updated_at` |
| `issued_at` / `issued_by` | TIMESTAMPTZ / UUID | yes | — | Set by `POST .../issue` |
| `cancelled_at` / `cancelled_by` / `cancellation_reason` | TIMESTAMPTZ / UUID / TEXT | yes | — | Set by `POST .../cancel`; reason required at the API layer (min 3 chars) |
| `credit_note_id` | UUID | yes | — | Populated when cancelled via credit note (ISSUED/PAID path only — a DRAFT cancel has no credit note) |

**Constraints:**

- `invoices_number_per_tenant_unique` — `UNIQUE (tenant_id, invoice_number)`. Postgres treats `NULL`s as distinct, so any number of DRAFTs with `NULL` numbers coexist freely.
- `invoices_due_after_issue` — `CHECK (due_date >= invoice_date)`.
- `invoices_perf_no_gst` — `CHECK (invoice_type <> 'PERFORMANCE' OR (cgst_paise = 0 AND sgst_paise = 0 AND igst_paise = 0 AND total_gst_paise = 0))`. A database-level backstop independent of anything the application does (ADR-010's taxable/reimbursement split relies on the application getting this right for `TAX` invoices; this constraint is what guarantees `PERFORMANCE` invoices can never carry GST regardless).

**Indexes:**

- `idx_invoices_tenant_status` on `(tenant_id, status)` `WHERE status IN ('DRAFT','ISSUED')` — partial index for the common "active invoices" query shape.
- `idx_invoices_tenant_customer` on `(tenant_id, customer_id, invoice_date DESC)`.
- `idx_invoices_tenant_type_date` on `(tenant_id, invoice_type, invoice_date DESC)`.

**RLS**: enabled and forced, same tenant-isolation policy shape as every other business table.

## Table: `invoice_lines`

**Migration:** `migrations/1784457159086_invoice-foundation.sql`

Purpose: one row per trip on an invoice — a frozen snapshot of that trip's billing-relevant fields at the moment it was added to the invoice, plus a user-editable `description`.

| Column | Type | Nullable | Default | Description |
| --- | --- | --- | --- | --- |
| `id` | UUID | no | `gen_random_uuid()` | Primary key |
| `invoice_id` | UUID | no | — | FK to `invoices(id)`, `ON DELETE CASCADE` |
| `tenant_id` | UUID | no | — | Denormalized for RLS |
| `trip_sheet_id` | UUID | no | — | FK to `trip_sheets(id)`, `ON DELETE RESTRICT` |
| `line_number` | SMALLINT | no | — | 1-indexed order on the PDF, assigned in caller (picker) order |
| `service_type` | `trip_service_type_enum` | no | — | Snapshot from the trip; drives Yellow-vs-Blue PDF template selection |
| `trip_date` | DATE | no | — | Snapshot |
| `vehicle_number` / `vehicle_type` | VARCHAR(20) / `vehicle_type_enum` | no | — | Snapshot from the trip's own `snapshot_vehicle_number`/`snapshot_vehicle_type` |
| `total_km` / `total_hours` / `total_days` | INTEGER / INTEGER / SMALLINT | no / yes / yes | — | Snapshot |
| `base_amount_paise` | BIGINT | no | `0` | Snapshot from the trip |
| `extras_amount_paise` | BIGINT | no | `0` | Snapshot from the trip, but ONLY for `LOCAL` trips — `0` for `OUTSTATION` (ADR-010) |
| `driver_batta_paise` | BIGINT | no | `0` | Snapshot |
| `line_amount_paise` | BIGINT | no | `0` | `= base + extras + batta`; feeds `invoices.subtotal_paise` |
| `hsn_sac_code` | VARCHAR(10) | no | `'996601'` | "Renting of vehicles" — Indian GST HSN, same on every line |
| `description` | VARCHAR(500) | yes | — | Auto-generated at line creation (e.g. `"SEDAN KA51AK1031 - 217 km local trip on 01-Jun-2026"`), the only user-editable field (Task 4.2), DRAFT-only |
| `created_at` | TIMESTAMPTZ | no | `NOW()` | No `updated_at` — a line is either replaced wholesale (trip-set change) or has only its `description` patched in place |

**Constraints:**

- `invoice_lines_line_per_invoice_unique` — `UNIQUE (invoice_id, line_number)`.
- `invoice_lines_trip_per_invoice_unique` — `UNIQUE (invoice_id, trip_sheet_id)` — the same trip can't appear twice on one invoice.

**Indexes:** `idx_invoice_lines_invoice` on `(invoice_id, line_number)` — the ordered read path.

**RLS**: enabled and forced, reading the denormalized `tenant_id` directly (same pattern as Module 3's `trip_tolls`).

Line mutation is narrow by design: `insertBatch` (multi-row insert, used on create and on a full trip-set replacement), `deleteByInvoice` (paired with a fresh `insertBatch` on trip-set replacement — never a partial diff), and `updateLine` (DRAFT-only, `description` alone — see `invoiceLine.repository.js#LINE_UPDATABLE_COLUMNS`). `updateLine`'s guard is a correlated `EXISTS` subquery confirming the parent invoice is still `DRAFT`, written with the outer scope's `tenant_id`/`invoice_id` referenced via bound parameters rather than unqualified column names — see ADR-011 for why that distinction is load-bearing, not stylistic.

## Table: `invoice_number_sequences`

**Migration:** `migrations/1784457159086_invoice-foundation.sql`

Purpose: a concurrency-safe per-tenant, per-invoice-type, per-fiscal-year counter. One row per `(tenant_id, invoice_type, fiscal_year)` combination that has ever had an invoice issued in it.

| Column | Type | Nullable | Default | Description |
| --- | --- | --- | --- | --- |
| `tenant_id` | UUID | no | — | FK to `tenants(id)`, `ON DELETE CASCADE`; part of the composite PK |
| `invoice_type` | `invoice_type_enum` | no | — | Part of the composite PK — `TAX` and `PERFORMANCE` sequences are independent |
| `fiscal_year` | VARCHAR(5) | no | — | e.g. `'26-27'`; part of the composite PK |
| `next_seq` | INTEGER | no | `1` | The next sequence number to allocate |
| `updated_at` | TIMESTAMPTZ | no | `NOW()` | Updated on every allocation |

`PRIMARY KEY (tenant_id, invoice_type, fiscal_year)`. `src/utils/invoiceNumber.js#allocateInvoiceNumber` allocates atomically via the same `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` plus `xmax::text::int > 0` trick Module 3's `trip_sheet_sequences` established — see `02-architecture.md`'s "Numbering" section. **RLS**: enabled and forced.

## Table: `credit_notes`

**Migration:** `migrations/1784493624346_credit-notes.sql`

Purpose: the legal reversal document created automatically when an `ISSUED`/`PAID` invoice is cancelled. Write-once — there is no `UPDATE` function for this table anywhere in the codebase; a credit note is a permanent record.

| Column | Type | Nullable | Default | Description |
| --- | --- | --- | --- | --- |
| `id` | UUID | no | `gen_random_uuid()` | Primary key |
| `tenant_id` | UUID | no | — | FK to `tenants(id)`, `ON DELETE CASCADE` |
| `credit_note_number` | VARCHAR(30) | no | — | `{prefix}-{seq}/{FY}`, its own gap-free sequence |
| `original_invoice_id` | UUID | no | — | FK to `invoices(id)`, `ON DELETE RESTRICT` |
| `customer_id` | UUID | no | — | FK to `customers(id)`, `ON DELETE RESTRICT` |
| `customer_snapshot` / `tenant_snapshot` | JSONB | no | — | Snapshotted independently, AS OF CANCELLATION — not copied from the original invoice's (older) snapshot |
| `subtotal_paise` / `total_gst_paise` / `cgst_paise` / `sgst_paise` / `igst_paise` / `toll_paise` / `parking_paise` / `permit_paise` / `fasttag_paise` / `discount_paise` / `grand_total_paise` / `net_payable_paise` | BIGINT | no | — | Mirror the original invoice's frozen totals exactly — the reversal amount |
| `credit_note_date` | DATE | no | — | The cancellation date, not the original invoice date |
| `reason` | TEXT | no | — | Required (min 3 chars at the API layer) |
| `amount_in_words` | VARCHAR(500) | yes | — | |
| `pdf_url` / `pdf_generated_at` / `pdf_template_version` / `pdf_file_size_bytes` | VARCHAR(500) / TIMESTAMPTZ / VARCHAR(20) / INTEGER | yes | — | Same PDF-metadata shape as `invoices`; `pdf_template_version`/`pdf_file_size_bytes` added by the Task 4.6 migration, the other two already existed from Task 4.3 |
| `issued_by` | UUID | yes | — | FK to `users(id)` |
| `created_at` | TIMESTAMPTZ | no | `NOW()` | No `updated_at` — write-once |

**Constraints:** `credit_notes_number_per_tenant_unique` — `UNIQUE (tenant_id, credit_note_number)`.

**Indexes:** `idx_credit_notes_tenant_date` on `(tenant_id, credit_note_date DESC)`; `idx_credit_notes_original_invoice` on `(original_invoice_id)`.

**RLS**: enabled and forced. Credit notes have no line-item table of their own — the original invoice's individual lines are not reproduced; only its aggregate totals are mirrored (see `04-api-reference.md`'s PDF section for how this shapes the credit-note PDF layout).

## Table: `credit_note_number_sequences`

**Migration:** `migrations/1784493624346_credit-notes.sql`

Same shape as `invoice_number_sequences`, minus the `invoice_type` axis (credit notes have one sequence per tenant per fiscal year, not split by type): `PRIMARY KEY (tenant_id, fiscal_year)`, `next_seq INTEGER NOT NULL DEFAULT 1`. **RLS**: enabled and forced.

## Table: `payments`

**Migration:** `migrations/1784549843878_payments.sql`

Purpose: one row per payment or advance. Either applies to a specific invoice (`invoice_id` set) or sits as an unallocated advance on the customer (`invoice_id NULL`). Lifecycle is `RECORDED → CANCELLED`, terminal — cancellation is the only reversal path; there is no `DELETE`.

| Column | Type | Nullable | Default | Description |
| --- | --- | --- | --- | --- |
| `id` | UUID | no | `gen_random_uuid()` | Primary key |
| `tenant_id` | UUID | no | — | FK to `tenants(id)`, `ON DELETE CASCADE` |
| `customer_id` | UUID | no | — | FK to `customers(id)`, `ON DELETE RESTRICT` |
| `invoice_id` | UUID | yes | — | FK to `invoices(id)`, `ON DELETE RESTRICT`. `NULL` = unallocated advance |
| `parent_payment_id` | UUID | yes | — | FK to `payments(id)`, `ON DELETE RESTRICT`. Set when this row originated from a split (over-payment spillover) or a partial advance application — points at the originating row, for audit |
| `amount_paise` | BIGINT | no | — | `CHECK (> 0)` — always positive; a cancellation flips `status`, it never creates a negative payment |
| `payment_mode` | `payment_mode_enum` | no | — | `CASH` / `UPI` / `NEFT` / `RTGS` / `IMPS` / `CHEQUE` / `CARD` / `BANK_TRANSFER` |
| `reference_number` | VARCHAR(100) | yes | — | UPI txn ID / NEFT UTR / cheque number / etc.; `NULL` only allowed for `CASH` |
| `received_at` | TIMESTAMPTZ | no | `NOW()` | When money physically arrived — distinct from `created_at` (when it was recorded) |
| `status` | `payment_status_enum` | no | `RECORDED` | `RECORDED` / `CANCELLED` |
| `notes` | TEXT | yes | — | |
| `recorded_by` | UUID | yes | — | FK to `users(id)` |
| `created_at` / `updated_at` | TIMESTAMPTZ | no | `NOW()` | `updated_at` maintained by `trg_payments_updated_at` |
| `cancelled_at` / `cancelled_by` / `cancellation_reason` | TIMESTAMPTZ / UUID / TEXT | yes | — | Set by `POST /payments/:id/cancel` |

**Constraints:**

- `payments_reference_required` — `CHECK (payment_mode = 'CASH' OR (reference_number IS NOT NULL AND length(reference_number) > 0))`.
- `payments_parent_self_ref` — `CHECK (parent_payment_id IS NULL OR parent_payment_id <> id)`.

**Idempotency:** `idx_payments_ref_unique` — a partial `UNIQUE` index on `(tenant_id, payment_mode, reference_number)`, scoped `WHERE payment_mode <> 'CASH' AND status = 'RECORDED' AND reference_number IS NOT NULL`. Prevents the same NEFT UTR/UPI transaction ID from being recorded twice as an active payment; a cancelled payment's reference is free to reuse, since it's no longer active. See ADR-013 for how the two synthetic-reference-generating code paths (over-payment split, partial advance application) stay unique under this same index.

**Query indexes:** `idx_payments_tenant_customer` on `(tenant_id, customer_id, received_at DESC)`; `idx_payments_tenant_invoice` on `(tenant_id, invoice_id, received_at DESC)` `WHERE invoice_id IS NOT NULL`; `idx_payments_tenant_status_advance` on `(tenant_id, customer_id, status)` `WHERE invoice_id IS NULL AND status = 'RECORDED'` (optimizes "find this customer's unallocated advances"); `idx_payments_tenant_date` on `(tenant_id, received_at DESC)`.

**RLS**: enabled and forced.

## Extensions to Module 2/3 tables

- `trip_sheets.held_by_invoice_id` (Task 4.1) — nullable FK to `invoices(id)`, `ON DELETE SET NULL`. Set while a trip is on a DRAFT invoice; cleared when that draft is deleted, edited to drop the trip, or issued (at which point the trip's own `status` becomes `INVOICED` and the hold is redundant). Partial index `idx_trips_held_by_invoice` `WHERE held_by_invoice_id IS NOT NULL`.
- `tenants.gst_rate` (Task 4.1) — `SMALLINT NOT NULL DEFAULT 5`, `CHECK (BETWEEN 0 AND 28)`.
- `tenants.invoice_prefix` (pre-existing from Task 1.1, tightened to `NOT NULL` by Task 4.1) — the TAX invoice number prefix.
- `tenants.performance_prefix` (Task 4.1) — `VARCHAR(30) NOT NULL DEFAULT 'INV-PS'` — the PERFORMANCE invoice number prefix, an independent sequence from TAX.
- `tenants.credit_note_prefix` (Task 4.3) — `VARCHAR(20) NOT NULL DEFAULT 'CN'`, auto-derived at signup as `invoice_prefix + '-CN'` (or plain `'CN'` if `invoice_prefix` is the default `'INV'`).

## Enums

| Enum | Values | Defined in |
| --- | --- | --- |
| `invoice_type_enum` | `TAX`, `PERFORMANCE` | `invoice-foundation` migration |
| `invoice_status_enum` | `DRAFT`, `ISSUED`, `PAID`, `CANCELLED` | `invoice-foundation` migration |
| `payment_mode_enum` | `CASH`, `UPI`, `NEFT`, `RTGS`, `IMPS`, `CHEQUE`, `CARD`, `BANK_TRANSFER` | `payments` migration |
| `payment_status_enum` | `RECORDED`, `CANCELLED` | `payments` migration |

## Relationships

- `invoices.customer_id → customers.id`, `ON DELETE RESTRICT`.
- `invoice_lines.invoice_id → invoices.id`, `ON DELETE CASCADE` — deleting a DRAFT invoice takes its lines with it.
- `invoice_lines.trip_sheet_id → trip_sheets.id`, `ON DELETE RESTRICT`.
- `credit_notes.original_invoice_id → invoices.id`, `ON DELETE RESTRICT`.
- `invoices.credit_note_id → credit_notes.id` (no FK-level `ON DELETE` action specified; populated only after the credit note already exists, inside the same transaction).
- `payments.invoice_id → invoices.id`, `ON DELETE RESTRICT`; `payments.parent_payment_id → payments.id`, `ON DELETE RESTRICT` (self-referential, for split/partial-application audit).
- `trip_sheets.held_by_invoice_id → invoices.id`, `ON DELETE SET NULL`.

## ER Diagram

See [`diagrams/er-diagram.md`](diagrams/er-diagram.md) for the full mermaid diagram, scoped to Module 4's own tables plus their foreign keys into Modules 1-3.

## Extensions used

No new Postgres extensions. `pgcrypto` (`gen_random_uuid()`) was already enabled in Module 1.
