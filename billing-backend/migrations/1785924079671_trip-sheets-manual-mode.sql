-- Up Migration

-- Pravasi sub-contracts most trips to partner operators outside the
-- registered fleet, and rates are per-customer negotiated rather than
-- rule-card-driven — the fleet+pricing-rule lookup this table was
-- built around (trip-sheets migration) doesn't match that reality.
-- vehicle_id becomes optional so a trip can be entered with a manually
-- typed vehicle number/type + manually typed rates instead. Registered
-- fleet stays fully supported and unchanged — this is an ADDITIONAL
-- code path, not a replacement (see tripSheet.service.js).
ALTER TABLE trip_sheets
  ALTER COLUMN vehicle_id DROP NOT NULL;

-- pricing_source records which path priced this trip, for audit and
-- list-screen filtering. TEXT + CHECK, not a new Postgres enum — same
-- "passive display/filter column" reasoning as the invoice-service-type
-- migration's own service_type column, not a DB-enforced state machine
-- the way trip_status_enum is.
ALTER TABLE trip_sheets
  ADD COLUMN pricing_source TEXT NOT NULL DEFAULT 'FLEET'
    CONSTRAINT trip_sheets_pricing_source_check
    CHECK (pricing_source IN ('FLEET', 'MANUAL'));

-- No backfill needed: every existing row already went through the
-- fleet path, and DEFAULT 'FLEET' above sets that correctly for them.

-- Down Migration

ALTER TABLE trip_sheets
  DROP COLUMN IF EXISTS pricing_source;

-- Reverting vehicle_id to NOT NULL is only safe if no MANUAL-mode row
-- (vehicle_id IS NULL) exists — same "down migrations assume a
-- reasonably fresh/reversible state, not a full data-loss-safe
-- downgrade" convention this repo already follows elsewhere (see
-- invoice-service-type's own down migration, which drops a column with
-- no backfill-preservation either). If MANUAL trips exist, this
-- statement will fail loudly (NOT NULL violation) rather than silently
-- corrupt them — which is the correct behavior for a down migration
-- that can't be made safe.
ALTER TABLE trip_sheets
  ALTER COLUMN vehicle_id SET NOT NULL;
