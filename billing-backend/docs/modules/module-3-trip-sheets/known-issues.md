# Known issues

_Last updated: 2026-07-19. Reviewers: TBD._

All Module 3 verification scripts and the pricing-calculator unit tests pass at 100% as of this writing — see `08-verification.md` for the current per-script counts and the full-regression baseline. The issues below are the record of what was actually found broken (and, in each case, fixed) during Module 3's development, plus a record of spec-level arithmetic mistakes found while writing verify scripts, kept for the same reason Module 2's `known-issues.md` keeps its own: so nobody re-discovers the same rake by copy-pasting an old example.

## Fixed in Task 3.6

### Issue: `errorHandler.js` masked the message of every 5xx response, including deliberate 501s

**Symptom:** Any endpoint using `apiError(501, ...)` had its message stripped down to the generic `"Internal server error"` before reaching the client, discarding the actual, deliberately-written explanation.

**Affected task:** originally surfaced during Task 3.1 (the OUTSTATION `501` stub, later replaced in Task 3.2); the masking bug itself lived in `errorHandler.js` from whenever the blanket `status >= 500` check was first written.

**Status:** FIXED.

**Fix summary:** `errorHandler.js` now masks only `500`/`502`/`503`/`504`; `501` and any other 5xx code passes its message through unmasked. See ADR-007 for the full rationale and `scripts/verify-error-handler.sh` for the static-grep regression check (no live 501-returning endpoint currently exists in this codebase to test end to end).

## Fixed during development (Tasks 3.1-3.5, found via verification, not by the task specs' own automation)

### Issue: Performance-sheet CSV export double-escaped customer names containing a comma

**Symptom:** A customer named `"Foo, Inc."` appeared in the CSV export as `"""Foo, Inc."""` (six quote characters) instead of the RFC-4180-correct `"Foo, Inc."` (two).

**Affected task:** 3.5 (Performance sheet CSV export).

**Detected by:** `scripts/verify-performance-sheet.sh`'s own Step 17 (CSV escaping), which creates exactly this customer and greps the output for the correctly-escaped form — not by any check in the original task spec's worked examples, which didn't specify the exact escaped output to assert against.

**Root cause:** `getPerformanceSheetCsv` (`performanceSheet.service.js`) called `csvEscape()` on the customer-name field explicitly when building each row array, and then called it again on every field — including the already-escaped name — via `.map(csvEscape)` immediately after. The second pass saw a string that already started and ended with a quote character (the first pass's output) and, correctly per its own logic, wrapped and doubled it a second time.

**Status:** FIXED. The explicit inline `csvEscape(group.customer_name)` calls (both in the per-row loop and the `SUBTOTAL` row) were removed; every field is now escaped exactly once, at the single `.map(csvEscape)` pass each row already went through.

## Task spec issues (documentation-only — no code changes; recorded so the same example data doesn't get reused uncritically)

- **Task 3.2's example toll receipt data used a 1-character `plaza_name`** (`"X"`), which violates `tollReceiptSchema`'s own `min(2)` constraint — defined in that same task's own instructions. Corrected to `"XX"` in `scripts/verify-trip-sheet-outstation.sh`'s malformed-data test case (which specifically wants a rejection, so the correction there was to use a *valid* 2-character plaza name in the adjacent non-error test case, not the one deliberately testing rejection).
- **Task 3.4's setup data produces a `search=acme` result count of 2, not the 3 the task's own worked example states.** The spec's Step 17 says "Expect total 3" for a search matching the B2B customer "Acme Logistics," but only lists two matching trip ids (T4, T7) in the same sentence — the third Acme trip in that task's fixture set, T5, is cancelled and correctly excluded by the endpoint's own default `includeCancelled=false` behavior, which the spec's own earlier steps establish. `scripts/verify-trip-sheet-list.sh` asserts the arithmetically correct value (2), with an inline comment noting the discrepancy.
- **Recurring across Tasks 3.1-3.5: task specs' hardcoded example dates drift into the future relative to whenever the verify script actually runs.** Every trip-date and pricing-rule-supersede example date in the original task specs was written against an assumed "today" that predates this environment's actual system date; `tripDateField`'s "cannot be in the future" check (and the pricing module's equivalent for supersede) would reject those literal dates if used as-is. Every verify script computes its trip dates as offsets *before* today (`date -v-Nd`) instead of hardcoding a calendar date, established as a standing convention (Rule 8) starting with Task 3.3's own spec and applied retroactively to every earlier script.

## Deferred

- **Backdated supersede for pricing rules.** `POST /pricing/rules/:id/supersede` still requires `effective_from` to be today or later (a Module 2 constraint, unchanged by Module 3). A rate correction for a date that's already passed has no direct API path. Deferred until a real client need surfaces — see `01-planning-context.md`.
- **Post-finalize correction workflow.** There is no "amend a finalized trip" operation; the only paths off `FINALIZED` are `INVOICED` (Module 4) or `CANCELLED`. Deferred indefinitely — the current expectation is that agencies cancel (with a reason) and re-enter a trip that needs correction after finalization, rather than amending in place.
- **Unbounded CSV export.** The performance-sheet CSV export has a hard cap of 10,000 rows (`EXPORT_TOO_LARGE` beyond that); there is no streaming or paginated export path for a filtered set larger than the cap.
