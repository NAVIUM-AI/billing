# Debugging playbook

_Last updated: 2026-07-19. Reviewers: TBD._

Concrete scenarios, written as "when you see X, check Y." Every check below is something to actually run, not a hypothesis to consider.

## "TRIP_NUMBER_COLLISION on a normal create"

- This should not happen under routine operation — `trip_sheet_sequences`' `allocateSeq` is a single atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` inside the same transaction as the trip insert, so two concurrent creates for the same `(tenant_id, fiscal_year)` serialize on the sequence row's own lock rather than racing. Seeing this error means either the sequence table's row for this tenant/FY is out of sync with the trips that actually exist (check for a prior failed migration or a manually-inserted trip row that bypassed the service), or the `trip_sheet_prefix` on `tenants` changed mid-fiscal-year in a way that produced a number matching an old prefix's number by coincidence — unlikely, but worth ruling out if the prefix was recently edited via `PATCH /settings/business`.
- Reproduce directly:

  ```sql
  SET LOCAL app.current_tenant_id = '<uuid>';
  SELECT tenant_id, fiscal_year, next_seq FROM trip_sheet_sequences
    WHERE tenant_id = '<uuid>';
  SELECT trip_sheet_number FROM trip_sheets
    WHERE tenant_id = '<uuid>' ORDER BY created_at DESC LIMIT 5;
  ```

  Confirm `next_seq` is actually ahead of every existing trip's own sequence number for that fiscal year; if it isn't, the sequence table itself needs a manual correction, not a code fix.

## "PATCH returns TRIP_STATUS_CHANGED_DURING_UPDATE"

- This means a concurrent transition (a finalize, a cancel, or another PATCH) won the race for this trip between your request's row-lock read and its write — the client should reload the trip and retry, not treat this as a bug on first occurrence. If it happens *without* any concurrent request in flight (a single client, sequential requests, no parallelism), that's a genuine problem: check whether `tripRepo.findByIdForUpdate` is actually being called with the transaction's own `client` (not a fresh, unrelated pool connection) — passing the wrong client would mean `FOR UPDATE` never actually holds the lock for the write that follows it.

## "Preview trip creation succeeds but the total doesn't match my calculation"

- Are you comparing rupees to paise? Every stored total on `trip_sheets` (`base_amount_paise`, `subtotal_paise`, `net_payable_paise`, and so on) is integer paise; divide by 100 before comparing against a rupee figure you calculated by hand. `src/utils/money.js#paiseToRupees` is the canonical conversion if you're checking programmatically.
- Confirm which rule actually resolved. `snap_slab_rate_paise` (or the equivalent `snap_*` field for the trip's `rule_type`) on the trip's own row is the rate that was actually used — if it doesn't match what you expect the "current" rate to be, the rule may have been superseded since this trip was created (expected — snapshots are immutable, see `02-architecture.md`) or the trip may be using a different rule than you assumed for its vehicle type.

## "GET /trips list returns 0 rows but I know trips exist"

- Is the request authenticated with the right tenant? RLS filters `trip_sheets` on `app.current_tenant_id`; a request with no valid JWT, or a JWT for a different tenant, returns zero rows — not an error, just an empty result, indistinguishable from "there really are no rows" at the HTTP layer.
- Is `includeCancelled=false` (the default) hiding what you're looking for, and is an explicit `status` filter you don't realize you're sending overriding it in an unexpected way? Recall the precedence: an explicit `status` filter always wins over `includeCancelled`, in both directions — `status=CANCELLED` alone returns only cancelled trips even with `includeCancelled` unset.
- Confirm directly, bypassing the API:

  ```sql
  SET LOCAL app.current_tenant_id = '<uuid>';
  SELECT id, status, trip_date FROM trip_sheets WHERE tenant_id = '<uuid>';
  ```

## "PERFORMANCE sheet omits a trip I know exists"

- Check `billing_mode` on the trip itself — the performance sheet's `billing_mode = 'PERFORMANCE'` filter is fixed and cannot be relaxed by any query param; a `GST` trip will never appear there regardless of any other filter you pass. Confirm via `GET /trips/:id` or the general list.
- Same `includeCancelled`/explicit-`status` precedence as the general list applies here — a cancelled `PERFORMANCE` trip needs `includeCancelled=true` or an explicit `status` filter that includes `CANCELLED`.

## "verify-trip-sheet-outstation.sh Step 15 fails — snapshot changed after supersede"

- The snapshot columns (`snap_slab_rate_paise`, `snap_driver_batta_per_day_paise`, and so on) should be immutable from any individual trip's perspective, permanently, regardless of what happens to the source `pricing_rules` row afterward. If this step fails, the most likely cause is that a code path is re-reading the *current* rule via `findApplicable` (which returns whatever rule is active *today*) instead of the trip's own recorded `pricing_rule_id` via `findById`, or is re-deriving totals from the master instead of trusting the already-stored `snap_*`/`*_paise` columns on the trip row itself. `resolveRuleForRecompute` (`tripSheet.service.js`) is the one place a rule is legitimately re-resolved (for PATCH recompute), and it's deliberately written to use `findById` on the trip's own `pricing_rule_id`, never `findApplicable` — if a future change touches that function, this is the invariant to protect.

## "verify:auth fails after a fresh clone"

- Historically (before the preflight fix described in `scripts/verify-auth.sh`'s own history), this script's DB-reachability preflight shelled out to `docker exec billing-pg psql ...`, which failed outright in any environment without a `billing-pg` Docker container running — including this one, which runs Postgres directly on the host. The preflight now connects via `psql "$DATABASE_URL"` directly, matching every other `verify-*.sh` script, so a fresh clone failing here almost always means `DATABASE_URL` itself is wrong or Postgres isn't reachable, not a Docker problem. Confirm with `psql "$DATABASE_URL" -c 'SELECT 1;'` directly before assuming the script is broken.
- If that connects fine but the script still fails, check `.env` is actually being picked up — the script only auto-sources `.env` when `DATABASE_URL` isn't already set in the shell environment; an exported, stale `DATABASE_URL` from a previous session takes precedence and won't be overwritten.

## "EXPORT_TOO_LARGE unexpectedly"

- The 10,000-row cap applies to the performance sheet's *filtered* row count, computed before pagination doesn't even enter the picture (the performance sheet has no `limit`/`offset` at all — it's a full projection of whatever matches the filter). If this fires on a request you didn't expect to match anywhere near 10,000 rows, check whether the filters you intended to send actually made it into the query string — a silently-dropped `from_date`/`customer_id` (a typo'd param name, for instance, which Joi's `stripUnknown` would drop without erroring) would leave the request matching every `PERFORMANCE` trip in the tenant instead of the narrow set you meant to ask for.

## "CSV output missing subtotal rows"

- Each group's `SUBTOTAL` row is emitted immediately after that group's data rows, inside the same loop that writes them (`getPerformanceSheetCsv`, `performanceSheet.service.js`) — if subtotal rows are missing entirely, check whether `sheet.groups` came back empty (i.e. the filter matched zero trips, in which case there are no subtotal rows to emit because there are no groups, and the CSV should contain only the header and the `GRAND TOTAL` row's own zeroed figures) before assuming the rendering logic itself is broken. If groups ARE present in the JSON response (`GET /trips/performance-sheet`) but the CSV specifically is missing subtotals, that's a genuine rendering bug worth isolating with a small, single-group test case.

## "Concurrent finalize returns 500 instead of 409"

- This should never happen — `scripts/verify-trip-sheet-lifecycle.sh` exercises exactly this scenario (5 parallel finalize requests against the same trip) and asserts exactly one `200` and four `409 INVALID_STATE_TRANSITION`, never a `500`. A `500` here implies the row lock isn't actually being held for the duration intended — check that `findByIdForUpdate` is running inside the same `db.withTenantContext` transaction as the subsequent `transitionStatus` call (both must share the same `client`; opening a second, separate transaction for the write would mean the lock from the first is irrelevant to it) and that no earlier code path is catching and swallowing the guarded-`UPDATE`'s zero-row case before it reaches the explicit `TRIP_STATUS_CHANGED` check.
