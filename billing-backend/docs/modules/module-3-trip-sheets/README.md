# Module 3: Trip Sheets

_Last updated: 2026-07-18. Reviewers: TBD._

Module 3 is under construction. Trip sheet management, lifecycle, listing, performance sheets.

Task 3.1 shipped the `trip_sheets` base table, tenant-scoped FY-based trip sheet numbering, and `POST /trips` / `GET /trips/:tripId` for LOCAL trip creation (both GST and PERFORMANCE billing modes) via the Module 2 pricing engine. Outstation creation was stubbed with `501 NOT_YET_IMPLEMENTED` in that task — Task 3.2 (below) replaces the stub with a real implementation.

## Task 3.2: Outstation trip creation

- `trip_tolls` child table with per-plaza itemized receipts (append-only; no update/delete path except cascade-with-parent — PATCH support ships in Task 3.3 alongside draft trip editing).
- Both GST and PERFORMANCE billing modes supported for OUTSTATION, completing all four `service_type` × `billing_mode` combinations.
- Slab pricing with a per-day km floor: billable km = `max(actual_km, min_km_per_day × total_days)`.
- Driver batta multiplied by `total_days`.
- Advance captured on the trip and deducted from `gross_paise` to produce `net_payable_paise` at the trip level — unlike LOCAL, where advance is captured but never subtracted (invoice-level advance deduction for combined B2B billing is Module 4's concern either way).
- Toll input: EITHER a lump-sum `toll_rupees` OR an itemized `tolls` array — enforced by the `TOLL_INPUT_CONFLICT` rule (service-layer, not Joi, since it's a cross-field check).
- Snapshot fields for the outstation rule (`snap_slab_rate_paise`, `snap_min_km_per_day`, `snap_driver_batta_per_day_paise`) preserved for audit — confirmed to survive a rule supersede.
- Reference reproductions, exact to the paise: Cauvery Cars CI-150 (₹92,190 gross/net) and Niriksha Travel CI-1905 (₹62,768 gross, ₹37,768 net after a ₹25,000 advance).

## Task 3.3: Trip lifecycle

- Explicit state machine in `src/domain/tripLifecycle/` (pure module, no framework imports — same pattern as `src/domain/pricing/`). Module 4's invoice-issue flow reuses this same validator.
- DRAFT → FINALIZED → INVOICED (INVOICED is set by Module 4 — no route exists for it here) or DRAFT/FINALIZED → CANCELLED (terminal; no un-cancel).
- PATCH allowed only for DRAFT trips; whitelisted fields only (identity/audit/snapshot columns are never patchable); the itemized `tolls` array is atomically replaceable (delete-then-reinsert in the same transaction as the trip update — no window where the trip has zero tolls if a caller sent a replacement list).
- Every PATCH recomputes `base_amount_paise`/`extras_amount_paise`/`driver_batta_paise`/`subtotal_paise`/`gross_paise`/`net_payable_paise`/`breakdown` as a group via the pricing engine — never patched independently, so they can never drift out of sync with the usage fields that produced them. Recomputation always uses the trip's *original* rule (via `pricing_rule_id`, falling back to the immutable snapshot) — never an implicit `findApplicable` lookup, so a PATCH can never silently reprice a trip against a newer superseded rule.
- Finalize requires `trips:finalize`; cancel requires `trips:cancel` (higher-privilege than `trips:write` — cancellation destroys billable history); PATCH requires `trips:write`.
- Cancellation reason is required (Joi, min 3 chars) — no cancel-without-explanation path.
- Concurrent transitions are safe: `SELECT ... FOR UPDATE` (via `findByIdForUpdate`) row-locks the trip for the duration of the transaction, and every transition/update is additionally guarded by its own `WHERE status = <expected>` clause — belt-and-suspenders. Verified under real concurrency: 5 parallel finalize requests on the same trip yield exactly one 200 and four 409 `INVALID_STATE_TRANSITION`.
- Snapshot fields (`snap_*`) are NEVER touched by PATCH — rate immutability is preserved (ADR-005) even through draft editing.
- `markTripInvoiced` service function reserved for Module 4; no API endpoint exposes it.

No full docs pass in this task. Module 3 comprehensive docs come at Task 3.6 (parallel to Task 2.5 for Module 2).
