-- Up Migration

-- ─── Enums ────────────────────────────────
CREATE TYPE trip_service_type_enum AS ENUM (
  'LOCAL',
  'OUTSTATION'
);

CREATE TYPE trip_billing_mode_enum AS ENUM (
  'GST',
  'PERFORMANCE'
);

CREATE TYPE trip_status_enum AS ENUM (
  'DRAFT',
  'FINALIZED',
  'INVOICED',
  'CANCELLED'
);

-- ─── Table ────────────────────────────────
CREATE TABLE trip_sheets (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Business identity
  trip_sheet_number       VARCHAR(30) NOT NULL,
  -- Format: {prefix}-{seq}/{FY} e.g. TS-1586/26-27
  -- Prefix comes from tenants.trip_sheet_prefix (see the
  -- tenant_trip_sheet_prefix migration).

  -- Two independent axes (both required at create)
  service_type            trip_service_type_enum NOT NULL,
  billing_mode            trip_billing_mode_enum NOT NULL,

  status                  trip_status_enum NOT NULL DEFAULT 'DRAFT',

  -- Party references
  customer_id             UUID NOT NULL REFERENCES customers(id)
                          ON DELETE RESTRICT,
  vehicle_id              UUID NOT NULL REFERENCES vehicles(id)
                          ON DELETE RESTRICT,
  driver_id               UUID REFERENCES drivers(id)
                          ON DELETE SET NULL,

  -- Pricing linkage
  pricing_rule_id         UUID REFERENCES pricing_rules(id)
                          ON DELETE SET NULL,
  -- Nullable because:
  --   (a) a superseded rule may still be referenced;
  --       if ever hard-deleted, the snapshot below
  --       preserves truth.
  --   (b) future "custom rate" trips (out of scope
  --       for this task) will bypass rule lookup.

  -- ─── Snapshot fields (immutable audit trail) ───
  -- All rate-relevant fields from the rule and the
  -- vehicle are frozen onto the trip at creation.
  -- If the rule or vehicle changes tomorrow, this
  -- trip's numbers do not change.
  snapshot_vehicle_number VARCHAR(20) NOT NULL,
  snapshot_vehicle_type   vehicle_type_enum NOT NULL,
  snapshot_customer_name  VARCHAR(255) NOT NULL,
  snapshot_customer_gstin VARCHAR(15),

  -- Rule snapshot (all in paise; nullable per
  -- billing_mode / service_type combinations).
  snap_base_hours              SMALLINT,
  snap_base_km                 INTEGER,
  snap_base_price_paise        INTEGER,
  snap_extra_km_rate_paise     INTEGER,
  snap_extra_hr_rate_paise     INTEGER,
  snap_slab_rate_paise         INTEGER,
  snap_min_km_per_day          INTEGER,
  snap_driver_batta_per_day_paise INTEGER,
  snap_per_km_rate_paise       INTEGER,
  snap_performance_batta_paise INTEGER,

  -- ─── Trip usage inputs ────────────────
  trip_date               DATE NOT NULL,
  start_datetime          TIMESTAMPTZ,
  end_datetime            TIMESTAMPTZ,
  opening_km              INTEGER,
  closing_km              INTEGER,
  total_km                INTEGER NOT NULL CHECK (total_km >= 0),
  total_hours             INTEGER NOT NULL CHECK (total_hours >= 0),
  total_days              SMALLINT NOT NULL DEFAULT 1
                          CHECK (total_days >= 1),

  -- ─── Additional charges (all in paise) ────
  toll_paise              INTEGER NOT NULL DEFAULT 0
                          CHECK (toll_paise >= 0),
  parking_paise           INTEGER NOT NULL DEFAULT 0
                          CHECK (parking_paise >= 0),
  permit_paise            INTEGER NOT NULL DEFAULT 0
                          CHECK (permit_paise >= 0),
  fasttag_paise           INTEGER NOT NULL DEFAULT 0
                          CHECK (fasttag_paise >= 0),
  advance_paise            INTEGER NOT NULL DEFAULT 0
                          CHECK (advance_paise >= 0),

  -- ─── Computed totals (denormalized, immutable) ──
  -- These are the calculator's output at creation
  -- time. Never recomputed on read. Never mutated.
  base_amount_paise       INTEGER NOT NULL DEFAULT 0,
  extras_amount_paise     INTEGER NOT NULL DEFAULT 0,
  driver_batta_paise      INTEGER NOT NULL DEFAULT 0,
  subtotal_paise          INTEGER NOT NULL,
  -- For LOCAL: subtotal = base + extras + toll
  -- For OUTSTATION: subtotal = slab + batta + toll +
  --                             parking + permit +
  --                             fasttag
  -- For PERFORMANCE: subtotal = km + batta + toll
  gross_paise              INTEGER NOT NULL,
  -- For OUTSTATION: gross = subtotal (advance handled
  -- at invoice, not trip). LOCAL and PERFORMANCE:
  -- gross = subtotal.
  net_payable_paise        INTEGER NOT NULL,
  -- For LOCAL/PERFORMANCE: net = gross.
  -- For OUTSTATION: net = gross - advance.

  -- The full calculator breakdown, stored for audit
  -- and PDF regeneration. Frozen at creation time.
  breakdown               JSONB NOT NULL,

  -- ─── Additional metadata ──────────────
  booked_by               VARCHAR(255),        -- from PDF: "Bkd by"
  pax_note                VARCHAR(255),        -- from PDF: "PAX : ..."
  remarks                 TEXT,

  -- Audit
  created_by              UUID REFERENCES users(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at            TIMESTAMPTZ,
  finalized_by            UUID REFERENCES users(id),
  invoiced_at              TIMESTAMPTZ,
  invoice_id               UUID,
  cancelled_at             TIMESTAMPTZ,
  cancelled_by             UUID REFERENCES users(id),
  cancellation_reason      TEXT,

  -- ─── Uniqueness ──────────────────────
  CONSTRAINT trip_sheets_number_per_tenant_unique
    UNIQUE (tenant_id, trip_sheet_number),

  -- ─── Sanity constraints ─────────────
  CONSTRAINT trip_sheets_km_range CHECK (
    opening_km IS NULL
    OR closing_km IS NULL
    OR closing_km >= opening_km
  ),
  CONSTRAINT trip_sheets_datetime_range CHECK (
    start_datetime IS NULL
    OR end_datetime IS NULL
    OR end_datetime >= start_datetime
  )
);

-- ─── FY sequence table ────────────────
-- Concurrency-safe per-tenant, per-FY counter for
-- trip sheet numbers. UNIQUE constraint gates the
-- insert; UPDATE ... RETURNING inside a transaction
-- gives us an atomic increment.
CREATE TABLE trip_sheet_sequences (
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fiscal_year    VARCHAR(5) NOT NULL,           -- '26-27'
  next_seq       INTEGER NOT NULL DEFAULT 1,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, fiscal_year)
);

-- ─── Indexes ──────────────────────────
CREATE INDEX idx_trips_tenant_date
  ON trip_sheets(tenant_id, trip_date DESC);

CREATE INDEX idx_trips_tenant_customer
  ON trip_sheets(tenant_id, customer_id, trip_date DESC);

CREATE INDEX idx_trips_tenant_status
  ON trip_sheets(tenant_id, status)
  WHERE status IN ('DRAFT','FINALIZED');

CREATE INDEX idx_trips_tenant_vehicle
  ON trip_sheets(tenant_id, vehicle_id, trip_date DESC);

-- ─── Triggers + RLS ───────────────────
CREATE TRIGGER trg_trip_sheets_updated_at
  BEFORE UPDATE ON trip_sheets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE trip_sheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_sheets FORCE ROW LEVEL SECURITY;

CREATE POLICY trip_sheets_tenant_isolation
  ON trip_sheets
  USING (
    tenant_id = current_setting(
      'app.current_tenant_id', true
    )::uuid
  )
  WITH CHECK (
    tenant_id = current_setting(
      'app.current_tenant_id', true
    )::uuid
  );

-- Sequence table doesn't need RLS (indexed by
-- tenant_id, all writes go through withTenantContext
-- transaction). Enable it defensively anyway:
ALTER TABLE trip_sheet_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_sheet_sequences FORCE ROW LEVEL SECURITY;

CREATE POLICY trip_sheet_sequences_tenant_isolation
  ON trip_sheet_sequences
  USING (
    tenant_id = current_setting(
      'app.current_tenant_id', true
    )::uuid
  )
  WITH CHECK (
    tenant_id = current_setting(
      'app.current_tenant_id', true
    )::uuid
  );

COMMENT ON POLICY trip_sheets_tenant_isolation
  ON trip_sheets IS
  'Tenant isolation via app.current_tenant_id session var.';

-- Down Migration

DROP TABLE IF EXISTS trip_sheet_sequences;
DROP TABLE IF EXISTS trip_sheets;
DROP TYPE  IF EXISTS trip_status_enum;
DROP TYPE  IF EXISTS trip_billing_mode_enum;
DROP TYPE  IF EXISTS trip_service_type_enum;
