# Architecture

_Last updated: 2026-07-23. Reviewers: TBD._

## Layered flow

Module 4 follows the same layering every earlier module established, with two more pure domain modules added alongside `src/domain/pricing/` and `src/domain/tripLifecycle/`.

```
HTTP → Route → Validator → Service → Repository → SQL
                  │           │           │
                  ▼           ▼           ▼
               Joi schema  Business    Postgres +
                           rules,      RLS
                           domain
                           calls
```

`src/api/v1/invoices.routes.js`, `creditNotes.routes.js`, `payments.routes.js`, and `reports.routes.js` are thin — `authenticate` + `tenantContext` + `requirePermission(key)` + `validate(schema)` in front of a handler that calls a service function and shapes the response. Cross-field rules that need live database state (a trip's actual status, an invoice's actual outstanding balance) live in the service layer, never the validator, per the service-order rule every module in this codebase follows: normalize → derive → validate → check → write, with "check" and "write" happening together inside one `db.withTenantContext` transaction whenever a mutation touches more than one thing that must succeed or fail as a unit.

## Two more pure domain modules

`src/domain/invoiceLifecycle/` (Task 4.3) is the invoice-status equivalent of Module 3's `src/domain/tripLifecycle/` — a `TRANSITIONS` map of `Set`s (`DRAFT → {ISSUED, CANCELLED}`, `ISSUED → {PAID, CANCELLED}`, `PAID → {CANCELLED, ISSUED}`, `CANCELLED` terminal) with `isValidTransition`/`allowedTransitions` helpers, zero framework imports. `src/domain/gst/` (Task 4.1) is a pure calculator: `computeGST` (CGST/SGST vs IGST split from a taxable amount, rate, and same-state boolean), `computeRoundOff` (grand total → nearest whole rupee, Indian invoice convention), and `isSameState` (a defensive string comparison that defaults to intra-state when either state code is missing — safer for tax compliance than silently assuming inter-state on unknown data). Both modules throw their own dependency-free error class on invalid input (`DomainInputError`, shared with the pricing module) and are translated to an HTTP-shaped `apiError` only at the service boundary, continuing ADR-006's pattern.

## Snapshot-at-issue pattern

`invoices.tenant_snapshot`/`customer_snapshot` (JSONB, both `NULL` in `DRAFT`) are populated exactly once, by `invoiceRepo.transitionStatus`'s `COALESCE`-based `UPDATE` at the moment of issue (`invoice.service.js#issueInvoice`), built by `src/utils/invoiceSnapshot.js#buildTenantSnapshot`/`buildCustomerSnapshot`. Because the `UPDATE` uses `COALESCE(newValue, existingValue)`, a snapshot column that already holds a value is never overwritten by a later call — there is no code path anywhere that re-issues or re-snapshots an already-`ISSUED` invoice. `credit_notes` snapshots independently, at cancellation time, using the same two builder functions against the tenant/customer's state *as of cancellation* — deliberately not copied forward from the original invoice's older snapshot, since a credit note is itself a new legal document dated at the moment it's created.

The snapshot builders are narrower than a first reading of "capture the tenant's business info" might suggest, and deliberately so: `tenants` has no address/phone/email/website columns at all, and a customer's address is one nested `address` JSONB blob, not flat columns. `buildCustomerSnapshot` reads the nested column but writes a flat shape into the snapshot (sensible for a template to consume later); `buildTenantSnapshot` simply omits fields that don't exist rather than writing them as permanent `null`s that look like a real gap. See `05-design-decisions.md` and ADR-014.

## State machines and how they interlock

`src/domain/invoiceLifecycle/` and Module 3's `src/domain/tripLifecycle/` are two independent state machines that must move in lockstep at exactly two moments: issue and cancel-of-an-issued-invoice. `issueInvoice` (inside one transaction) allocates the invoice number, freezes both snapshots, transitions the invoice `DRAFT → ISSUED`, and calls `tripSheet.service.js#markTripsInvoiced` to move every trip on the invoice `FINALIZED → INVOICED` — all four effects commit or roll back together. `cancelInvoice`, when cancelling an `ISSUED`/`PAID` invoice, does the mirror image: creates the credit note, transitions the invoice to `CANCELLED`, and calls `tripSheet.service.js#reverseTripInvoiced` to move every one of its trips back `INVOICED → FINALIZED` (re-invoiceable). Module 3's own trip-lifecycle map had to be extended for this — `INVOICED` was originally shipped terminal (Task 3.3), on the assumption the reversal would be purely an invoice-level concern, and Task 4.3 found that assumption wrong: the trip's *own* state machine has to legally allow the transition too, regardless of which module triggers it.

`ISSUED ↔ PAID` is the third pair of transitions in the invoice's own state machine, and neither direction is ever set directly by a caller — both are *derived*, recomputed from a fresh sum of `RECORDED` payments every time a payment is recorded, cancelled, or an advance applied (Task 4.4; see the "Payments derivation" section below and Rule 12's "the state machine encodes every legal transition, including derived ones" principle).

## Numbering

`src/utils/invoiceNumber.js#allocateInvoiceNumber`/`allocateCreditNoteNumber` reuse Module 3's Task 3.1 atomic UPSERT-plus-`xmax` pattern exactly (`tripSheetSequence.repository.js#allocateSeq`), including its `xmax::text::int > 0` cast — `xmax` is Postgres' `xid` system type, which has no `=` operator against a plain integer, so a naive `WHEN xmax = 0` comparison fails at the SQL level; casting through `text` first is the already-proven-working fix. Invoices and credit notes each have their own `_number_sequences` table, keyed `(tenant_id, invoice_type, fiscal_year)` and `(tenant_id, fiscal_year)` respectively — `TAX` and `PERFORMANCE` invoices draw from independent sequences even within the same tenant and fiscal year, since they use different prefixes (`tenants.invoice_prefix` vs `performance_prefix`) and Indian GST law only requires *tax* invoice numbering to be gap-free, though this codebase applies the same discipline to `PERFORMANCE` and credit-note numbering too, for consistency. A failed issue never consumes a number, because the allocation only runs inside the same transaction as the status change, after every prior check has already passed.

## Trip hold mechanism

`trip_sheets.held_by_invoice_id` (added by Task 4.1's migration) prevents two DRAFT invoices from concurrently claiming the same `FINALIZED` trip. `resolveTripsForInvoice` (`invoice.service.js`) only accepts a trip that's either unheld or held by the *same* invoice currently being edited (the `excludeInvoiceId` parameter) — so re-saving a draft that already holds trip X doesn't spuriously reject X as "held by someone else." The hold is set on draft create/edit (`tripRepo.setHold`) and released either when a draft is deleted, when its trip set changes (old trips released before new ones are re-validated and re-held), or when the invoice is issued — at which point the trips move to `INVOICED` status and the hold itself becomes redundant, since an `INVOICED` trip's own status already makes it ineligible for a new invoice.

## GST calculation

`computeInvoiceFinancials` (`invoice.service.js`) is the single function both `createDraftInvoice` and `updateDraftInvoice` call for every derived financial column — discount → taxable amount → GST (TAX invoices only) → grand total → round-off → amount-in-words — so the two entry points can never drift apart on the arithmetic. GST itself only ever runs for `invoice_type === 'TAX'`; a `PERFORMANCE` invoice's GST columns are hardcoded to zero and the database itself enforces this via `invoices_perf_no_gst`, a CHECK constraint independent of anything the application does. `gst_rate_snapshot` freezes the tenant's `gst_rate` at invoice-creation time and is never implicitly re-derived from the tenant's *current* setting on a later edit — the same "never an implicit re-lookup" discipline Module 3's `resolveRuleForRecompute` already established for a trip's pricing rule.

## Payments derivation

`payment.service.js#maybeTransitionToPaid` re-queries the sum of `RECORDED` payments against an invoice fresh, every time it's called, rather than trusting a caller-computed delta — correct regardless of which of `recordPaymentOnInvoice`'s three branches (full payment, split over-payment, pure-advance-because-already-fully-paid) actually ran. The mirror-image reversal (`cancelPayment`, when cancelling a payment drops the cumulative total back below `net_payable_paise`) works the same way. Over-payment on an invoice auto-splits: the outstanding portion applies to the invoice, the excess becomes a new unallocated advance on the same customer, linked back via `parent_payment_id` for audit — see `05-design-decisions.md` for why, and ADR-013 for the synthetic-reference-uniqueness problem this split created and how it was solved.

## PDF rendering

`src/services/pdfEngine.service.js` keeps one Puppeteer browser instance alive for the app's lifetime (launch is the expensive part; individual pages are cheap) and compiles Handlebars templates once per `(name, version)`, cached thereafter. Templates live under `src/templates/pdf/v1.0.0/`, one directory per template version — a layout change bumps the directory, but `pdf.service.js` always renders an already-issued document with the template version *stored on that record* (`pdf_template_version`), not the current default, so a historical PDF never silently changes appearance after the fact. The render context is built directly from `invoice.tenant_snapshot`/`customer_snapshot` (or the credit note's own snapshots) rather than a fresh tenant/customer lookup — since PDF generation is only ever legal on a non-`DRAFT` document, the snapshot is guaranteed present and is exactly "state as of issue," which is what a legal document is supposed to show regardless of what the live tenant/customer record says today. See ADR-015 for why this module's own PDF work required an explicit visual-review step beyond automated generation checks.
