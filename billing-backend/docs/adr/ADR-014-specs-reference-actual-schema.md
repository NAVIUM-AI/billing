# ADR-014: Task specs should reference the actual schema, not an imagined one

_Last updated: 2026-07-23. Reviewers: TBD._

## Status

Accepted (Tasks 4.3, 4.5).

## Context

Tasks 4.3 and 4.5 each hit the same class of problem independently: task-spec pseudocode referenced columns that don't exist anywhere in this schema, as though the spec had been written from an idealized or half-remembered version of the tables rather than the tables as they actually stand.

Task 4.3's `buildTenantSnapshot`/`buildCustomerSnapshot` spec listed `tenants.address_line1`, `city`, `state`, `pincode`, `phone`, `email`, `website` — none of which exist; `tenants` has only `name`/`gstin`/`pan`/`state_code`/`logo_url`/`bank_details`/`gst_rate`, and a customer's address is a single nested `address` JSONB blob (`{ line1, line2, city, district, state, pincode, country }`), not flat columns. Task 4.5's PDF-template spec went further, listing `tenants.tagline`, `phone2`, an invoice-level `reverse_charge` column, and a per-line KM/hour rate breakdown on `invoice_lines` — again, none of which exist; `invoice_lines` stores one combined `extras_amount_paise` per line, and there is no reimbursement or rate-split column at that granularity anywhere in the table. Both times, the executor correctly adapted — reading the actual schema, building the feature against what's really there, and documenting the deviation in the code and the task debrief — but that adaptation and its accompanying debrief write-up is real, avoidable cost, repeated across two unrelated tasks for the same underlying reason.

## Decision

Future task specs, when they touch a database table or an existing API response shape, will:

1. Open with an explicit instruction to inspect the current schema for the tables in question first — a migration file, a `\d tablename`, or an existing repository file — rather than asserting a column list as given fact.
2. Describe *intent* ("populate a snapshot capturing the tenant's business identity") rather than enumerate a specific column list the spec author is guessing at.
3. When the stated intent genuinely requires a column that doesn't exist yet, say so explicitly and include the migration to add it as part of the same task — rather than presenting a nonexistent column as though it already exists and leaving the gap for the executor to discover and quietly patch over.

## Consequences

Fewer executor-side deviations need reconciling against spec text after the fact, and the corresponding debrief noise (explaining and justifying each deviation) shrinks correspondingly. The schema itself stays lean, since columns get added only when a task's stated intent genuinely needs them, rather than accumulating "just in case" fields a misremembered spec assumed were already there. The cost is that specs become slightly less prescriptive and self-contained — an executor following a "describe intent, verify against real schema" spec has to make more small decisions about exact field mappings than one following a fully columnar spec would, which is an acceptable trade given the standing principle (Rule 10) that actual code always outranks spec prose when the two disagree; a less prescriptive spec simply asks for that judgment call earlier and more explicitly.

## References

Task 4.3 debrief (`src/utils/invoiceSnapshot.js`'s own top-of-file comment records this exact deviation); Task 4.5 debrief (`src/services/pdf.service.js`'s own top-of-file comment records five separate instances of the same class of gap); Standing Rule 10.
