-- Up Migration

-- Task 4.9: invoices had no service_type column at all — the frontend
-- (F4a) has no way to persist which service type (LOCAL/OUTSTATION) an
-- invoice was built for, even though every invoice_line already
-- carries its own service_type snapshot (invoice-foundation
-- migration). This is a genuine convenience column for filtering/
-- display, not a new source of truth: PDF template selection
-- (pdf.service.js#pickInvoiceTemplateName) still reads the first
-- line's service_type, unchanged, and continues to work for every
-- pre-existing invoice this column is NULL for.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS service_type TEXT
    CONSTRAINT invoices_service_type_check
    CHECK (service_type IS NULL OR service_type IN ('LOCAL', 'OUTSTATION'));

-- No backfill — legacy invoices stay NULL. Deliberately TEXT + a CHECK
-- constraint rather than reusing trip_service_type_enum: adding an
-- existing Postgres enum type as a column type on a different table
-- works fine, but this column is a passive filter/display convenience
-- copied from user input at create time, not an enum-typed identity
-- the DB itself branches logic on the way trip_sheets.service_type is
-- — a plain CHECK keeps this migration self-contained.

-- Down Migration

ALTER TABLE invoices
  DROP COLUMN IF EXISTS service_type;
