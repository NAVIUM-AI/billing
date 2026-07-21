-- Up Migration

ALTER TABLE invoices
  ADD COLUMN toll_manual_override    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN parking_manual_override BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN permit_manual_override  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN fasttag_manual_override BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN invoices.toll_manual_override IS
  'When true, toll_paise is user-set and does NOT auto-recompute from trip data on invoice change.';
COMMENT ON COLUMN invoices.parking_manual_override IS
  'When true, parking_paise is user-set and does NOT auto-recompute from trip data on invoice change.';
COMMENT ON COLUMN invoices.permit_manual_override IS
  'When true, permit_paise is user-set and does NOT auto-recompute from trip data on invoice change.';
COMMENT ON COLUMN invoices.fasttag_manual_override IS
  'When true, fasttag_paise is user-set and does NOT auto-recompute from trip data on invoice change.';

-- Down Migration

ALTER TABLE invoices
  DROP COLUMN toll_manual_override,
  DROP COLUMN parking_manual_override,
  DROP COLUMN permit_manual_override,
  DROP COLUMN fasttag_manual_override;
