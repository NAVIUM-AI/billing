# Database schema

_Last updated: 2026-07-18. Reviewers: TBD._

Module 2 adds five tables across four migrations: `vehicles`, `drivers`, `customers` + `customer_contacts` (one migration), and `pricing_rules`. Every table follows the same tenant-isolation shape — a `tenant_id` foreign key, an `is_active` boolean for soft delete, `created_at`/`updated_at` maintained by a shared trigger function, and forced row-level security — established in Module 1 and applied without exception here.

## Table: `vehicles`

**Migration:** `migrations/1784295583384_vehicles.sql`

Purpose: the fleet master. One row per physical vehicle an agency owns or contracts, identified primarily by its registration number.

| Column | Type | Nullable | Default | Description |
| --- | --- | --- | --- | --- |
| `id` | UUID | no | `gen_random_uuid()` | Primary key |
| `tenant_id` | UUID | no | — | FK to `tenants(id)`, `ON DELETE CASCADE` |
| `vehicle_number` | VARCHAR(20) | no | — | Canonical registration number: uppercase, no separators (e.g. `KA51AK1031`). Used for lookups and the uniqueness constraint |
| `vehicle_number_display` | VARCHAR(30) | yes | — | Exactly as the user typed it (e.g. `KA 51 AK 1031`). Display only, never used for lookups |
| `vehicle_type` | `vehicle_type_enum` | no | — | See "Enums" below |
| `make_model` | VARCHAR(255) | yes | — | e.g. "Toyota Innova Crysta" |
| `registration_state` | VARCHAR(2) | yes | — | 2-letter state code; auto-derived from the vehicle number's first 2 characters if omitted at create time |
| `seating_capacity` | SMALLINT | yes | — | `CHECK (seating_capacity BETWEEN 1 AND 60)` |
| `fuel_type` | VARCHAR(20) | yes | — | Free text (`PETROL`, `DIESEL`, `CNG`, `ELECTRIC`, `HYBRID` at the Joi layer; not a DB enum) |
| `year_of_manufacture` | SMALLINT | yes | — | `CHECK (year_of_manufacture BETWEEN 1990 AND 2100)` |
| `notes` | TEXT | yes | — | Free-form |
| `is_active` | BOOLEAN | no | `true` | Soft-delete flag; `false` = archived |
| `created_by` | UUID | yes | — | FK to `users(id)` |
| `created_at` / `updated_at` | TIMESTAMPTZ | no | `NOW()` | `updated_at` maintained by `trg_vehicles_updated_at` |

**Constraints:**

- `vehicles_number_per_tenant_unique` — `UNIQUE (tenant_id, vehicle_number)`. Two vehicles in the same tenant can never share a canonical number; the same number in two different tenants is fine (different agencies, unrelated vehicles).
- `seating_capacity` and `year_of_manufacture` CHECKs — sanity bounds, not business rules; they exist to catch obvious data-entry mistakes (e.g. a 3-digit seating capacity typo) rather than to encode a real-world constraint.

**Indexes:**

- `idx_vehicles_tenant_active` on `(tenant_id, is_active)` — every list query filters by tenant and active state.
- `idx_vehicles_tenant_type` on `(tenant_id, vehicle_type)` `WHERE is_active = true` — supports type-filtered lookups (used by pricing-rule applicability checks in Module 3+) without scanning archived rows.

**RLS policy** (`vehicles_tenant_isolation`):

```sql
CREATE POLICY vehicles_tenant_isolation ON vehicles
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
```

Both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` are set — see ADR-003 for why the second statement is not optional.

## Table: `drivers`

**Migration:** `migrations/1784296492653_drivers.sql`

Purpose: the driver master. One row per driver, with every field except `full_name` optional, since not every agency tracks drivers formally (see `01-planning-context.md`, requirement 5).

| Column | Type | Nullable | Default | Description |
| --- | --- | --- | --- | --- |
| `id` | UUID | no | `gen_random_uuid()` | Primary key |
| `tenant_id` | UUID | no | — | FK to `tenants(id)`, `ON DELETE CASCADE` |
| `full_name` | VARCHAR(255) | no | — | The only required field on this table |
| `phone` | VARCHAR(15) | yes | — | Canonical: digits only, `91`-prefixed for Indian mobiles (e.g. `919876543210`) |
| `phone_display` | VARCHAR(20) | yes | — | As entered |
| `license_number` | VARCHAR(30) | yes | — | Uppercased on write |
| `license_expiry_date` | DATE | yes | — | |
| `address_line` | VARCHAR(500) | yes | — | |
| `emergency_contact` | VARCHAR(20) | yes | — | Canonical form only — no separate display column (see `05-design-decisions.md`) |
| `notes` | TEXT | yes | — | |
| `is_active` | BOOLEAN | no | `true` | Soft-delete flag |
| `created_by` | UUID | yes | — | FK to `users(id)` |
| `created_at` / `updated_at` | TIMESTAMPTZ | no | `NOW()` | `updated_at` maintained by `trg_drivers_updated_at` |

**Constraints:**

- `drivers_license_per_tenant_unique` — `UNIQUE (tenant_id, license_number)`. Postgres treats `NULL` as distinct from every other `NULL` under a plain `UNIQUE` constraint, so any number of drivers with no license on file can coexist.

**Indexes:**

- `ux_drivers_phone_per_tenant` — `UNIQUE INDEX ... WHERE phone IS NOT NULL`. Same NULL-tolerance goal as the license constraint, but expressed as a partial index rather than a table constraint, since phone dedup needs the `WHERE` clause to only apply the uniqueness rule when a phone is actually present.
- `idx_drivers_tenant_active` on `(tenant_id, is_active)`.
- No trigram index on `full_name` — the migration's own comment notes this is a deliberate omission: below roughly 1,000 drivers per tenant, a sequential scan on `ILIKE` is fine, and `pg_trgm` can be added later if a client's driver roster grows past that.

**RLS policy** (`drivers_tenant_isolation`): identical shape to `vehicles_tenant_isolation` above, substituting the table name.

## Table: `customers`

**Migration:** `migrations/1784312109616_customers.sql`

Purpose: the customer master, covering both individual (B2C) and business (B2B) customers in a single table, distinguished by `customer_type`. See `05-design-decisions.md` for why one table rather than two.

| Column | Type | Nullable | Default | Description |
| --- | --- | --- | --- | --- |
| `id` | UUID | no | `gen_random_uuid()` | Primary key |
| `tenant_id` | UUID | no | — | FK to `tenants(id)`, `ON DELETE CASCADE` |
| `customer_type` | `customer_type_enum` | no | — | `B2C` or `B2B` |
| `name` | VARCHAR(255) | yes | — | Required for B2C (personal name); optional for B2B (primary billing contact name) |
| `company_name` | VARCHAR(255) | yes | — | Required for B2B; must be absent for B2C |
| `gstin` | VARCHAR(15) | yes | — | Required for B2B; rare but allowed for B2C |
| `pan` | VARCHAR(10) | yes | — | |
| `state_code` | VARCHAR(2) | yes | — | Required for B2B (auto-derived from `gstin` if omitted); drives IGST vs. CGST+SGST at invoice time (Module 4) |
| `phone` | VARCHAR(15) | yes | — | Canonical, same convention as `drivers.phone` |
| `phone_display` | VARCHAR(20) | yes | — | |
| `email` | VARCHAR(255) | yes | — | Not unique — see below |
| `address` | JSONB | no | `'{}'::jsonb` | Shape validated at the application layer only (`addressSchema` in `customer.validator.js`): `line1`, `line2`, `city`, `district`, `state`, `pincode`, `country` |
| `credit_days` | SMALLINT | no | `0` | `CHECK (credit_days BETWEEN 0 AND 365)`. `0` = due immediately |
| `notes` | TEXT | yes | — | |
| `is_active` | BOOLEAN | no | `true` | Soft-delete flag |
| `created_by` | UUID | yes | — | FK to `users(id)` |
| `created_at` / `updated_at` | TIMESTAMPTZ | no | `NOW()` | `updated_at` maintained by `trg_customers_updated_at` |

**Constraints:**

- `customers_b2b_required_fields` — `CHECK (customer_type <> 'B2B' OR (company_name IS NOT NULL AND gstin IS NOT NULL AND state_code IS NOT NULL))`.
- `customers_b2c_required_fields` — `CHECK (customer_type <> 'B2C' OR name IS NOT NULL)`.
- `customers_gstin_format` — `CHECK (gstin IS NULL OR gstin ~ '^[0-9A-Z]{15}$')`. A DB-level structural sanity check; the fuller format + checksum-position validation lives in `src/utils/gstin.js` at the application layer.
- `customers_pan_format` — `CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$')`.
- `customers_state_code_format` — `CHECK (state_code IS NULL OR state_code ~ '^[A-Z]{2}$')`.

All five are enforced at the Joi/service layer first (see `06-error-reference.md` for the specific error codes each maps to via `customer.repository.js`'s constraint-name mapping), with the DB CHECK as the non-bypassable backstop.

**Indexes:**

- `ux_customers_gstin_per_tenant` — `UNIQUE INDEX ... WHERE gstin IS NOT NULL`. Two customers in the same tenant can never share a GSTIN.
- `ux_customers_phone_per_tenant` — `UNIQUE INDEX ... WHERE phone IS NOT NULL`.
- `idx_customers_tenant_active` on `(tenant_id, is_active)`.
- `idx_customers_tenant_type` on `(tenant_id, customer_type)` `WHERE is_active = true`.
- `idx_customers_name_trgm` / `idx_customers_company_trgm` — GIN indexes using `gin_trgm_ops` (requires the `pg_trgm` extension), supporting fast `ILIKE '%term%'` substring search on `name`/`company_name` from `GET /customers?search=`.

`email` is deliberately **not** unique — the migration's comment notes that different family members legitimately share an email address for B2C bookings in this domain, so a uniqueness constraint would actively get in the way rather than catch a real duplicate.

**RLS policy** (`customers_tenant_isolation`): same shape as `vehicles_tenant_isolation`.

## Table: `customer_contacts`

**Migration:** `migrations/1784312109616_customers.sql` (same file as `customers`)

Purpose: a B2B customer can have multiple named contacts (an accounts-payable contact, an operations contact, etc.); a B2C customer's own `phone`/`email` on the `customers` row is its only contact point, so this table is only ever populated for B2B rows (enforced in `customer.service.js#addContact`, not by a DB constraint).

| Column | Type | Nullable | Default | Description |
| --- | --- | --- | --- | --- |
| `id` | UUID | no | `gen_random_uuid()` | Primary key |
| `customer_id` | UUID | no | — | FK to `customers(id)`, `ON DELETE CASCADE` |
| `tenant_id` | UUID | no | — | **Denormalized** — duplicated from the parent customer row so RLS can filter this table directly without a join |
| `name` | VARCHAR(255) | no | — | |
| `role` | VARCHAR(100) | yes | — | e.g. `"AP"`, `"Ops Head"` |
| `phone` | VARCHAR(15) | yes | — | Canonical |
| `phone_display` | VARCHAR(20) | yes | — | |
| `email` | VARCHAR(255) | yes | — | |
| `is_primary` | BOOLEAN | no | `false` | At most one `true` per customer — see below |
| `created_at` / `updated_at` | TIMESTAMPTZ | no | `NOW()` | `updated_at` maintained by `trg_customer_contacts_updated_at` |

**Indexes:**

- `ux_customer_contacts_one_primary` — `UNIQUE INDEX ON customer_contacts(customer_id) WHERE is_primary = true`. Enforces "at most one primary contact per customer" at the database layer; `customer.repository.js#insertContact` flips any existing primary off in the same transaction before inserting a new primary, and this index is the backstop against a race between two concurrent "set as primary" requests (see `06-error-reference.md`, `CONTACT_PRIMARY_CONFLICT`).
- `idx_customer_contacts_customer` on `(customer_id)`.

**RLS policy** (`customer_contacts_tenant_isolation`): same USING/WITH CHECK shape as the others, reading the denormalized `tenant_id` column directly.

## Table: `pricing_rules`

**Migration:** `migrations/1784313219045_pricing-rules.sql`

Purpose: versioned rate tables. One row per (tenant, rule type, vehicle type, date range) combination; see ADR-005 for why rates are versioned rather than edited in place.

| Column | Type | Nullable | Default | Description |
| --- | --- | --- | --- | --- |
| `id` | UUID | no | `gen_random_uuid()` | Primary key |
| `tenant_id` | UUID | no | — | FK to `tenants(id)`, `ON DELETE CASCADE` |
| `rule_type` | `pricing_rule_type_enum` | no | — | `LOCAL_PACKAGE`, `OUTSTATION_SLAB`, or `PERFORMANCE` |
| `vehicle_type` | `vehicle_type_enum` | no | — | Same enum as `vehicles.vehicle_type` |
| `label` | VARCHAR(255) | no | — | Admin-UI display label only; never used in calculation |
| `base_hours` | SMALLINT | yes | — | LOCAL_PACKAGE only |
| `base_km` | INTEGER | yes | — | LOCAL_PACKAGE only |
| `base_price_paise` | INTEGER | yes | — | LOCAL_PACKAGE only |
| `extra_km_rate_paise` | INTEGER | yes | — | LOCAL_PACKAGE only |
| `extra_hr_rate_paise` | INTEGER | yes | — | LOCAL_PACKAGE only |
| `slab_rate_paise` | INTEGER | yes | — | OUTSTATION_SLAB only |
| `min_km_per_day` | INTEGER | yes | — | OUTSTATION_SLAB only |
| `driver_batta_per_day_paise` | INTEGER | yes | — | OUTSTATION_SLAB only |
| `per_km_rate_paise` | INTEGER | yes | — | PERFORMANCE only |
| `performance_batta_paise` | INTEGER | yes | — | PERFORMANCE only |
| `effective_from` | DATE | no | — | Inclusive start of the half-open validity range |
| `effective_to` | DATE | yes | — | Exclusive end; `NULL` = still active (open-ended) |
| `effective_range` | DATERANGE | no | *generated* | `GENERATED ALWAYS AS (daterange(effective_from, effective_to, '[)')) STORED` — a stored, indexable expression used only by the exclusion constraint below |
| `notes` | TEXT | yes | — | |
| `created_by` | UUID | yes | — | FK to `users(id)` |
| `created_at` / `updated_at` | TIMESTAMPTZ | no | `NOW()` | `updated_at` maintained by `trg_pricing_rules_updated_at` |

All rate/count columns are nullable at the table level because which ones are required depends on `rule_type` — enforced by the per-type CHECK constraints below, not by `NOT NULL`.

**Constraints:**

- `pricing_local_required_fields` — for `rule_type = 'LOCAL_PACKAGE'`, requires `base_hours > 0`, `base_km > 0`, `base_price_paise >= 0`, `extra_km_rate_paise >= 0`, `extra_hr_rate_paise >= 0` all non-null.
- `pricing_outstation_required_fields` — for `OUTSTATION_SLAB`, requires `slab_rate_paise > 0`, `min_km_per_day >= 0`, `driver_batta_per_day_paise >= 0` all non-null.
- `pricing_performance_required_fields` — for `PERFORMANCE`, requires `per_km_rate_paise > 0`, `performance_batta_paise >= 0` both non-null.
- `pricing_effective_range` — `CHECK (effective_to IS NULL OR effective_to > effective_from)`.
- `pricing_rules_no_overlap` — an `EXCLUDE USING gist` constraint (not a `CHECK`), added separately after table creation:

  ```sql
  ALTER TABLE pricing_rules
    ADD CONSTRAINT pricing_rules_no_overlap
    EXCLUDE USING gist (
      tenant_id       WITH =,
      rule_type       WITH =,
      vehicle_type    WITH =,
      effective_range WITH &&
    );
  ```

  This is the constraint that makes "the applicable rule for X on date Y" unambiguous: for a fixed `(tenant_id, rule_type, vehicle_type)`, no two rows' `effective_range`s may overlap (`&&`), so at most one row can ever match a given date. It's why `pricingRule.repository.js#findApplicable` can safely `LIMIT 1` without an `ORDER BY` to break ties — there are never ties to break. Violating it raises Postgres SQLSTATE `23P01` (exclusion_violation), mapped to `409 PRICING_RULE_OVERLAP`.

**Indexes:**

- `idx_pricing_lookup` on `(tenant_id, rule_type, vehicle_type, effective_from)` — supports the applicable-rule lookup query pattern.
- `idx_pricing_current` on `(tenant_id, effective_from DESC)` `WHERE effective_to IS NULL` — supports "list the currently active rules" for the admin UI without scanning superseded (closed) rows.

**RLS policy** (`pricing_rules_tenant_isolation`): same shape as the others.

## Enums

### `vehicle_type_enum`

Defined in the Task 2.1 migration (`migrations/1784295583384_vehicles.sql`), reused by `pricing_rules.vehicle_type`.

Values: `SEDAN`, `SUV`, `HATCHBACK`, `INNOVA`, `KIA_CARNIVAL`, `TEMPO_TRAVELLER`, `MINI_BUS`, `BUS_50_SEATER`, `OTHER`.

To add a value in a later migration:

```sql
ALTER TYPE vehicle_type_enum ADD VALUE 'NEW_VALUE';
```

On Postgres 12+ this can run as part of a normal migration; see ADR-001 for the constraints around adding enum values inside a transaction alongside other DDL.

### `customer_type_enum`

Defined in `migrations/1784312109616_customers.sql`.

Values: `B2C`, `B2B`.

### `pricing_rule_type_enum`

Defined in `migrations/1784313219045_pricing-rules.sql`.

Values: `LOCAL_PACKAGE`, `OUTSTATION_SLAB`, `PERFORMANCE`.

## ER Diagram

See [`diagrams/er-diagram.md`](diagrams/er-diagram.md) for the full mermaid diagram. Summary of relationships: `tenants` is the root of every table below it via `tenant_id`; `customers` has a one-to-many relationship to `customer_contacts`; `pricing_rules` references `vehicle_type_enum` but has no foreign key to `vehicles` itself (a pricing rule applies to a *category* of vehicle, not a specific one).

## Extensions used

- **`pgcrypto`** — provides `gen_random_uuid()`, used as the default for every table's `id` column. Enabled in the Module 1 migration (`migrations/1784287969933_init-tenants-and-users.sql`), not re-declared in Module 2.
- **`pg_trgm`** — provides the trigram GIN operator class (`gin_trgm_ops`) behind `idx_customers_name_trgm` / `idx_customers_company_trgm`, giving fast substring search on customer name/company. Enabled via `CREATE EXTENSION IF NOT EXISTS pg_trgm` in the customers migration.
- **`btree_gist`** — required for the `pricing_rules_no_overlap` exclusion constraint, which mixes an equality comparison (`tenant_id`, `rule_type`, `vehicle_type` — ordinary scalar types) with a range-overlap comparison (`effective_range`) in a single GiST index; `btree_gist` supplies the GiST operator classes for the scalar columns so they can participate in that index at all. Enabled via `CREATE EXTENSION IF NOT EXISTS btree_gist` in the pricing-rules migration.

**Prod-ops note** (from the pricing-rules migration's top-of-file comment): `btree_gist` is a *trusted* extension in Postgres 13+, meaning any role with `CREATE` on the database — not just a superuser — can install it. In this repo's local dev setup, the non-superuser `billing_app` role was granted `CREATE ON DATABASE` specifically so it could run `CREATE EXTENSION IF NOT EXISTS pg_trgm` (Task 2.3) and later `btree_gist` (Task 2.4) as part of its own migrations. In production, the safer option is to have a DBA run `CREATE EXTENSION btree_gist;` (and `pg_trgm`) once, out-of-band, as a superuser before the corresponding migration deploys, so the application's migration role never needs a standing `CREATE ON DATABASE` grant; `CREATE EXTENSION IF NOT EXISTS` in the migration then succeeds as a no-op against the already-installed extension.
