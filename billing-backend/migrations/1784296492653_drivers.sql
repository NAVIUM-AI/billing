-- Up Migration

CREATE TABLE drivers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  full_name             VARCHAR(255) NOT NULL,

  -- Canonical phone: digits only, with country code 91
  -- prefixed for Indian mobiles. E.g. '919876543210'.
  phone                 VARCHAR(15),
  phone_display         VARCHAR(20),        -- as entered

  license_number        VARCHAR(30),
  license_expiry_date   DATE,

  address_line          VARCHAR(500),
  emergency_contact     VARCHAR(20),        -- canonical form
  notes                 TEXT,

  is_active             BOOLEAN NOT NULL DEFAULT true,
  created_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- License is optional but must be unique per tenant
  -- when present. SQL treats NULLs as distinct by
  -- default, so multiple NULL licenses can coexist.
  CONSTRAINT drivers_license_per_tenant_unique
    UNIQUE (tenant_id, license_number)
);

-- Partial unique index on phone within tenant, only
-- when phone is set. Same NULL-tolerance goal.
CREATE UNIQUE INDEX ux_drivers_phone_per_tenant
  ON drivers(tenant_id, phone)
  WHERE phone IS NOT NULL;

CREATE INDEX idx_drivers_tenant_active
  ON drivers(tenant_id, is_active);

-- Note on name search: skip trigram index for now.
-- <1000 drivers per tenant → seq scan on ILIKE is
-- fine. Add pg_trgm if a client ever exceeds this.

CREATE TRIGGER trg_drivers_updated_at
  BEFORE UPDATE ON drivers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS (Task 1.4 pattern)
ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers FORCE ROW LEVEL SECURITY;

CREATE POLICY drivers_tenant_isolation ON drivers
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

COMMENT ON POLICY drivers_tenant_isolation ON drivers IS
  'Enforces tenant isolation via app.current_tenant_id session var set by tenantContext middleware.';

-- Down Migration

DROP TABLE IF EXISTS drivers;
