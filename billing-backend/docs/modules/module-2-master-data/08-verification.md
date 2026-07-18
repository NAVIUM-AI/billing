# Verification

_Last updated: 2026-07-18. Reviewers: TBD._

## Automated verification scripts

| Script | Command | What it tests |
| --- | --- | --- |
| `scripts/verify-vehicles.sh` | `npm run verify:vehicles` | 21 checks: creation + canonical/display normalization, duplicate detection across formatting variants, validation errors, list/search/type-filter, get-by-id, cross-tenant leak (404), update, immutable `vehicle_number`, staff write access, a static access-matrix check, archive/unarchive (including the archived-exists re-create case), and a DB-layer RLS check |
| `scripts/verify-drivers.sh` | `npm run verify:drivers` | 17 checks: creation with phone/license normalization, independent duplicate detection on phone AND license, optional-everything semantics (two drivers with no phone/license coexisting), validation, list/search (name and phone-fragment), cross-tenant leak, update, staff write access, archive/unarchive, DB-layer RLS |
| `scripts/verify-customers.sh` | `npm run verify:customers` | 24 checks: B2C and B2B happy paths, conditional required-field rejections for both types, GSTIN state auto-derivation and mismatch detection, invalid GSTIN format, duplicate GSTIN/phone, list/filter/search (by type, company name, GSTIN case-insensitively, phone fragment), cross-tenant leak, update, immutable `customer_type`, the full contacts sub-resource (add, atomic primary-flip, B2B-only gate, included-on-get), archive/unarchive, staff write access, DB-layer RLS on both `customers` and `customer_contacts` |
| `scripts/verify-pricing.sh` | `npm run verify:pricing` | 20 checks: staff-cannot-write RBAC, rule creation with rupee→paise conversion, the non-overlap exclusion constraint, per-type missing-fields validation, list/filter, applicable-rule lookup (hit and both miss cases), immutable-fields PATCH rejection, atomic supersede, pre-hike/post-hike applicable-rule resolution, the preview endpoint against the Yellow UI reference numbers before and after a rate hike, cross-tenant leak, DB-layer RLS |
| `scripts/test-pricing-calc.js` | `npm run test:pricing` | 7 pure-calculator assertions, no DB/server required: the Yellow UI local-package reference row, two real outstation invoice references (Cauvery Cars CI-150, Niriksha Travel CI-1905), the Blue performance-sheet reference row, two edge cases (extras zero when usage is under the base slab; the per-day minimum-km floor overriding actual distance), and a dispatch-routing check |

## Running all verifications

```bash
npm run test:pricing && npm run verify:vehicles && npm run verify:drivers && npm run verify:customers && npm run verify:pricing
```

`test:pricing` needs neither the dev server nor a database and is safe to run any time. The four `verify:*` scripts need `npm run dev` running in another terminal and a reachable Postgres instance; run `npm run verify:tenants` (Task 1.4) first if you want the underlying tenant-isolation mechanism itself re-proven before testing what's built on top of it.

## What each script proves

**`verify:vehicles`** — the "money shot" checks are the cross-tenant leak test (tenant B reading tenant A's vehicle by id must 404, not 403 — a 403 would confirm the row exists and just isn't accessible, which is itself a smaller leak) and the final DB-layer check, which connects directly as the application's own Postgres role with no `app.current_tenant_id` session variable set and asserts `SELECT COUNT(*) FROM vehicles` returns `0` — proving row-level security is what's blocking the data, not merely the API layer choosing not to return it.

**`verify:drivers`** — the equivalent cross-tenant and DB-layer checks, plus a check specific to this table's design: two drivers can be created with no phone and no license number at all, back to back, without a duplicate-key error, proving the partial unique indexes correctly tolerate multiple `NULL`s rather than treating them as colliding values.

**`verify:customers`** — cross-tenant and DB-layer checks across *two* tables (`customers` and `customer_contacts`), plus the atomic-primary-flip check: adding a second contact with `is_primary: true` must leave exactly one contact marked primary afterward, never zero and never two, proving the flip-then-insert sequence in `customer.repository.js#insertContact` is correctly scoped to the same transaction as the insert it precedes.

**`verify:pricing`** — the non-overlap exclusion constraint (a second rule for the same vehicle/rule type in an overlapping date range is rejected at the database level, not just by application logic) and the supersede atomicity check: after superseding, the old rule's `effective_to` must equal the new rule's `effective_from` *exactly*, and a lookup for a date one day before that boundary must resolve to the old rule while a lookup on the boundary date itself resolves to the new one — proving there is no gap and no double-coverage at the transition point.

## Manual verification

Ad hoc `psql` queries useful for sanity-checking the state of the database outside the automated scripts (run as a superuser, or with `SET LOCAL app.current_tenant_id` set first if running as the app role):

```sql
-- Row counts per table
SELECT COUNT(*) FROM vehicles;
SELECT COUNT(*) FROM drivers;
SELECT COUNT(*) FROM customers;
SELECT COUNT(*) FROM customer_contacts;
SELECT COUNT(*) FROM pricing_rules;

-- Per-tenant customer distribution (superuser only — bypasses RLS
-- entirely, which is exactly why this is a superuser-only query)
SELECT tenant_id, COUNT(*) FROM customers GROUP BY tenant_id;

-- Pricing rule version history for a given tenant, oldest first —
-- useful for eyeballing a supersede chain
SELECT rule_type, vehicle_type, label, effective_from, effective_to
  FROM pricing_rules
  ORDER BY tenant_id, rule_type, vehicle_type, effective_from;

-- Confirm FORCE ROW LEVEL SECURITY on every Module 2 table
SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class
  WHERE relname IN ('vehicles', 'drivers', 'customers',
                     'customer_contacts', 'pricing_rules');
-- Expect relrowsecurity = t AND relforcerowsecurity = t on every row.
```
