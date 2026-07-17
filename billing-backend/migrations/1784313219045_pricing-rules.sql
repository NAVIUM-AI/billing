-- Up Migration

-- ─────────────────────────────────────────────────────────────────
-- PROD OPS NOTES
--
-- This migration creates the btree_gist extension. btree_gist is a
-- trusted extension in Postgres 13+ and can be created by any role
-- with CREATE on the database. In production, either:
--   (a) grant CREATE on the database to billing_app temporarily
--       during deploy, or
--   (b) run `CREATE EXTENSION btree_gist;` as superuser once, then
--       let this migration succeed via `CREATE EXTENSION IF NOT
--       EXISTS`.
-- Option (b) is safer for prod.
-- ─────────────────────────────────────────────────────────────────

-- Discriminator for pricing rule shape.
CREATE TYPE pricing_rule_type_enum AS ENUM (
  'LOCAL_PACKAGE',
  'OUTSTATION_SLAB',
  'PERFORMANCE'
);

-- daterange support for EXCLUDE constraint
CREATE EXTENSION IF NOT EXISTS btree_gist;
-- Prod ops note: btree_gist is a "trusted" extension.
-- Local dev grant already covers CREATE EXTENSION;
-- prod DBA runs this once out-of-band before deploy.

CREATE TABLE pricing_rules (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  rule_type             pricing_rule_type_enum NOT NULL,
  vehicle_type          vehicle_type_enum NOT NULL,

  -- Human-readable label ("SEDAN Local 8H/80K — Base ₹2200").
  -- Purely for admin UI clarity; not used in calc.
  label                 VARCHAR(255) NOT NULL,

  -- ─── LOCAL_PACKAGE fields ───────────────────────
  -- All stored in PAISE (integer). ₹2200.00 = 220000 paise.
  base_hours            SMALLINT,           -- e.g. 8
  base_km               INTEGER,            -- e.g. 80
  base_price_paise      INTEGER,            -- e.g. 220000 (= ₹2200.00)
  extra_km_rate_paise   INTEGER,            -- e.g. 1400  (= ₹14.00 per km)
  extra_hr_rate_paise   INTEGER,            -- e.g. 18000 (= ₹180.00 per hour)

  -- ─── OUTSTATION_SLAB fields ─────────────────────
  slab_rate_paise       INTEGER,            -- e.g. 5000 = ₹50.00 per km
  min_km_per_day        INTEGER,            -- e.g. 300 km/day minimum
  driver_batta_per_day_paise INTEGER,       -- e.g. 60000 = ₹600/day

  -- ─── PERFORMANCE fields ─────────────────────────
  per_km_rate_paise     INTEGER,            -- e.g. 1400 = ₹14.00
  performance_batta_paise INTEGER,          -- e.g. 30000 = ₹300 flat

  -- ─── Versioning ─────────────────────────────────
  -- Half-open date range: [effective_from, effective_to)
  -- effective_to = NULL means "still active".
  effective_from        DATE NOT NULL,
  effective_to          DATE,               -- exclusive; NULL = open-ended

  -- Non-column expression for EXCLUDE constraint
  -- constructed via GENERATED column so we can index it.
  effective_range       DATERANGE GENERATED ALWAYS AS (
    daterange(
      effective_from,
      effective_to,
      '[)'
    )
  ) STORED,

  -- Metadata
  notes                 TEXT,
  created_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ─── CHECK constraints per rule type ────────────
  CONSTRAINT pricing_local_required_fields CHECK (
    rule_type <> 'LOCAL_PACKAGE'
    OR (
      base_hours          IS NOT NULL AND base_hours          > 0
      AND base_km         IS NOT NULL AND base_km             > 0
      AND base_price_paise IS NOT NULL AND base_price_paise   >= 0
      AND extra_km_rate_paise IS NOT NULL AND extra_km_rate_paise >= 0
      AND extra_hr_rate_paise IS NOT NULL AND extra_hr_rate_paise >= 0
    )
  ),
  CONSTRAINT pricing_outstation_required_fields CHECK (
    rule_type <> 'OUTSTATION_SLAB'
    OR (
      slab_rate_paise           IS NOT NULL AND slab_rate_paise           > 0
      AND min_km_per_day        IS NOT NULL AND min_km_per_day            >= 0
      AND driver_batta_per_day_paise IS NOT NULL
          AND driver_batta_per_day_paise >= 0
    )
  ),
  CONSTRAINT pricing_performance_required_fields CHECK (
    rule_type <> 'PERFORMANCE'
    OR (
      per_km_rate_paise       IS NOT NULL AND per_km_rate_paise > 0
      AND performance_batta_paise IS NOT NULL
          AND performance_batta_paise >= 0
    )
  ),
  CONSTRAINT pricing_effective_range CHECK (
    effective_to IS NULL OR effective_to > effective_from
  )
);

-- ─── Non-overlap constraint per (tenant, rule_type, vehicle_type) ───
-- At any given date, at most ONE active rule per
-- (tenant, rule_type, vehicle_type). This is what
-- makes rule lookup unambiguous.
ALTER TABLE pricing_rules
  ADD CONSTRAINT pricing_rules_no_overlap
  EXCLUDE USING gist (
    tenant_id       WITH =,
    rule_type       WITH =,
    vehicle_type    WITH =,
    effective_range WITH &&
  );

-- ─── Query indexes ────────────────────────────────
-- Rule lookup: "give me the SEDAN LOCAL_PACKAGE rule
-- effective on 2026-07-15".
CREATE INDEX idx_pricing_lookup
  ON pricing_rules(
    tenant_id, rule_type, vehicle_type, effective_from
  );

-- List all active rules (admin UI).
CREATE INDEX idx_pricing_current
  ON pricing_rules(tenant_id, effective_from DESC)
  WHERE effective_to IS NULL;

-- ─── Trigger + RLS ────────────────────────────────
CREATE TRIGGER trg_pricing_rules_updated_at
  BEFORE UPDATE ON pricing_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE pricing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_rules FORCE ROW LEVEL SECURITY;

CREATE POLICY pricing_rules_tenant_isolation
  ON pricing_rules
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

COMMENT ON POLICY pricing_rules_tenant_isolation
  ON pricing_rules IS
  'Tenant isolation via app.current_tenant_id session var.';

-- Down Migration

DROP TABLE IF EXISTS pricing_rules;
DROP TYPE  IF EXISTS pricing_rule_type_enum;
