-- Up Migration

CREATE TABLE trip_tolls (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_sheet_id     UUID NOT NULL REFERENCES trip_sheets(id)
                    ON DELETE CASCADE,
  tenant_id         UUID NOT NULL,      -- denormalized for RLS

  -- Toll plaza details (as printed on the receipt).
  plaza_name        VARCHAR(255) NOT NULL,
  toll_id           VARCHAR(50),        -- optional; some slips
                                         -- omit numeric ID
  amount_paise      INTEGER NOT NULL CHECK (amount_paise >= 0),

  -- When the receipt was issued at the plaza.
  -- Nullable because scanned receipts may not have a
  -- readable timestamp.
  crossed_at        TIMESTAMPTZ,

  -- Optional metadata for audit trails.
  vehicle_number    VARCHAR(20),        -- as printed on
                                         -- receipt
  closing_balance_paise INTEGER,        -- FASTag closing
                                         -- balance after
                                         -- toll deducted
  notes             TEXT,

  -- Line ordering within the trip's toll list.
  -- Not strictly needed (crossed_at + created_at give
  -- order), but explicit sequence makes UI display
  -- deterministic.
  line_number       SMALLINT NOT NULL,
  CONSTRAINT trip_tolls_line_positive
    CHECK (line_number > 0),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT trip_tolls_line_per_trip_unique
    UNIQUE (trip_sheet_id, line_number)
);

-- Query indexes.
CREATE INDEX idx_trip_tolls_trip
  ON trip_tolls(trip_sheet_id, line_number);

CREATE INDEX idx_trip_tolls_tenant_date
  ON trip_tolls(tenant_id, crossed_at DESC)
  WHERE crossed_at IS NOT NULL;

-- RLS (mirrors trip_sheets pattern).
ALTER TABLE trip_tolls ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_tolls FORCE ROW LEVEL SECURITY;

CREATE POLICY trip_tolls_tenant_isolation
  ON trip_tolls
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

COMMENT ON POLICY trip_tolls_tenant_isolation
  ON trip_tolls IS
  'Tenant isolation via app.current_tenant_id session var.';

-- No updated_at column: tolls are append-once,
-- delete-with-parent. No mutation lifecycle.

-- Down Migration

DROP TABLE IF EXISTS trip_tolls;