# ADR-011: Correlated subqueries reference the outer scope via bound parameters, never unqualified column names

_Last updated: 2026-07-23. Reviewers: TBD._

## Status

Accepted (Task 4.2; confirmed as the pattern to follow again in Task 4.3).

## Context

Postgres resolves an unqualified column reference inside a correlated subquery against the subquery's *own* `FROM` clause first, before considering the outer query's tables. In a multi-tenant schema where `tenant_id` (and often `id`) appears on nearly every table, an unqualified reference intended to reach the outer query's value can silently resolve to the subquery's own same-named column instead — turning an intended cross-scope guard into an always-true tautology inside the inner scope, with no SQL error to flag the mistake.

Task 4.2's `invoiceLine.repository.js#updateLine` needed exactly this shape: an `UPDATE invoice_lines ...` guarded by an `EXISTS` subquery confirming the parent invoice is still `DRAFT`. A naive version of that guard —

```sql
UPDATE invoice_lines
SET description = $4
WHERE id = $3 AND tenant_id = $1
  AND EXISTS (
    SELECT 1 FROM invoices i
    WHERE i.id = invoice_id        -- resolves to invoice_lines.invoice_id? or i's own column?
      AND i.tenant_id = tenant_id  -- resolves to i.tenant_id → always true
      AND i.status = 'DRAFT'::invoice_status_enum
  );
```

— has each unqualified reference on the right-hand side of `=` resolve ambiguously or, worse, resolve cleanly to the wrong table's column of the same name, since `invoices` also has both `id` and `tenant_id` columns. This class of bug is dangerous specifically because it survives ordinary code review — the query reads as correct, and it may even work correctly against a naive test fixture where the coincidentally-matching values happen to agree. It manifests as an authorization failure: a check that was meant to block an action silently permits it instead. In Task 4.2's concrete case, an unqualified guard resolving to a tautology would have let a user edit a line's description on an already-`ISSUED` invoice, not just a `DRAFT` one.

## Decision

Every correlated subquery in this codebase references outer-scope values via the query's own bound parameters (`$1`, `$2`, ...), never by an unqualified column name that depends on Postgres' scope-resolution rules to reach the right table:

```sql
UPDATE invoice_lines
SET description = $4
WHERE id = $3 AND tenant_id = $1
  AND EXISTS (
    SELECT 1 FROM invoices i
    WHERE i.id = $2           -- bound param, unambiguous
      AND i.tenant_id = $1    -- bound param, unambiguous
      AND i.status = 'DRAFT'::invoice_status_enum
  );
```

Every column referenced from the subquery's own table is explicitly qualified with that table's alias (`i.id`, `i.tenant_id`, `i.status`), and every reference to a value that originates outside the subquery is a parameter placeholder rather than a bare column name. Task 4.3's own analogous guard (confirming an invoice's status before a lifecycle transition writes through a similar correlated check) follows the identical shape, on the same reasoning.

## Consequences

Every guard built this way is unambiguous by construction — its correctness doesn't depend on knowing or re-deriving Postgres' scope-resolution rules at read time, and a reviewer can verify it's checking the right thing without mentally simulating which table an unqualified name would bind to. The cost is a small amount of extra parameter bookkeeping in the repository layer: every value the subquery needs from the outer scope has to already be an available bound parameter (or be added as one), rather than being reachable "for free" by referencing an already-selected outer-query column by name. This is judged a straightforward trade — a few extra characters of parameter juggling versus a bug class that produces a silent authorization failure rather than a loud error.

## References

Task 4.2 debrief (`invoiceLine.repository.js#updateLine`, the original discovery); Task 4.3 debrief (the invoice-lifecycle guard subquery, confirming the same pattern independently).
