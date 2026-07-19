# Architecture

_Last updated: 2026-07-19. Reviewers: TBD._

## Layered flow

Module 3 follows the same layering Module 2 established, with one addition: a second pure domain module alongside pricing.

```
HTTP → Route → Validator → Service → Repository → SQL
                  │           │           │
                  ▼           ▼           ▼
               Joi schema  Business    Postgres +
                           rules,      RLS
                           domain
                           calls
```

`src/api/v1/trips.routes.js` is thin — `authenticate` + `tenantContext` + `requirePermission(key)` + `validate(schema)` in front of a handler that calls a service function and shapes the response, no business logic or SQL. `src/validators/tripSheet.validator.js` defines request shape with Joi; cross-field checks that need context the validator doesn't have (opening/closing km ordering needs a specific error code Joi's generic wrapping would obscure; the tolls-vs-lump-sum conflict needs to compare two sibling fields) live in the service instead. `src/services/tripSheet.service.js` and `src/services/performanceSheet.service.js` hold the business rules, the pricing-domain calls, and the transaction boundary. `src/repositories/tripSheet.repository.js` and `src/repositories/tripToll.repository.js` hold every line of SQL for their tables and accept only already-normalized primitives plus a `client`.

Every service function that creates or mutates a trip follows the same order established in Module 2 (`normalize → derive → validate → check → write`), written out as numbered inline comments matching each step. "Check" and "write" happen together inside one `db.withTenantContext` transaction whenever a mutation touches more than one thing that must succeed or fail as a unit — trip-number allocation and the trip insert itself, most notably, since a failed insert must not burn a sequence number and a sequence number must never be allocated for a trip that didn't actually get created.

## Two pure domain modules

`src/domain/pricing/` (Module 2) computes what a trip costs; `src/domain/tripLifecycle/` (Task 3.3) decides which status transitions are legal. Both have zero imports from `express`, `pg`, or anything under `src/api`/`src/services`/`src/repositories`, and both follow the same error-translation pattern (ADR-006): the domain throws its own dependency-free error class (`DomainInputError` for pricing, `LifecycleError` for lifecycle — though the current lifecycle consumer throws `apiError` directly at the service boundary rather than catching and re-throwing `LifecycleError`, since `assertTransition` never actually catches one; see `05-design-decisions.md`), and the service layer is the only place that translates a domain failure into an HTTP-shaped `apiError`. `src/domain/tripLifecycle/index.js` is a `TRANSITIONS` map of `Set`s (`DRAFT → {FINALIZED, CANCELLED}`, `FINALIZED → {INVOICED, CANCELLED}`, `INVOICED`/`CANCELLED` terminal) with `isValidTransition(from, to)` and `allowedTransitions(from)` helpers — small enough to read end to end in under a minute, which is the point: the entire legal-transition table for a trip's life is one file, with no framework code to trace through to find it.

## Snapshot pattern

`trip_sheets` freezes two categories of data onto the row at creation time: identity snapshots (`snapshot_vehicle_number`, `snapshot_vehicle_type`, `snapshot_customer_name`, `snapshot_customer_gstin`) and rate snapshots (`snap_base_hours`, `snap_base_km`, `snap_base_price_paise`, `snap_extra_km_rate_paise`, `snap_extra_hr_rate_paise`, `snap_slab_rate_paise`, `snap_min_km_per_day`, `snap_driver_batta_per_day_paise`, `snap_per_km_rate_paise`, `snap_performance_batta_paise`) — the full set of rate columns from whichever pricing rule was applicable, copied straight across regardless of `rule_type`, since a rule's own per-type CHECK constraints already guarantee irrelevant columns are `NULL` on the source row. This is ADR-005's second layer: the `pricing_rules` table itself is versioned so "what was the rate on date X" is answerable for any historical `X`, and the trip's own snapshot is a second, independent safeguard so that even if `pricing_rules` were somehow altered after the fact, the trip's own recorded numbers don't move. `verify-trip-sheet-outstation.sh` proves this directly: it supersedes a rule the trip already used and re-fetches the trip, asserting every snapshot field and every derived total is byte-for-byte unchanged.

PATCH recompute (Task 3.3) reinforces the same guarantee from the other direction: `resolveRuleForRecompute` resolves the rule to use for a DRAFT edit via `trip.pricing_rule_id` and `ruleRepo.findById` — never `findApplicable` — falling back to the trip's own snapshot fields if the rule row no longer exists. An edit to a DRAFT trip can never silently reprice against a newer rule that has superseded the one the trip originally used.

## Lifecycle state machine

```
        POST /trips
             │
             ▼
         ┌───────┐   POST .../finalize    ┌───────────┐
         │ DRAFT │ ──────────────────────▶│ FINALIZED │
         └───┬───┘                        └─────┬─────┘
             │                                   │
             │ POST .../cancel                   │ POST .../cancel
             │                                   │        (reversal)
             ▼                                   ▼
        ┌───────────┐                      ┌───────────┐
        │ CANCELLED │◀─────────────────────┤ CANCELLED │
        └───────────┘   (same terminal      └───────────┘
                          state either way)
                                   FINALIZED
                                       │
                                       │ Module 4 invoice-issue
                                       │ (markTripInvoiced, no route)
                                       ▼
                                  ┌──────────┐
                                  │ INVOICED │  (terminal from this
                                  └──────────┘   module's perspective)
```

Every transition (`updateTripSheet` for DRAFT edits, `finalizeTripSheet`, `cancelTripSheet`, and the unrouted `markTripInvoiced`) opens with `tripRepo.findByIdForUpdate`, which issues `SELECT ... FOR UPDATE` inside the caller's transaction — a concurrent request against the same trip blocks on that `SELECT` until the first transaction commits or rolls back, so two racing requests can never both read the same "current" status and both believe their own transition is valid. On top of the row lock, every write is *additionally* guarded by its own `WHERE status = $fromStatus` clause (`tripRepo.transitionStatus`, `tripRepo.updateDraft`) — belt-and-suspenders: even in a hypothetical scenario where the lock's protection were somehow bypassed, a stale-status UPDATE matches zero rows instead of clobbering a transition it didn't know about, and the service treats that zero-row case as a `409` rather than silently succeeding. `scripts/verify-trip-sheet-lifecycle.sh` proves this under real concurrency, not just by inspection: 5 parallel `finalize` requests against the same trip yield exactly one `200` and four `409 INVALID_STATE_TRANSITION`.

## Aggregates in the list endpoint

`GET /trips` (Task 3.4) returns `{ trips, pagination, aggregates }`, and `aggregates` is computed over the *filtered* set matching the request's query params, not just the page currently being returned — a caller paging through results with `limit=25` still sees the true sum/count across every matching trip in `aggregates`, not just the 25 on that page. The repository (`tripSheet.repository.js#list`) achieves this by building one `wheres`/`params` array and reusing it verbatim for both the paginated data query and a second, unpaginated aggregates query — deliberately not copy-pasting the `WHERE` clause into two separate strings, since that would create drift the moment a future filter is added to one query but not the other. `scripts/verify-trip-sheet-list.sh`'s aggregates-independent-of-pagination check (`limit=1` still reports the full filtered sum) is the direct proof this actually holds.

## Performance sheet as projection

`PERFORMANCE` is one of two values of `billing_mode` on `trip_sheets` — it is not a separate entity, and Task 3.5 introduces no new table for it. `GET /trips/performance-sheet` and its CSV counterpart are read-only projections: `tripSheet.repository.js#listPerformanceRows` runs the same WHERE-composition pattern as the general list query, with one additional, non-overridable filter (`billing_mode = 'PERFORMANCE'`), and `performanceSheet.service.js` groups the resulting rows by customer and formats them to match the Blue UI reference columns. Nothing about a `PERFORMANCE` trip's creation, storage, or lifecycle differs from a `GST` trip — the projection is purely a different way of reading the same rows.
