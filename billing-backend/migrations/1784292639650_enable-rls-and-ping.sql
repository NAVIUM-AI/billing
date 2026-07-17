-- Up Migration

-- ─────────────────────────────────────────────────────
-- Throwaway table to PROVE tenant isolation works.
-- Real business tables (customers, vehicles, invoices)
-- come in Module 2 and will follow the same pattern.
-- ─────────────────────────────────────────────────────
CREATE TABLE tenant_pings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pings_tenant ON tenant_pings(tenant_id);

-- ─────────────────────────────────────────────────────
-- Enable RLS on tenant_pings.
-- ─────────────────────────────────────────────────────
ALTER TABLE tenant_pings ENABLE ROW LEVEL SECURITY;

-- Policy: rows are visible/modifiable only when tenant_id matches the
-- session variable set by our middleware. If the variable is not set,
-- current_setting(..., true) returns NULL, and `tenant_id = NULL` is
-- NULL (not true) in SQL's three-valued logic, so the row is filtered
-- out. Secure by default: no session var means no rows, not all rows.
CREATE POLICY tenant_pings_isolation
  ON tenant_pings
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

-- ─────────────────────────────────────────────────────
-- IMPORTANT: RLS is bypassed by table owner + any role
-- with BYPASSRLS. Our app connects as 'billing_app' (the
-- role that owns the tables), so by default RLS would
-- NOT apply to us. We must force it.
-- ─────────────────────────────────────────────────────
ALTER TABLE tenant_pings FORCE ROW LEVEL SECURITY;

-- Comment for future developers.
COMMENT ON POLICY tenant_pings_isolation ON tenant_pings IS
  'Enforces tenant isolation. Depends on session var app.current_tenant_id set by tenantContext middleware.';

-- Down Migration

DROP TABLE IF EXISTS tenant_pings;
