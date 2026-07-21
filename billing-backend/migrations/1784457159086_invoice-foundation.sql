-- Up Migration

-- ─── Enums ───────────────────────────────
CREATE TYPE invoice_type_enum AS ENUM (
  'TAX',           -- Legal GST Tax Invoice
  'PERFORMANCE'    -- Internal cost sheet
);

CREATE TYPE invoice_status_enum AS ENUM (
  'DRAFT',
  'ISSUED',
  'PAID',
  'CANCELLED'
);

-- ─── Extend tenants ──────────────────────
ALTER TABLE tenants
  ADD COLUMN gst_rate SMALLINT NOT NULL DEFAULT 5
    CHECK (gst_rate BETWEEN 0 AND 28);
-- 5 = default (no ITC); 12 = with ITC.
-- Actual valid GST rates on services: 0, 5, 12,
-- 18, 28. Enforce sanity.

-- invoice_prefix already exists (added nullable, DEFAULT 'INV', by the
-- Task 1.1 init migration as a forward-looking placeholder — same
-- pattern as accessMatrix.js's pre-stubbed invoices:* permission keys).
-- Backfill any legacy NULLs, then tighten to NOT NULL now that Task 4.1
-- actually depends on it always being present.
UPDATE tenants SET invoice_prefix = 'INV' WHERE invoice_prefix IS NULL;
ALTER TABLE tenants ALTER COLUMN invoice_prefix SET NOT NULL;
-- Auto-derived from name.slice(0,3).upper() during
-- tenant creation. Editable in settings until first
-- issued invoice.

ALTER TABLE tenants
  ADD COLUMN performance_prefix VARCHAR(30) NOT NULL DEFAULT 'INV-PS';

-- ─── invoices table ──────────────────────
CREATE TABLE invoices (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Identity — invoice_number is NULL until issued.
  -- DRAFT invoices don't have a number to prevent
  -- gaps in the legal per-FY sequence.
  invoice_number        VARCHAR(30),

  invoice_type          invoice_type_enum NOT NULL,
  status                invoice_status_enum NOT NULL DEFAULT 'DRAFT',

  customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,

  -- User-provided fields (editable in DRAFT)
  invoice_date          DATE NOT NULL,
  due_date              DATE NOT NULL,
  -- due_date derives from invoice_date + customer.credit_days
  -- at creation; user can override in PATCH.

  notes                 TEXT,
  terms                 TEXT,
  -- Terms text (payment terms, cancellation policy, etc.).
  -- Nullable; comes from tenant settings if not overridden.

  -- Financial state — recomputed on every trip-set change
  -- during DRAFT. Locked at issue.
  subtotal_paise        BIGINT NOT NULL DEFAULT 0
    CHECK (subtotal_paise >= 0),
  -- Sum of all invoice_lines.line_amount_paise
  -- (base + extras + batta, per trip). This is
  -- the taxable amount.

  gst_rate_snapshot     SMALLINT,
  -- Copied from tenant.gst_rate at creation, editable
  -- during draft. Null for PERFORMANCE type.

  -- GST breakdown (computed from subtotal_paise +
  -- gst_rate_snapshot + intra-state check)
  cgst_paise            BIGINT NOT NULL DEFAULT 0
    CHECK (cgst_paise >= 0),
  sgst_paise            BIGINT NOT NULL DEFAULT 0
    CHECK (sgst_paise >= 0),
  igst_paise            BIGINT NOT NULL DEFAULT 0
    CHECK (igst_paise >= 0),
  total_gst_paise       BIGINT NOT NULL DEFAULT 0
    CHECK (total_gst_paise >= 0),

  -- Toll / reimbursements section (POST-GST,
  -- non-taxable per Indian GST rules for pure-agent
  -- reimbursements).
  toll_paise            BIGINT NOT NULL DEFAULT 0
    CHECK (toll_paise >= 0),
  parking_paise         BIGINT NOT NULL DEFAULT 0
    CHECK (parking_paise >= 0),
  permit_paise          BIGINT NOT NULL DEFAULT 0
    CHECK (permit_paise >= 0),
  fasttag_paise         BIGINT NOT NULL DEFAULT 0
    CHECK (fasttag_paise >= 0),

  -- Discount reduces taxable amount (applied BEFORE
  -- GST). Discount reason for audit.
  discount_paise        BIGINT NOT NULL DEFAULT 0
    CHECK (discount_paise >= 0),
  discount_reason       VARCHAR(255),

  -- Round-off: signed. Positive = added, negative =
  -- subtracted. Applied to grand total to reach whole
  -- rupee net_payable.
  round_off_paise       INTEGER NOT NULL DEFAULT 0
    CHECK (round_off_paise BETWEEN -99 AND 99),

  -- Grand total (before round-off)
  grand_total_paise     BIGINT NOT NULL DEFAULT 0
    CHECK (grand_total_paise >= 0),
  -- = subtotal - discount + gst + toll + parking + permit + fasttag

  -- Net payable (after round-off, whole rupees)
  net_payable_paise     BIGINT NOT NULL DEFAULT 0
    CHECK (net_payable_paise >= 0),

  -- Amount in words (computed and stored on issue)
  amount_in_words       VARCHAR(500),

  -- Immutability snapshot fields (populated at
  -- ISSUE — Task 4.3). Nullable in DRAFT.
  tenant_snapshot       JSONB,
  -- { name, gstin, pan, state_code, address,
  --   bank_details, contact }
  customer_snapshot     JSONB,
  -- { customer_type, name, company_name, gstin,
  --   pan, state_code, address, phone, email }

  -- PDF metadata (populated by Task 4.5)
  pdf_url               VARCHAR(500),
  pdf_generated_at      TIMESTAMPTZ,
  pdf_template_version  VARCHAR(20),

  -- Audit fields
  created_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issued_at             TIMESTAMPTZ,
  issued_by             UUID REFERENCES users(id),
  cancelled_at          TIMESTAMPTZ,
  cancelled_by          UUID REFERENCES users(id),
  cancellation_reason   TEXT,
  credit_note_id        UUID,
  -- Populated when cancelled — references the credit
  -- note issued as reversal. Task 4.3 wires this up.

  -- Constraints
  CONSTRAINT invoices_number_per_tenant_unique
    UNIQUE (tenant_id, invoice_number),
    -- Only enforced when invoice_number is not null.
    -- Postgres treats NULLs as distinct, so multiple
    -- DRAFTs can coexist with null numbers.
  CONSTRAINT invoices_due_after_issue CHECK (
    due_date >= invoice_date
  ),
  CONSTRAINT invoices_perf_no_gst CHECK (
    invoice_type <> 'PERFORMANCE'
    OR (cgst_paise = 0 AND sgst_paise = 0
        AND igst_paise = 0 AND total_gst_paise = 0)
  )
  -- Performance invoices carry ZERO GST amounts.
  -- Enforced at DB level as safety net.
);

-- ─── invoice_lines table ─────────────────
CREATE TABLE invoice_lines (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id            UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  tenant_id             UUID NOT NULL,
  -- Denormalized for RLS
  trip_sheet_id         UUID NOT NULL REFERENCES trip_sheets(id) ON DELETE RESTRICT,

  line_number           SMALLINT NOT NULL,
  -- 1-indexed order in the invoice PDF

  -- Snapshot from trip_sheet at line creation
  service_type          trip_service_type_enum NOT NULL,
  trip_date             DATE NOT NULL,
  vehicle_number        VARCHAR(20) NOT NULL,
  vehicle_type          vehicle_type_enum NOT NULL,
  total_km              INTEGER NOT NULL,
  total_hours           INTEGER,
  total_days            SMALLINT,

  -- Financial breakdown per line (from trip snapshot)
  base_amount_paise     BIGINT NOT NULL DEFAULT 0,
  extras_amount_paise   BIGINT NOT NULL DEFAULT 0,
  driver_batta_paise    BIGINT NOT NULL DEFAULT 0,
  line_amount_paise     BIGINT NOT NULL DEFAULT 0,
  -- = base + extras + batta
  -- This is what feeds subtotal_paise on the invoice.

  -- Tax classification for GST reporting
  hsn_sac_code          VARCHAR(10) NOT NULL DEFAULT '996601',
  -- 996601 = "Renting of vehicles" — Indian GST HSN

  -- Line description (auto-generated, editable in DRAFT)
  description           VARCHAR(500),
  -- e.g., "SEDAN KA51AK1031 - 217 km local trip on 01-Jun-2026"

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT invoice_lines_line_per_invoice_unique
    UNIQUE (invoice_id, line_number),
  CONSTRAINT invoice_lines_trip_per_invoice_unique
    UNIQUE (invoice_id, trip_sheet_id)
  -- Same trip can't appear twice on same invoice.
);

-- ─── Trip hold mechanism ─────────────────
ALTER TABLE trip_sheets
  ADD COLUMN held_by_invoice_id UUID
    REFERENCES invoices(id) ON DELETE SET NULL;
-- When a trip is added to a DRAFT invoice, this
-- points to that invoice. Cleared when the invoice
-- is deleted or when the invoice is issued (at issue,
-- status transitions to INVOICED instead).

CREATE INDEX idx_trips_held_by_invoice
  ON trip_sheets(held_by_invoice_id)
  WHERE held_by_invoice_id IS NOT NULL;

-- ─── Invoice number sequences ────────────
-- Separate table so we can track TAX and PERFORMANCE
-- sequences independently.
CREATE TABLE invoice_number_sequences (
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_type   invoice_type_enum NOT NULL,
  fiscal_year    VARCHAR(5) NOT NULL,
  next_seq       INTEGER NOT NULL DEFAULT 1,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, invoice_type, fiscal_year)
);

-- ─── Indexes ─────────────────────────────
CREATE INDEX idx_invoices_tenant_status
  ON invoices(tenant_id, status)
  WHERE status IN ('DRAFT','ISSUED');
CREATE INDEX idx_invoices_tenant_customer
  ON invoices(tenant_id, customer_id, invoice_date DESC);
CREATE INDEX idx_invoices_tenant_type_date
  ON invoices(tenant_id, invoice_type, invoice_date DESC);
CREATE INDEX idx_invoice_lines_invoice
  ON invoice_lines(invoice_id, line_number);

-- ─── Triggers + RLS ──────────────────────
CREATE TRIGGER trg_invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY invoices_tenant_isolation
  ON invoices
  USING (tenant_id = current_setting(
    'app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting(
    'app.current_tenant_id', true)::uuid);

ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_lines_tenant_isolation
  ON invoice_lines
  USING (tenant_id = current_setting(
    'app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting(
    'app.current_tenant_id', true)::uuid);

ALTER TABLE invoice_number_sequences
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_number_sequences
  FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_seq_tenant_isolation
  ON invoice_number_sequences
  USING (tenant_id = current_setting(
    'app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting(
    'app.current_tenant_id', true)::uuid);

-- Down Migration

ALTER TABLE trip_sheets DROP COLUMN held_by_invoice_id;
DROP TABLE IF EXISTS invoice_lines;
DROP TABLE IF EXISTS invoice_number_sequences;
DROP TABLE IF EXISTS invoices;
ALTER TABLE tenants DROP COLUMN performance_prefix;
-- invoice_prefix predates this migration (Task 1.1) — only relax the
-- NOT NULL this migration added, don't drop the column itself.
ALTER TABLE tenants ALTER COLUMN invoice_prefix DROP NOT NULL;
ALTER TABLE tenants DROP COLUMN gst_rate;
DROP TYPE  IF EXISTS invoice_status_enum;
DROP TYPE  IF EXISTS invoice_type_enum;
