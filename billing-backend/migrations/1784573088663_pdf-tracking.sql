-- Up Migration

-- invoices already has pdf_url, pdf_generated_at, pdf_template_version
-- from the Task 4.1 invoice-foundation migration; credit_notes already
-- has pdf_url, pdf_generated_at, pdf_template_version from the Task 4.3
-- credit-notes migration. IF NOT EXISTS makes this migration safe to
-- run regardless (and self-documents that Task 4.5 depends on them),
-- but the only column genuinely new here is pdf_file_size_bytes on
-- both tables.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS pdf_url                 VARCHAR(500),
  ADD COLUMN IF NOT EXISTS pdf_generated_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pdf_template_version    VARCHAR(20),
  ADD COLUMN IF NOT EXISTS pdf_file_size_bytes     INTEGER;

ALTER TABLE credit_notes
  ADD COLUMN IF NOT EXISTS pdf_template_version    VARCHAR(20),
  ADD COLUMN IF NOT EXISTS pdf_file_size_bytes     INTEGER;

-- Down Migration

-- Only drop what THIS migration actually added — pdf_url,
-- pdf_generated_at, and pdf_template_version on invoices predate this
-- migration (Task 4.1's invoice-foundation migration owns their
-- down-path), same "only revert what you added" convention as Task
-- 4.1's own down migration for tenants.invoice_prefix.
ALTER TABLE invoices
  DROP COLUMN IF EXISTS pdf_file_size_bytes;

ALTER TABLE credit_notes
  DROP COLUMN IF EXISTS pdf_file_size_bytes,
  DROP COLUMN IF EXISTS pdf_template_version;
