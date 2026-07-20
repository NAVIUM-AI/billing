-- Up Migration

-- ─── Enums ───────────────────────────────
CREATE TYPE payment_mode_enum AS ENUM (
  'CASH',
  'UPI',
  'NEFT',
  'RTGS',
  'IMPS',
  'CHEQUE',
  'CARD',
  'BANK_TRANSFER'
);

CREATE TYPE payment_status_enum AS ENUM (
  'RECORDED',   -- Payment is active and counted
  'CANCELLED'   -- Payment was reversed (kept for audit)
);

-- ─── payments table ──────────────────────
CREATE TABLE payments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Who paid
  customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,

  -- What it's applied to
  invoice_id            UUID REFERENCES invoices(id) ON DELETE RESTRICT,
  -- Nullable. When null -> unallocated advance held
  -- against the customer.

  -- The originating payment. When a payment splits
  -- (over-payment on invoice -> excess becomes advance),
  -- the advance row has parent_payment_id pointing to
  -- the applied portion. Used for audit trail.
  parent_payment_id     UUID REFERENCES payments(id) ON DELETE RESTRICT,

  -- Money
  amount_paise          BIGINT NOT NULL
    CHECK (amount_paise > 0),
  -- Payments are always positive. Cancellations
  -- flip status; they don't create negative
  -- payments.

  -- Method + reference
  payment_mode          payment_mode_enum NOT NULL,
  reference_number      VARCHAR(100),
  -- UPI txn ID, NEFT UTR, cheque number, etc.
  -- Required for non-CASH modes (enforced by CHECK).
  -- Null allowed for CASH.

  -- Timing
  received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- When money physically arrived. Distinct from
  -- created_at (when we recorded it).

  -- Status
  status                payment_status_enum NOT NULL
    DEFAULT 'RECORDED',

  -- Notes / audit
  notes                 TEXT,
  recorded_by           UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at          TIMESTAMPTZ,
  cancelled_by          UUID REFERENCES users(id),
  cancellation_reason   TEXT,

  -- Constraints

  -- Reference required for non-cash payments
  CONSTRAINT payments_reference_required
    CHECK (
      payment_mode = 'CASH'
      OR (reference_number IS NOT NULL AND length(reference_number) > 0)
    ),

  -- Split payments: parent_payment_id semantics
  -- Only set when a split happened; NULL for
  -- non-split payments.
  CONSTRAINT payments_parent_self_ref
    CHECK (parent_payment_id IS NULL
           OR parent_payment_id <> id)
);

-- ─── Idempotency ─────────────────────────
-- Prevent double-recording same NEFT UTR / UPI txn.
-- Only enforces for RECORDED payments — a cancelled
-- payment with the same reference can be re-recorded.
CREATE UNIQUE INDEX idx_payments_ref_unique
  ON payments (tenant_id, payment_mode, reference_number)
  WHERE payment_mode <> 'CASH'
    AND status = 'RECORDED'
    AND reference_number IS NOT NULL;

-- ─── Query indexes ───────────────────────
CREATE INDEX idx_payments_tenant_customer
  ON payments(tenant_id, customer_id, received_at DESC);
CREATE INDEX idx_payments_tenant_invoice
  ON payments(tenant_id, invoice_id, received_at DESC)
  WHERE invoice_id IS NOT NULL;
CREATE INDEX idx_payments_tenant_status_advance
  ON payments(tenant_id, customer_id, status)
  WHERE invoice_id IS NULL AND status = 'RECORDED';
-- ^ optimizes "find unallocated advance for
-- customer X"

CREATE INDEX idx_payments_tenant_date
  ON payments(tenant_id, received_at DESC);

-- ─── Triggers ────────────────────────────
CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── RLS ─────────────────────────────────
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE POLICY payments_tenant_isolation
  ON payments
  USING (tenant_id = current_setting(
    'app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting(
    'app.current_tenant_id', true)::uuid);

-- Down Migration

DROP TABLE IF EXISTS payments;
DROP TYPE  IF EXISTS payment_status_enum;
DROP TYPE  IF EXISTS payment_mode_enum;
