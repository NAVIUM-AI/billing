-- Up Migration

ALTER TABLE tenants
  ADD COLUMN trip_sheet_prefix VARCHAR(20)
  NOT NULL DEFAULT 'TS';

-- Down Migration

ALTER TABLE tenants DROP COLUMN trip_sheet_prefix;