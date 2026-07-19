# Planning context

_Last updated: 2026-07-19. Reviewers: TBD._

## Business context

The domain, continued from Module 2, is billing for a cab/travel agency. Module 2 established the pricing engine (`src/domain/pricing/`) and the master records a trip references; Module 3 is where an actual journey gets recorded against those masters and costed. The two real invoices that anchored Module 2's calculator arithmetic — Cauvery Cars CI-150 and Niriksha Travel CI-1905, both outstation-slab jobs — are reproduced exactly by `scripts/verify-trip-sheet-outstation.sh` at the trip-sheet level, not just the pure-calculator level `scripts/test-pricing-calc.js` already covered; this module is where those numbers become a real, persisted, auditable row rather than just a calculator's return value.

## User personas

| Role | What they do with trip sheets |
| --- | --- |
| `owner` | Full access: create, edit drafts, finalize, cancel, list, read performance sheets |
| `admin` | Same as owner for trip-sheet purposes |
| `accountant` | Create, edit drafts, finalize, **and** cancel — cancellation is grouped with finalize as a financial operation, not a day-to-day operational one |
| `staff` | Create, edit drafts, and finalize — day-to-day trip entry and closing out a day's bookings — but cannot cancel a trip once it exists |
| `viewer` | Read-only: list, get, performance sheet, CSV export |

The exact matrix is `src/config/accessMatrix.js` (`trips:read`, `trips:write`, `trips:finalize`, `trips:cancel`); this table paraphrases it for context. `trips:cancel` is deliberately narrower than `trips:write`/`trips:finalize` — cancelling a trip destroys billable history in a way that creating or finalizing one doesn't, so it's held to the same "accountant and above" bar as pricing writes are in Module 2.

## Requirements that drove Module 3 design

1. **Historical trip totals must never change.** A trip's cost, once computed, cannot silently drift because the pricing rule it was based on was later superseded or a vehicle/customer record was edited. This is why every rate-relevant field is snapshotted onto the trip row at creation time (`snapshot_vehicle_number`, `snapshot_customer_name`, and the full set of `snap_*` rate columns) rather than re-derived from the current master state on every read — see `05-design-decisions.md` and ADR-005.
2. **Ops staff need to edit trips freely before they're final, but not after.** A trip entered with a typo'd kilometer reading needs to be fixable without going through a formal correction workflow — as long as nobody has acted on the number yet. Once a trip is `FINALIZED`, that's the line: it's the point after which the number is expected to be stable enough to build a billing decision on. This drove the DRAFT-only PATCH restriction and the explicit lifecycle state machine.
3. **Concurrent transitions must be safe without an application-level lock manager.** Two staff members finalizing the same trip at the same moment, or a finalize racing a PATCH, must produce exactly one winner and a clean error for the loser — never a corrupted or double-applied state. This drove the `SELECT ... FOR UPDATE` + guarded `UPDATE ... WHERE status = $from` pattern (`02-architecture.md`).
4. **Ops staff browse hundreds of trips a day and need running totals, not just a list.** A trip-listing screen that only paginates rows without also surfacing "how much does this filtered set add up to" forces a second manual step (export, sum in a spreadsheet) for a question ops asks constantly. This drove Task 3.4's aggregates-over-the-filtered-set design.
5. **Internal cost tracking (PERFORMANCE trips) needs an Excel-friendly export.** The Blue UI performance-sheet format — grouped by customer, subtotaled, grand-totaled — is how this figure has historically been consumed outside the software, so Task 3.5 reproduces that shape exactly and adds CSV export rather than inventing a new report format.
6. **Multi-tenant isolation applies to transactional data at least as strictly as it applies to masters.** Every table Module 3 adds (`trip_sheets`, `trip_sheet_sequences`, `trip_tolls`) has row-level security both enabled and forced, continuing the pattern from Modules 1-2 without exception — see ADR-003.

## Out of scope

- **Backdated pricing rule supersede.** Pricing rules still require `effective_from` to be today or later on supersede (Module 2's constraint); nothing in Module 3 changes that, so a rate correction for a date that's already passed isn't directly supported end to end. TODO for a later module if a real client need surfaces.
- **Post-finalize correction workflow.** There is no "unfinalize" or "amend a finalized trip" operation — the only paths off `FINALIZED` are `INVOICED` (Module 4) or `CANCELLED`. A finalized trip with a genuine data error today has to be cancelled and re-entered.
- **Unbounded CSV export.** The performance-sheet CSV export caps at 10,000 rows (`EXPORT_TOO_LARGE` beyond that) — there is no streaming/paginated export path for a filtered set larger than the cap.
- **Invoicing, payments, invoice-level GST.** All deferred to Module 4, as covered in `00-overview.md`.
