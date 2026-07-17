-- Up Migration

-- Stores the HASH of each issued refresh token so we
-- can revoke them (logout, password change, etc).
-- We never store the raw token.
CREATE TABLE refresh_tokens (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash     VARCHAR(128) NOT NULL,       -- SHA-256 hex = 64 chars, room for future algos
  user_agent     TEXT,
  ip_address     INET,
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,                 -- NULL = active
  replaced_by    UUID REFERENCES refresh_tokens(id),
                                              -- rotation trail
  CONSTRAINT refresh_tokens_hash_unique UNIQUE (token_hash)
);

CREATE INDEX idx_refresh_user_active ON refresh_tokens(user_id)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_refresh_expires_at ON refresh_tokens(expires_at)
  WHERE revoked_at IS NULL;

-- Down Migration

DROP TABLE IF EXISTS refresh_tokens;
