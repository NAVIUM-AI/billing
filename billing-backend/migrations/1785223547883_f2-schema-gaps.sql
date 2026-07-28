-- Up Migration

-- Task 4.8: closes three schema gaps documented in Task 4.7's
-- known-issues.md "Deferred" section, now needed because F2's frontend
-- Business Settings / Bank Details screens need real columns to
-- read/write.
--
-- Deviation from the task's own spec prose (Rule 10): the spec assumed
-- a `bank_accounts` table with its own `pan` column + CHECK constraint.
-- No such table exists in this schema — bank details live entirely in
-- `tenants.bank_details` (JSONB), validated at the application layer by
-- settings.validator.js#bankDetailsSchema (an .unknown(false) allowlist
-- of account_name/account_number/ifsc/bank_name/branch/upi_id). `pan`
-- is added as a new allowed key in that same JSONB blob, not a new
-- column — see settings.validator.js for the format check (there's no
-- separate row to put a DB CHECK constraint on).
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS tagline       TEXT,
  ADD COLUMN IF NOT EXISTS phone         TEXT,
  ADD COLUMN IF NOT EXISTS jurisdiction  TEXT;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS reverse_charge  BOOLEAN;

-- No backfill needed — every new column is nullable and existing rows
-- get NULL, which both the settings/invoice services and the v1.1.0
-- PDF templates already treat as "not set, render/omit gracefully"
-- (same convention as every other nullable column in this schema).

-- Down Migration

ALTER TABLE invoices
  DROP COLUMN IF EXISTS reverse_charge;

ALTER TABLE tenants
  DROP COLUMN IF EXISTS tagline,
  DROP COLUMN IF EXISTS phone,
  DROP COLUMN IF EXISTS jurisdiction;
