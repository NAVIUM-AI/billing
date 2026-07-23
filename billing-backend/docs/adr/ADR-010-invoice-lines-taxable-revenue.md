# ADR-010: Invoice lines carry only taxable service revenue; reimbursements live on invoice-level columns

_Last updated: 2026-07-23. Reviewers: TBD._

## Status

Accepted (Task 4.1).

## Context

`trip_sheets.extras_amount_paise` (Module 3) means two different things depending on the trip's `service_type`, by `tripSheet.service.js#computeTripTotals`'s own design:

- **LOCAL**: extra-km charges plus extra-hour charges beyond a package's base allowance — genuinely taxable service revenue, the same category as the base package price itself.
- **OUTSTATION**: parking + permit + fasttag summed together — pure-agent reimbursements, non-taxable under Indian GST rules for amounts a service provider merely passes through on the customer's behalf rather than charges for its own service.

The Task 4.1 spec's own worked example for invoice-line construction said to copy `trip.extras_amount_paise` onto every invoice line unconditionally, regardless of `service_type`. Followed literally for an OUTSTATION trip, this would tax a pure-agent reimbursement as if it were service revenue — a genuine GST compliance defect, not a cosmetic rounding difference. The same spec's own worked example contradicts its own instruction once the arithmetic is checked: a Cauvery-reference OUTSTATION trip carrying a ₹2,440 fasttag charge is asserted to produce a line `subtotal_paise` of `8,975,000` (₹89,750) — base amount plus driver batta only, with no extras component — and the invoice-level total then adds that same ₹2,440 back in as a separate, invoice-level `fasttag_rupees` figure, positioned after the GST section in the grand-total formula. That only reconciles at all if the OUTSTATION trip's reimbursement-shaped "extras" never entered the taxable line amount in the first place.

## Decision

`invoice_lines.extras_amount_paise` receives `trip.extras_amount_paise` only when `trip.service_type === 'LOCAL'`. For an OUTSTATION trip, the invoice line's `extras_amount_paise` is `0`, and the trip's toll/parking/permit/fasttag figures are instead captured as `invoices`-level aggregate columns (summed across every trip on the invoice, with manual-override support — Task 4.2), added to the grand total *after* the GST computation, exactly where the reference invoice format places them (`invoice.service.js#buildInvoiceLines`, top-of-file comment).

## Consequences

Invoice lines strictly represent taxable service revenue in every case, so GST is computed cleanly on the line total with no manual carve-out logic needed inside the GST domain module itself — `computeGST` never has to know or care which trips contributed reimbursement-shaped charges. Reimbursements render as pure-agent charges, correctly excluded from the taxable base, matching both the legal requirement and the client's own reference PDF layout.

The cost is that invoice-line construction has a `service_type`-dependent branch (`buildInvoiceLines`) rather than a single unconditional field copy — a small, permanent piece of conditional logic that has to be understood correctly by anyone touching that function later, and one more place a future change to Module 3's own `extras_amount_paise` semantics would need to be cross-checked against.

## References

Task 4.1 debrief; `src/services/invoice.service.js`'s own top-of-file comment (documents this exact deviation and the reconciling arithmetic); the Cauvery reference invoice (`PTT/2026-27/150`-family documents this module's PDF templates, Task 4.5, were built against).
