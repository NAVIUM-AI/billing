-- Up Migration

CREATE TYPE customer_type_enum AS ENUM ('B2C', 'B2B');

CREATE TABLE customers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  customer_type       customer_type_enum NOT NULL,

  -- For B2C: personal name (required).
  -- For B2B: primary billing contact name (optional).
  name                VARCHAR(255),

  -- For B2B: legal entity name (required).
  -- For B2C: NULL.
  company_name        VARCHAR(255),

  -- GST fields (B2B usually has, B2C rarely).
  gstin               VARCHAR(15),
  pan                 VARCHAR(10),

  -- State code (2-letter, e.g. 'KA'). Drives
  -- IGST vs CGST+SGST calculation at invoice time.
  -- For a B2B customer, MUST match GSTIN[0..2] state.
  state_code          VARCHAR(2),

  -- Contact fields.
  phone               VARCHAR(15),          -- canonical
  phone_display       VARCHAR(20),
  email               VARCHAR(255),

  -- Address stored as JSONB. Validated shape enforced
  -- in application layer. Common keys:
  --   { line1, line2, city, district, state,
  --     pincode, country }
  address             JSONB DEFAULT '{}'::jsonb,

  -- B2B commercial terms.
  credit_days         SMALLINT NOT NULL DEFAULT 0
                      CHECK (credit_days BETWEEN 0 AND 365),

  -- Free-form notes.
  notes               TEXT,

  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ─── CHECK constraints ────────────────────────
  -- B2B requires company_name AND gstin AND
  -- state_code.
  CONSTRAINT customers_b2b_required_fields CHECK (
    customer_type <> 'B2B'
    OR (
      company_name IS NOT NULL
      AND gstin IS NOT NULL
      AND state_code IS NOT NULL
    )
  ),
  -- B2C requires name.
  CONSTRAINT customers_b2c_required_fields CHECK (
    customer_type <> 'B2C' OR name IS NOT NULL
  ),
  -- GSTIN format sanity check at DB layer.
  -- Application does the fuller check.
  CONSTRAINT customers_gstin_format CHECK (
    gstin IS NULL
    OR gstin ~ '^[0-9A-Z]{15}$'
  ),
  -- PAN format.
  CONSTRAINT customers_pan_format CHECK (
    pan IS NULL
    OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'
  ),
  -- State code format.
  CONSTRAINT customers_state_code_format CHECK (
    state_code IS NULL
    OR state_code ~ '^[A-Z]{2}$'
  )
);

-- ─── Uniqueness ────────────────────────────────
-- GSTIN unique per tenant when present. Two of your
-- customers should never share a GSTIN — that's a
-- duplicate customer entry.
CREATE UNIQUE INDEX ux_customers_gstin_per_tenant
  ON customers(tenant_id, gstin)
  WHERE gstin IS NOT NULL;

-- Phone unique per tenant when present (partial).
CREATE UNIQUE INDEX ux_customers_phone_per_tenant
  ON customers(tenant_id, phone)
  WHERE phone IS NOT NULL;

-- Email is NOT enforced unique — different family
-- members legitimately share an email in India for
-- B2C bookings.

-- ─── Query indexes ─────────────────────────────
CREATE INDEX idx_customers_tenant_active
  ON customers(tenant_id, is_active);

CREATE INDEX idx_customers_tenant_type
  ON customers(tenant_id, customer_type)
  WHERE is_active = true;

-- Substring search on name/company: pg_trgm gives us
-- fast ILIKE. Enable extension only if not present.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_customers_name_trgm
  ON customers USING gin (name gin_trgm_ops)
  WHERE name IS NOT NULL;
CREATE INDEX idx_customers_company_trgm
  ON customers USING gin (company_name gin_trgm_ops)
  WHERE company_name IS NOT NULL;

-- Trigger + RLS (same pattern as prior tables).
CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;

CREATE POLICY customers_tenant_isolation ON customers
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

COMMENT ON POLICY customers_tenant_isolation
  ON customers IS
  'Enforces tenant isolation via app.current_tenant_id session var set by tenantContext middleware.';

-- ─── Contacts table (B2B multi-contact) ────────
CREATE TABLE customer_contacts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tenant_id      UUID NOT NULL,           -- denormalized for RLS

  name           VARCHAR(255) NOT NULL,
  role           VARCHAR(100),            -- e.g. 'AP', 'Ops Head'
  phone          VARCHAR(15),
  phone_display  VARCHAR(20),
  email          VARCHAR(255),
  is_primary     BOOLEAN NOT NULL DEFAULT false,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one primary contact per customer.
CREATE UNIQUE INDEX ux_customer_contacts_one_primary
  ON customer_contacts(customer_id)
  WHERE is_primary = true;

CREATE INDEX idx_customer_contacts_customer
  ON customer_contacts(customer_id);

CREATE TRIGGER trg_customer_contacts_updated_at
  BEFORE UPDATE ON customer_contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE customer_contacts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_contacts
  FORCE ROW LEVEL SECURITY;

CREATE POLICY customer_contacts_tenant_isolation
  ON customer_contacts
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

-- Down Migration

DROP TABLE IF EXISTS customer_contacts;
DROP TABLE IF EXISTS customers;
DROP TYPE  IF EXISTS customer_type_enum;
