-- Up Migration

-- MODULE 5 / Task B1: trip sheets restructure from "one vehicle per
-- sheet" to a parent/child model. trip_sheets stays the SHEET (identity,
-- customer, date, numbering, lifecycle/status — Rule 12: status is
-- SHEET-level, not touched here at all). trip_sheet_vehicles is the new
-- child, 1..10 rows per sheet, each fully self-contained (own vehicle,
-- rates, usage, toll, computed total) — exactly the per-vehicle column
-- set identified in the Task B1 pre-flight read (Part A of this task's
-- own spec), copied here VERBATIM from the actual trip_sheets column
-- definitions (Rule 14 — not retyped from memory): vehicle_id, driver_id,
-- pricing_rule_id, pricing_source, snapshot_vehicle_number,
-- snapshot_vehicle_type, all 10 snap_* rate-snapshot columns,
-- start_datetime, end_datetime, opening_km, closing_km, total_km,
-- total_hours, total_days, toll_paise, parking_paise, permit_paise,
-- fasttag_paise, advance_paise, base_amount_paise, extras_amount_paise,
-- driver_batta_paise, subtotal_paise, gross_paise, net_payable_paise,
-- breakdown. (The task's own Context section labels this list "(26)" —
-- that count is stale; the enumerated list itself is authoritative per
-- Rule 10 and actually has 35 entries once start_datetime/end_datetime/
-- total_days are included, as the list itself does.)
--
-- tenant_id is DENORMALIZED onto the child (not just inherited via the
-- trip_sheet_id FK) — same "RLS needs its own tenant_id column on every
-- table it protects" convention as invoice_lines (see the
-- invoice-foundation migration: invoice_lines.tenant_id is a plain
-- UUID NOT NULL with no FK to tenants, RLS-policy-only, identical shape
-- to what's used here).
CREATE TABLE trip_sheet_vehicles (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  trip_sheet_id           UUID NOT NULL REFERENCES trip_sheets(id) ON DELETE CASCADE,
  line_number             SMALLINT NOT NULL,

  -- ─── Vehicle / pricing linkage (per-vehicle) ───
  vehicle_id              UUID REFERENCES vehicles(id) ON DELETE RESTRICT,
  driver_id               UUID REFERENCES drivers(id) ON DELETE SET NULL,
  pricing_rule_id         UUID REFERENCES pricing_rules(id) ON DELETE SET NULL,
  pricing_source          TEXT NOT NULL DEFAULT 'FLEET'
                          CONSTRAINT trip_sheet_vehicles_pricing_source_check
                          CHECK (pricing_source IN ('FLEET', 'MANUAL')),

  -- ─── Snapshot fields (immutable audit trail, per-vehicle) ───
  snapshot_vehicle_number VARCHAR(20) NOT NULL,
  snapshot_vehicle_type   vehicle_type_enum NOT NULL,

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

  -- ─── Usage inputs (per-vehicle) ────────────
  start_datetime          TIMESTAMPTZ,
  end_datetime            TIMESTAMPTZ,
  opening_km              INTEGER,
  closing_km              INTEGER,
  total_km                INTEGER NOT NULL CHECK (total_km >= 0),
  total_hours             INTEGER NOT NULL CHECK (total_hours >= 0),
  total_days               SMALLINT NOT NULL DEFAULT 1 CHECK (total_days >= 1),

  -- ─── Additional charges (all in paise, per-vehicle) ────
  toll_paise               INTEGER NOT NULL DEFAULT 0 CHECK (toll_paise >= 0),
  parking_paise             INTEGER NOT NULL DEFAULT 0 CHECK (parking_paise >= 0),
  permit_paise              INTEGER NOT NULL DEFAULT 0 CHECK (permit_paise >= 0),
  fasttag_paise             INTEGER NOT NULL DEFAULT 0 CHECK (fasttag_paise >= 0),
  advance_paise             INTEGER NOT NULL DEFAULT 0 CHECK (advance_paise >= 0),

  -- ─── Computed totals (denormalized, immutable, per-vehicle) ──
  base_amount_paise        INTEGER NOT NULL DEFAULT 0,
  extras_amount_paise      INTEGER NOT NULL DEFAULT 0,
  driver_batta_paise       INTEGER NOT NULL DEFAULT 0,
  subtotal_paise           INTEGER NOT NULL,
  gross_paise               INTEGER NOT NULL,
  net_payable_paise         INTEGER NOT NULL,
  breakdown                 JSONB NOT NULL,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT trip_sheet_vehicles_line_per_sheet_unique
    UNIQUE (trip_sheet_id, line_number),

  CONSTRAINT trip_sheet_vehicles_km_range CHECK (
    opening_km IS NULL OR closing_km IS NULL OR closing_km >= opening_km
  ),
  CONSTRAINT trip_sheet_vehicles_datetime_range CHECK (
    start_datetime IS NULL OR end_datetime IS NULL OR end_datetime >= start_datetime
  )
);

CREATE INDEX idx_trip_sheet_vehicles_sheet
  ON trip_sheet_vehicles(trip_sheet_id, line_number);

CREATE INDEX idx_trip_sheet_vehicles_tenant_vehicle
  ON trip_sheet_vehicles(tenant_id, vehicle_id, trip_sheet_id)
  WHERE vehicle_id IS NOT NULL;

ALTER TABLE trip_sheet_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_sheet_vehicles FORCE ROW LEVEL SECURITY;

CREATE POLICY trip_sheet_vehicles_tenant_isolation
  ON trip_sheet_vehicles
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ─── Backfill: every existing trip_sheets row becomes one
-- trip_sheet_vehicles row at line_number=1, copying the 35 columns
-- across verbatim. Guarded by NOT EXISTS so re-running this migration
-- (e.g. a retried deploy) never double-inserts.
INSERT INTO trip_sheet_vehicles (
  tenant_id, trip_sheet_id, line_number,
  vehicle_id, driver_id, pricing_rule_id, pricing_source,
  snapshot_vehicle_number, snapshot_vehicle_type,
  snap_base_hours, snap_base_km, snap_base_price_paise,
  snap_extra_km_rate_paise, snap_extra_hr_rate_paise,
  snap_slab_rate_paise, snap_min_km_per_day,
  snap_driver_batta_per_day_paise, snap_per_km_rate_paise,
  snap_performance_batta_paise,
  start_datetime, end_datetime, opening_km, closing_km,
  total_km, total_hours, total_days,
  toll_paise, parking_paise, permit_paise, fasttag_paise, advance_paise,
  base_amount_paise, extras_amount_paise, driver_batta_paise,
  subtotal_paise, gross_paise, net_payable_paise, breakdown
)
SELECT
  ts.tenant_id, ts.id, 1,
  ts.vehicle_id, ts.driver_id, ts.pricing_rule_id, ts.pricing_source,
  ts.snapshot_vehicle_number, ts.snapshot_vehicle_type,
  ts.snap_base_hours, ts.snap_base_km, ts.snap_base_price_paise,
  ts.snap_extra_km_rate_paise, ts.snap_extra_hr_rate_paise,
  ts.snap_slab_rate_paise, ts.snap_min_km_per_day,
  ts.snap_driver_batta_per_day_paise, ts.snap_per_km_rate_paise,
  ts.snap_performance_batta_paise,
  ts.start_datetime, ts.end_datetime, ts.opening_km, ts.closing_km,
  ts.total_km, ts.total_hours, ts.total_days,
  ts.toll_paise, ts.parking_paise, ts.permit_paise, ts.fasttag_paise, ts.advance_paise,
  ts.base_amount_paise, ts.extras_amount_paise, ts.driver_batta_paise,
  ts.subtotal_paise, ts.gross_paise, ts.net_payable_paise, ts.breakdown
FROM trip_sheets ts
WHERE NOT EXISTS (
  SELECT 1 FROM trip_sheet_vehicles tsv WHERE tsv.trip_sheet_id = ts.id
);

-- ─── trip_sheets: sheet-level aggregate columns ───
-- vehicle_count: the flag the GST wizard uses (Part G) to exclude
-- multi-vehicle trips from invoiceable-trips. DEFAULT 1 backfills every
-- existing row correctly (each has exactly the one vehicle just copied
-- above) — Postgres applies a column DEFAULT to existing rows on
-- ADD COLUMN, no separate UPDATE needed.
ALTER TABLE trip_sheets
  ADD COLUMN vehicle_count INTEGER NOT NULL DEFAULT 1 CHECK (vehicle_count BETWEEN 1 AND 10);

-- total_net_payable_paise: sum of children's net_payable_paise, kept on
-- the sheet so list/aggregate queries don't need to join+SUM on every
-- read. Added nullable first so the UPDATE below can populate it from
-- the (still-present) net_payable_paise column, then tightened to
-- NOT NULL.
ALTER TABLE trip_sheets
  ADD COLUMN total_net_payable_paise BIGINT;

UPDATE trip_sheets SET total_net_payable_paise = net_payable_paise;

ALTER TABLE trip_sheets
  ALTER COLUMN total_net_payable_paise SET NOT NULL;
ALTER TABLE trip_sheets
  ADD CONSTRAINT trip_sheets_total_net_payable_check CHECK (total_net_payable_paise >= 0);

-- ─── trip_sheets: drop the old per-vehicle indexes/columns ───
-- Old vehicle-scoped index no longer applies once vehicle_id leaves
-- trip_sheets — idx_trip_sheet_vehicles_tenant_vehicle (above) is its
-- replacement, on the child table.
DROP INDEX IF EXISTS idx_trips_tenant_vehicle;

-- Backfill (child table + total_net_payable_paise) is complete above,
-- so it's now safe to drop the 35 per-vehicle columns from trip_sheets.
-- DROP COLUMN automatically drops any CHECK constraint that references
-- only that column (trip_sheets_km_range, trip_sheets_datetime_range go
-- with opening_km/closing_km/start_datetime/end_datetime here).
ALTER TABLE trip_sheets
  DROP COLUMN vehicle_id,
  DROP COLUMN driver_id,
  DROP COLUMN pricing_rule_id,
  DROP COLUMN pricing_source,
  DROP COLUMN snapshot_vehicle_number,
  DROP COLUMN snapshot_vehicle_type,
  DROP COLUMN snap_base_hours,
  DROP COLUMN snap_base_km,
  DROP COLUMN snap_base_price_paise,
  DROP COLUMN snap_extra_km_rate_paise,
  DROP COLUMN snap_extra_hr_rate_paise,
  DROP COLUMN snap_slab_rate_paise,
  DROP COLUMN snap_min_km_per_day,
  DROP COLUMN snap_driver_batta_per_day_paise,
  DROP COLUMN snap_per_km_rate_paise,
  DROP COLUMN snap_performance_batta_paise,
  DROP COLUMN start_datetime,
  DROP COLUMN end_datetime,
  DROP COLUMN opening_km,
  DROP COLUMN closing_km,
  DROP COLUMN total_km,
  DROP COLUMN total_hours,
  DROP COLUMN total_days,
  DROP COLUMN toll_paise,
  DROP COLUMN parking_paise,
  DROP COLUMN permit_paise,
  DROP COLUMN fasttag_paise,
  DROP COLUMN advance_paise,
  DROP COLUMN base_amount_paise,
  DROP COLUMN extras_amount_paise,
  DROP COLUMN driver_batta_paise,
  DROP COLUMN subtotal_paise,
  DROP COLUMN gross_paise,
  DROP COLUMN net_payable_paise,
  DROP COLUMN breakdown;

COMMENT ON POLICY trip_sheet_vehicles_tenant_isolation
  ON trip_sheet_vehicles IS
  'Tenant isolation via app.current_tenant_id session var.';

-- Down Migration

-- Lossy guard: a clean down (collapsing the child table back into
-- trip_sheets' old scalar columns) is only well-defined for
-- single-vehicle sheets. If any sheet has more than one vehicle, this
-- down migration ABORTS LOUDLY rather than silently discarding data —
-- same "fail loudly, not a silent data-loss downgrade" convention as
-- trip-sheets-manual-mode's and trip-sheets-proforma-pdf's own down
-- migrations.
DO $$
DECLARE
  multi_vehicle_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO multi_vehicle_count
  FROM trip_sheets
  WHERE vehicle_count > 1;

  IF multi_vehicle_count > 0 THEN
    RAISE EXCEPTION
      'Cannot reverse trip-sheet-vehicles migration: % trip_sheets row(s) have more than one vehicle. Down migration would lose data.',
      multi_vehicle_count;
  END IF;
END $$;

ALTER TABLE trip_sheets
  ADD COLUMN vehicle_id              UUID REFERENCES vehicles(id) ON DELETE RESTRICT,
  ADD COLUMN driver_id               UUID REFERENCES drivers(id) ON DELETE SET NULL,
  ADD COLUMN pricing_rule_id         UUID REFERENCES pricing_rules(id) ON DELETE SET NULL,
  ADD COLUMN pricing_source          TEXT NOT NULL DEFAULT 'FLEET'
                                     CONSTRAINT trip_sheets_pricing_source_check
                                     CHECK (pricing_source IN ('FLEET', 'MANUAL')),
  ADD COLUMN snapshot_vehicle_number VARCHAR(20),
  ADD COLUMN snapshot_vehicle_type   vehicle_type_enum,
  ADD COLUMN snap_base_hours              SMALLINT,
  ADD COLUMN snap_base_km                 INTEGER,
  ADD COLUMN snap_base_price_paise        INTEGER,
  ADD COLUMN snap_extra_km_rate_paise     INTEGER,
  ADD COLUMN snap_extra_hr_rate_paise     INTEGER,
  ADD COLUMN snap_slab_rate_paise         INTEGER,
  ADD COLUMN snap_min_km_per_day          INTEGER,
  ADD COLUMN snap_driver_batta_per_day_paise INTEGER,
  ADD COLUMN snap_per_km_rate_paise       INTEGER,
  ADD COLUMN snap_performance_batta_paise INTEGER,
  ADD COLUMN start_datetime          TIMESTAMPTZ,
  ADD COLUMN end_datetime            TIMESTAMPTZ,
  ADD COLUMN opening_km              INTEGER,
  ADD COLUMN closing_km              INTEGER,
  ADD COLUMN total_km                INTEGER,
  ADD COLUMN total_hours             INTEGER,
  ADD COLUMN total_days              SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN toll_paise              INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN parking_paise           INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN permit_paise            INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN fasttag_paise           INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN advance_paise           INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN base_amount_paise       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN extras_amount_paise     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN driver_batta_paise      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN subtotal_paise          INTEGER,
  ADD COLUMN gross_paise             INTEGER,
  ADD COLUMN net_payable_paise       INTEGER,
  ADD COLUMN breakdown               JSONB;

UPDATE trip_sheets ts
SET
  vehicle_id = tsv.vehicle_id,
  driver_id = tsv.driver_id,
  pricing_rule_id = tsv.pricing_rule_id,
  pricing_source = tsv.pricing_source,
  snapshot_vehicle_number = tsv.snapshot_vehicle_number,
  snapshot_vehicle_type = tsv.snapshot_vehicle_type,
  snap_base_hours = tsv.snap_base_hours,
  snap_base_km = tsv.snap_base_km,
  snap_base_price_paise = tsv.snap_base_price_paise,
  snap_extra_km_rate_paise = tsv.snap_extra_km_rate_paise,
  snap_extra_hr_rate_paise = tsv.snap_extra_hr_rate_paise,
  snap_slab_rate_paise = tsv.snap_slab_rate_paise,
  snap_min_km_per_day = tsv.snap_min_km_per_day,
  snap_driver_batta_per_day_paise = tsv.snap_driver_batta_per_day_paise,
  snap_per_km_rate_paise = tsv.snap_per_km_rate_paise,
  snap_performance_batta_paise = tsv.snap_performance_batta_paise,
  start_datetime = tsv.start_datetime,
  end_datetime = tsv.end_datetime,
  opening_km = tsv.opening_km,
  closing_km = tsv.closing_km,
  total_km = tsv.total_km,
  total_hours = tsv.total_hours,
  total_days = tsv.total_days,
  toll_paise = tsv.toll_paise,
  parking_paise = tsv.parking_paise,
  permit_paise = tsv.permit_paise,
  fasttag_paise = tsv.fasttag_paise,
  advance_paise = tsv.advance_paise,
  base_amount_paise = tsv.base_amount_paise,
  extras_amount_paise = tsv.extras_amount_paise,
  driver_batta_paise = tsv.driver_batta_paise,
  subtotal_paise = tsv.subtotal_paise,
  gross_paise = tsv.gross_paise,
  net_payable_paise = tsv.net_payable_paise,
  breakdown = tsv.breakdown
FROM trip_sheet_vehicles tsv
WHERE tsv.trip_sheet_id = ts.id AND tsv.line_number = 1;

ALTER TABLE trip_sheets
  ALTER COLUMN snapshot_vehicle_number SET NOT NULL,
  ALTER COLUMN snapshot_vehicle_type SET NOT NULL,
  ALTER COLUMN total_km SET NOT NULL,
  ALTER COLUMN total_hours SET NOT NULL,
  ALTER COLUMN subtotal_paise SET NOT NULL,
  ALTER COLUMN gross_paise SET NOT NULL,
  ALTER COLUMN net_payable_paise SET NOT NULL,
  ALTER COLUMN breakdown SET NOT NULL,
  ADD CONSTRAINT trip_sheets_km_range CHECK (
    opening_km IS NULL OR closing_km IS NULL OR closing_km >= opening_km
  ),
  ADD CONSTRAINT trip_sheets_datetime_range CHECK (
    start_datetime IS NULL OR end_datetime IS NULL OR end_datetime >= start_datetime
  );

CREATE INDEX idx_trips_tenant_vehicle
  ON trip_sheets(tenant_id, vehicle_id, trip_date DESC);

ALTER TABLE trip_sheets
  DROP COLUMN total_net_payable_paise,
  DROP COLUMN vehicle_count;

DROP TABLE IF EXISTS trip_sheet_vehicles;
