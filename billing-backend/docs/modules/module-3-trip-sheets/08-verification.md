# Verification

_Last updated: 2026-07-19. Reviewers: TBD._

## Automated verification scripts

| Script | Command | Check count | What it proves |
| --- | --- | --- | --- |
| `scripts/verify-trip-sheet-local.sh` | `npm run verify:trips-local` | 14 | LOCAL trip creation (both `GST` and `PERFORMANCE` billing modes), FY-based trip sheet numbering, snapshot fields, cross-tenant leak, DB-layer RLS |
| `scripts/verify-trip-sheet-outstation.sh` | `npm run verify:trips-outstation` | 17 | Cauvery Cars CI-150 and Niriksha Travel CI-1905 reference reproductions to the paise, itemized `trip_tolls`, the lump-sum-vs-itemized conflict rule, the per-day km floor, all four `service_type`×`billing_mode` combinations, snapshot survives a rule supersede, DB-layer RLS on both `trip_sheets` and `trip_tolls` |
| `scripts/verify-trip-sheet-lifecycle.sh` | `npm run verify:trips-lifecycle` | 30 | The full `DRAFT`→`FINALIZED`/`CANCELLED`/`INVOICED` state machine, DRAFT-only PATCH with atomic tolls replacement, RBAC on finalize/cancel, required cancellation reason, and — the concurrency "money shot" — 5 parallel finalize requests against one trip yielding exactly one `200` and four `409` |
| `scripts/verify-trip-sheet-list.sh` | `npm run verify:trips-list` | 30 | Every `GET /trips` filter, the `sort_by` whitelist in both directions, pagination, and the aggregates-independent-of-pagination check (a `limit=1` request still reports the full filtered sum) |
| `scripts/verify-performance-sheet.sh` | `npm run verify:trips-perf` | 23 | The Blue UI reference row reproduced exactly, per-customer grouping and subtotal arithmetic, the fixed `billing_mode='PERFORMANCE'` filter excluding a GST trip, RFC 4180 CSV structure/headers/escaping, and the row-cap constant's presence |
| `scripts/verify-error-handler.sh` | `npm run verify:error-handler` | 6 | Static-grep assertions that `errorHandler.js`'s selective 5xx masking (ADR-007) is shaped correctly — `MASK_STATUSES` includes `500`/`502`/`503`/`504`, excludes `501`, and the `shouldMaskMessage` branch gates on it. Static rather than end-to-end because nothing in the live codebase currently returns a `501` (the LOCAL/OUTSTATION stub this was originally found against was replaced in Task 3.2) or an artificially-triggerable bare `500` |

## Running all Module 3 verifications

```bash
npm run verify:trips-local && \
  npm run verify:trips-outstation && \
  npm run verify:trips-lifecycle && \
  npm run verify:trips-list && \
  npm run verify:trips-perf
```

## Full regression across the project

```bash
npm run test:pricing && \
  npm run verify:auth && \
  npm run verify:tenants && \
  npm run verify:rbac && \
  npm run verify:vehicles && \
  npm run verify:drivers && \
  npm run verify:customers && \
  npm run verify:pricing && \
  npm run verify:trips-local && \
  npm run verify:trips-outstation && \
  npm run verify:trips-lifecycle && \
  npm run verify:trips-list && \
  npm run verify:trips-perf && \
  npm run verify:error-handler
```

`test:pricing` needs neither the dev server nor a database and is safe to run any time; `verify:error-handler` is a static-grep script against the source tree and likewise needs neither. Every other `verify:*` script needs `npm run dev` running in another terminal and a reachable Postgres instance.

## What each Module 3 script proves beyond its check count

**`verify:trips-outstation`** — the two reference-invoice reproductions are the closest thing this module has to a golden-master test: Cauvery Cars CI-150 (`gross`/`net` both `₹92,190`, `9219000` paise) and Niriksha Travel CI-1905 (`gross` `₹62,768`, `net` `₹37,768` after a `₹25,000` advance) are asserted to the exact paise, not just "roughly right," proving the slab/batta/extras arithmetic in `src/domain/pricing/outstation.js` produces the same numbers at the full trip-sheet level (creation → snapshot → stored totals) that `scripts/test-pricing-calc.js` already proves at the pure-calculator level.

**`verify:trips-lifecycle`** — the concurrency test is the module's most load-bearing single assertion: it doesn't just check that a `409` is *possible*, it fires 5 genuinely parallel `finalize` requests (backgrounded `curl` processes, not a sequential loop) against one trip and asserts the exact count of winners (1) and losers (4), which is the only way to actually exercise the row-lock-plus-guarded-UPDATE mechanism under real contention rather than by code inspection.

**`verify:trips-list`** — the aggregates-independent-of-pagination check is the one place a subtle regression (aggregates silently scoped to the page instead of the filtered set) would otherwise slip through unnoticed, since a naive implementation would still pass every other test in the script; requesting `limit=1` and asserting the returned `aggregates.sum_net_payable_paise` still equals the full 7-trip total is what actually catches that class of bug.

**`verify:trips-perf`** — beyond the Blue UI reference row, the script's CSV-structure assertions (exact header line, CRLF line endings via `grep -c $'\r'`, exact `SUBTOTAL`/`GRAND TOTAL` row counts, exact total line count) caught a real bug during development: an early version of `getPerformanceSheetCsv` escaped the customer-name field twice (once explicitly, once again via the row-wide `.map(csvEscape)`), producing doubled quote characters for any name containing a comma. The escaping-specific check (`Step 17`, creating a customer named `"Foo, Inc."`) is what surfaced it — see `known-issues.md`.

## Baseline

As of Task 3.6 completion: 13 verify scripts (233 checks) plus 11 pure pricing-calculator tests, all green, confirmed by a full regression run immediately before this documentation pass was finalized. See the project's own `package.json` `scripts` section for the exact, currently-registered set of `npm run verify:*`/`test:*` commands — this document's script table above is kept in sync with it by hand and should be cross-checked against `package.json` if the two ever appear to disagree.

## Manual verification

Ad hoc `psql` queries useful for sanity-checking Module 3 state outside the automated scripts (run as a superuser, or with `SET LOCAL app.current_tenant_id` set first if running as the app role):

```sql
-- Row counts per table
SELECT COUNT(*) FROM trip_sheets;
SELECT COUNT(*) FROM trip_sheet_sequences;
SELECT COUNT(*) FROM trip_tolls;

-- A tenant's trip sheet sequence state per fiscal year
SELECT tenant_id, fiscal_year, next_seq FROM trip_sheet_sequences
  ORDER BY tenant_id, fiscal_year;

-- Status distribution for a given tenant
SELECT tenant_id, status, COUNT(*) FROM trip_sheets
  GROUP BY tenant_id, status ORDER BY tenant_id, status;

-- Confirm FORCE ROW LEVEL SECURITY on every Module 3 table
SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class
  WHERE relname IN ('trip_sheets', 'trip_sheet_sequences', 'trip_tolls');
-- Expect relrowsecurity = t AND relforcerowsecurity = t on every row.
```
