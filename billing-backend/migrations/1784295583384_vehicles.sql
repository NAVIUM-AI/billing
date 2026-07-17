-- Up Migration

-- Vehicle type is a controlled vocabulary to keep pricing lookups and
-- reports sane. Add values here when new categories appear; NEVER
-- remove without a data migration.
CREATE TYPE vehicle_type_enum AS ENUM (
  'SEDAN',
  'SUV',
  'HATCHBACK',
  'INNOVA',
  'KIA_CARNIVAL',
  'TEMPO_TRAVELLER',
  'MINI_BUS',
  'BUS_50_SEATER',
  'OTHER'
);

CREATE TABLE vehicles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Canonical form: uppercase, no spaces (e.g. KA51AK1031)
  vehicle_number        VARCHAR(20) NOT NULL,

  -- Human-friendly form: as user typed it (e.g. "KA 51 AK 1031")
  -- Used only for display; never for lookup.
  vehicle_number_display VARCHAR(30),

  vehicle_type          vehicle_type_enum NOT NULL,
  make_model            VARCHAR(255),          -- e.g. "Toyota Innova Crysta"
  registration_state    VARCHAR(2),            -- "KA", "MH"
  seating_capacity      SMALLINT CHECK (seating_capacity BETWEEN 1 AND 60),

  -- Optional operational metadata
  fuel_type             VARCHAR(20),           -- 'PETROL','DIESEL','CNG','EV'
  year_of_manufacture   SMALLINT CHECK (year_of_manufacture BETWEEN 1990 AND 2100),

  notes                 TEXT,

  is_active             BOOLEAN NOT NULL DEFAULT true,
  created_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT vehicles_number_per_tenant_unique
    UNIQUE (tenant_id, vehicle_number)
);

-- Indexes:
-- 1. Every list query filters by tenant + is_active.
CREATE INDEX idx_vehicles_tenant_active
  ON vehicles(tenant_id, is_active);

-- 2. Type filter for reports and pricing rule lookups.
CREATE INDEX idx_vehicles_tenant_type
  ON vehicles(tenant_id, vehicle_type)
  WHERE is_active = true;

-- Auto-update updated_at (trigger function created in the Task 1.1
-- migration).
CREATE TRIGGER trg_vehicles_updated_at
  BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Enable Row-Level Security (Task 1.4 pattern).
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles FORCE ROW LEVEL SECURITY;

CREATE POLICY vehicles_tenant_isolation ON vehicles
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

COMMENT ON POLICY vehicles_tenant_isolation ON vehicles IS
  'Enforces tenant isolation via app.current_tenant_id session var set by tenantContext middleware.';

-- Down Migration

DROP TABLE IF EXISTS vehicles;
DROP TYPE IF EXISTS vehicle_type_enum;
