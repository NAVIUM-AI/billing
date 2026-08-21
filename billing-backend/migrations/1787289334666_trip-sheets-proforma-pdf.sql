-- Up Migration

-- Trip sheets are becoming self-sufficient for a Proforma PDF: a
-- customer is no longer mandatory (some trips are quoted/logged before
-- a customer is confirmed, or for a walk-in with no CRM record), and a
-- free-text name is accepted as a fallback display value when there's
-- no real customer_id to attach. Same nullable-FK precedent as the
-- trip-sheets-manual-mode migration's vehicle_id change — an ADDITIONAL
-- allowed state, not a replacement of the existing required-customer
-- path (fleet-created trips with a real customer keep working exactly
-- as before).
ALTER TABLE trip_sheets
  ALTER COLUMN customer_id DROP NOT NULL;

-- snapshot_customer_name was NOT NULL because customer_id always was —
-- now that a trip can have neither a customer_id nor a
-- manual_customer_name (the task's own "or none at all"), the snapshot
-- itself must tolerate NULL too rather than the service fabricating an
-- empty string to satisfy the constraint.
ALTER TABLE trip_sheets
  ALTER COLUMN snapshot_customer_name DROP NOT NULL;

-- Free-text fallback, mirroring manual_vehicle_number's own style
-- (trip-sheets-manual-mode migration) — plain VARCHAR, no FK, no
-- validation beyond length, since there's no real customer record
-- behind it by definition.
ALTER TABLE trip_sheets
  ADD COLUMN manual_customer_name VARCHAR(255) NULL;

-- PDF tracking columns, mirroring invoices'/credit_notes' own set
-- exactly (migration 1784573088663_pdf-tracking) — same column names,
-- same types, same IF NOT EXISTS guard style even though these are
-- genuinely new on trip_sheets (no prior migration touched them),
-- kept for consistency with that migration's own defensive convention.
ALTER TABLE trip_sheets
  ADD COLUMN IF NOT EXISTS pdf_url                 VARCHAR(500),
  ADD COLUMN IF NOT EXISTS pdf_generated_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pdf_template_version    VARCHAR(20),
  ADD COLUMN IF NOT EXISTS pdf_file_size_bytes     INTEGER;

-- No backfill needed: every existing row already has a real
-- customer_id (the column was NOT NULL until this migration), so
-- manual_customer_name stays NULL for all of them, which is correct —
-- they still have their real customer.

-- Down Migration

-- Only drop what THIS migration added, same "only revert what you
-- added" convention as the pdf-tracking migration's own down path.
ALTER TABLE trip_sheets
  DROP COLUMN IF EXISTS pdf_file_size_bytes,
  DROP COLUMN IF EXISTS pdf_template_version,
  DROP COLUMN IF EXISTS pdf_generated_at,
  DROP COLUMN IF EXISTS pdf_url,
  DROP COLUMN IF EXISTS manual_customer_name;

-- Reverting snapshot_customer_name/customer_id to NOT NULL is only
-- safe if no row with a NULL value exists — same "fail loudly, not a
-- full data-loss-safe downgrade" convention as trip-sheets-manual-
-- mode's own down migration for vehicle_id.
ALTER TABLE trip_sheets
  ALTER COLUMN snapshot_customer_name SET NOT NULL;

ALTER TABLE trip_sheets
  ALTER COLUMN customer_id SET NOT NULL;
