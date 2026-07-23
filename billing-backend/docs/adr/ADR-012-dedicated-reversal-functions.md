# ADR-012: transitionStatus's COALESCE pattern can only add values, never clear them — reversal transitions get a dedicated function instead

_Last updated: 2026-07-23. Reviewers: TBD._

## Status

Accepted (Task 4.3).

## Context

Both the trip and invoice repositories have a `transitionStatus` function that updates a row's `status` plus a set of optional audit fields in one guarded `UPDATE`. Every optional field uses `COALESCE` so a caller only has to pass what *this* transition actually sets, leaving every other field's existing value untouched — `finalized_at = COALESCE($4, finalized_at)`, and so on. This makes every forward-only transition clean: finalize sets `finalized_at`, cancel sets `cancelled_at`, and the different transitions' fields never overlap or need to clear one another.

`COALESCE`'s limitation is that it cannot distinguish "the caller didn't touch this field" from "the caller explicitly wants this field set back to `NULL`" — both arrive as a JS `null`/`undefined` argument, and `COALESCE(NULL, existing_value)` always resolves to the existing value either way. Task 4.3 needed exactly the case this can't express: reversing a trip from `INVOICED` back to `FINALIZED` (when an `ISSUED`/`PAID` invoice that held it gets cancelled) requires clearing `trip_sheets.invoiced_at` and `invoice_id` back to `NULL` — not leaving them at whatever they were, which is all the existing `transitionStatus`/`COALESCE` machinery is capable of.

## Decision

Reversal transitions that need to clear specific fields to `NULL` get a dedicated repository function, rather than extending `transitionStatus` with a sentinel value or a second calling convention to distinguish "don't touch" from "clear." `tripSheet.repository.js#reverseInvoiced` is the concrete instance:

```sql
UPDATE trip_sheets
SET status = 'FINALIZED'::trip_status_enum,
    invoiced_at = NULL,
    invoice_id = NULL
WHERE id = $1::uuid
  AND tenant_id = $2::uuid
  AND status = 'INVOICED'::trip_status_enum
RETURNING *;
```

`invoice.repository.js#transitionStatus`'s own `COALESCE`-based approach was deliberately left as-is for the invoice side, since every field it touches (`invoice_number`, `tenant_snapshot`, `customer_snapshot`) is write-once in that state machine — nothing in the invoice lifecycle ever needs to clear one of those back to `NULL` once set, so the limitation this ADR describes never actually applies there.

## Consequences

The existing `transitionStatus` contract stays exactly as it was, unmodified and still covered by every test that already exercised it (Task 3.3's full lifecycle suite) — no risk of a change to its calling convention subtly breaking a forward transition while fixing a reversal one. Reversal intent is explicit and readable at every call site: `reverseInvoiced` unconditionally clears the two fields it's named for, with no caller needing to remember to pass a special sentinel to achieve that.

The trade-off is that the repository's API surface grows by one function per reversal case that needs this treatment — there is exactly one today (`reverseInvoiced`). If a third or fourth reversal-shaped transition appears later, each needing its own set of fields cleared, a sentinel-value convention (a distinguished marker meaning "clear this," distinct from `undefined`/`null` meaning "leave alone") or a pair of separate `set`/`clear` parameter objects might be worth introducing at that point — but committing to that generalization now, for a single concrete case, would be speculative complexity ahead of an actual second and third need.

## References

Task 4.3 debrief; `src/repositories/tripSheet.repository.js#reverseInvoiced`'s own inline comment (documents this same reasoning at the call site); `src/repositories/invoice.repository.js#transitionStatus`'s own comment (explains why the `COALESCE` approach remains safe for the invoice side specifically).
