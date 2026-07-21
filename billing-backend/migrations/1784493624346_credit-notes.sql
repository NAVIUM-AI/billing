-- Up Migration

-- ─── Credit notes table ────────────────
CREATE TABLE credit_notes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Credit notes have their own numbering:
  -- CN-1/26-27, CN-2/26-27 ...
  -- Under Indian GST, credit note numbering is
  -- required to be gap-free per FY.
  credit_note_number    VARCHAR(30) NOT NULL,

  original_invoice_id   UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,

  -- Snapshot the customer at credit-note issue.
  -- Same reason invoices snapshot: customer info
  -- must not retroactively change on historical
  -- documents.
  customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  customer_snapshot     JSONB NOT NULL,
  tenant_snapshot        JSONB NOT NULL,

  -- Financial: mirrors the original invoice's totals
  -- as of cancellation. This is the reversal amount.
  subtotal_paise        BIGINT NOT NULL,
  total_gst_paise       BIGINT NOT NULL,
  cgst_paise            BIGINT NOT NULL,
  sgst_paise            BIGINT NOT NULL,
  igst_paise            BIGINT NOT NULL,
  toll_paise            BIGINT NOT NULL,
  parking_paise         BIGINT NOT NULL,
  permit_paise          BIGINT NOT NULL,
  fasttag_paise         BIGINT NOT NULL,
  discount_paise        BIGINT NOT NULL,
  grand_total_paise     BIGINT NOT NULL,
  net_payable_paise     BIGINT NOT NULL,

  -- Business fields
  credit_note_date      DATE NOT NULL,
  reason                TEXT NOT NULL,
  amount_in_words       VARCHAR(500),

  -- PDF (Task 4.5)
  pdf_url               VARCHAR(500),
  pdf_generated_at      TIMESTAMPTZ,
  pdf_template_version  VARCHAR(20),

  -- Audit
  issued_by             UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT credit_notes_number_per_tenant_unique
    UNIQUE (tenant_id, credit_note_number)
);

CREATE INDEX idx_credit_notes_tenant_date
  ON credit_notes(tenant_id, credit_note_date DESC);
CREATE INDEX idx_credit_notes_original_invoice
  ON credit_notes(original_invoice_id);

-- ─── Credit note number sequences ──────
CREATE TABLE credit_note_number_sequences (
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fiscal_year    VARCHAR(5) NOT NULL,
  next_seq       INTEGER NOT NULL DEFAULT 1,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, fiscal_year)
);

-- ─── Tenants: credit note prefix ───────
ALTER TABLE tenants
  ADD COLUMN credit_note_prefix VARCHAR(20)
    NOT NULL DEFAULT 'CN';
-- Auto-derived: invoice_prefix + '-CN' if not
-- 'INV'. If invoice_prefix='PRA' -> 'PRA-CN'.
-- Backfill existing tenants below.

UPDATE tenants
  SET credit_note_prefix =
    CASE
      WHEN invoice_prefix = 'INV' THEN 'CN'
      ELSE invoice_prefix || '-CN'
    END;

-- ─── RLS on new tables ─────────────────
ALTER TABLE credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_notes_tenant_isolation
  ON credit_notes
  USING (tenant_id = current_setting(
    'app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting(
    'app.current_tenant_id', true)::uuid);

ALTER TABLE credit_note_number_sequences
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_note_number_sequences
  FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_note_seq_tenant_isolation
  ON credit_note_number_sequences
  USING (tenant_id = current_setting(
    'app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting(
    'app.current_tenant_id', true)::uuid);

-- Down Migration

ALTER TABLE tenants DROP COLUMN credit_note_prefix;
DROP TABLE IF EXISTS credit_note_number_sequences;
DROP TABLE IF EXISTS credit_notes;
