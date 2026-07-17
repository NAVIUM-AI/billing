-- Up Migration

-- Enable UUID extension (needed for gen_random_uuid() used as PK default)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- TENANTS table
-- Each row = one business (client) using our SaaS.
CREATE TABLE tenants (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  VARCHAR(255) NOT NULL,
  slug                  VARCHAR(100) NOT NULL UNIQUE,
  gstin                 VARCHAR(15),
  pan                   VARCHAR(10),
  state_code            VARCHAR(2),           -- e.g. "KA", "MH"
  logo_url              TEXT,
  invoice_prefix        VARCHAR(20) DEFAULT 'INV',
  current_invoice_seq   INTEGER DEFAULT 0,
  bank_details          JSONB DEFAULT '{}'::jsonb,
  settings              JSONB DEFAULT '{}'::jsonb,
  is_active             BOOLEAN DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tenants_slug ON tenants(slug);

-- USERS table
-- Every user belongs to exactly ONE tenant.
-- Email is unique WITHIN a tenant, not globally.
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           VARCHAR(255) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  full_name       VARCHAR(255),
  role            VARCHAR(50) NOT NULL DEFAULT 'staff',
                  -- allowed: 'owner', 'admin', 'accountant', 'staff', 'viewer'
  is_active       BOOLEAN DEFAULT true,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_role_check CHECK (
    role IN ('owner','admin','accountant','staff','viewer')
  ),
  CONSTRAINT users_email_tenant_unique UNIQUE (tenant_id, email)
);

CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_email  ON users(email);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
DROP TRIGGER IF EXISTS trg_tenants_updated_at ON tenants;
DROP FUNCTION IF EXISTS set_updated_at();
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS tenants;
