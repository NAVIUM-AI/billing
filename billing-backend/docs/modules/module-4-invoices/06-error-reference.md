# Error code reference

_Last updated: 2026-07-23. Reviewers: TBD._

Every `apiError(...)` call site in `src/services/invoice.service.js`, `src/services/payment.service.js`, `src/services/pdf.service.js`, `src/services/pdfEngine.service.js`, `src/repositories/invoice.repository.js`, `src/repositories/invoiceLine.repository.js`, `src/repositories/creditNote.repository.js`, `src/repositories/payment.repository.js`, `src/validators/invoice.validator.js`, and `src/validators/payment.validator.js` (which raises none of its own — Joi failures are wrapped into `VALIDATION_ERROR` by the shared `validate` middleware), verified by grepping every file for `apiError(status, "CODE"` (multi-line-aware, since several call sites wrap their arguments across lines) and cross-checking the result set is exhaustive. Every error response follows `{ "error": { "code", "message", "details"? } }` (`src/middleware/errorHandler.js`).

## Module 4 specific error codes

| Code | HTTP | When it fires | Where (file) | Fix |
| --- | --- | --- | --- | --- |
| `ADVANCE_CUSTOMER_MISMATCH` | 400 | The advance named in `apply-advance` belongs to a different customer than the target invoice | `payment.service.js` (`applyAdvanceToInvoice`) | Use an advance belonging to the same customer as the invoice |
| `ADVANCE_NOT_ACTIVE` | 400 | The advance named in `apply-advance` has already been cancelled | `payment.service.js` (`applyAdvanceToInvoice`) | Choose a different, still-`RECORDED` advance |
| `ADVANCE_NOT_FOUND` | 404 | `advance_payment_id` doesn't resolve to any payment for this tenant | `payment.service.js` (`applyAdvanceToInvoice`) | Verify the id |
| `APPLY_AMOUNT_INVALID` | 400 | The computed apply amount (after clamping to the advance balance and the invoice's outstanding) is `<= 0` | `payment.service.js` (`applyAdvanceToInvoice`) | Should only happen if the invoice is already fully paid — see `INVOICE_ALREADY_FULLY_PAID`, which fires first in the normal case |
| `CREDIT_NOTE_NOT_FOUND` | 404 | `creditNoteId` doesn't exist, or belongs to a different tenant | `invoice.service.js` (`getCreditNote`), `pdf.service.js` (both credit-note PDF functions) | Verify the id and tenant |
| `CREDIT_NOTE_NUMBER_COLLISION` | 409 | The DB unique constraint `credit_notes_number_per_tenant_unique` fires — should never happen under normal operation, since `credit_note_number_sequences`' atomic allocation guarantees a fresh number every time | `creditNote.repository.js` (`insert`) | Retry; if this recurs, it's a sequence-allocation bug, not routine contention |
| `CUSTOMER_MISMATCH` | 400 | One of the requested `trip_sheet_ids` belongs to a different customer than `customer_id` | `invoice.service.js` (`resolveTripsForInvoice`, used by both create and update) | `error.details.trip_id`/`trip_customer_id`/`invoice_customer_id` name the mismatch |
| `EMPTY_PATCH` | 400 | A PATCH body, after the repository's own updatable-column whitelist is applied, contains zero updatable keys | `invoice.repository.js` (`updateDraft`), `invoiceLine.repository.js` (`updateLine`) | In practice unreachable from a real request — both validator schemas already reject an empty/unrecognized body at the Joi layer first |
| `INVALID_GST_INPUT` | 400 | `computeGST` (the pure GST domain module) throws `DomainInputError` while creating or editing a TAX invoice | `invoice.service.js` (`computeInvoiceFinancials`) | `error.details.field`/`reason` name the exact input at fault (ADR-006's translation pattern) |
| `INVALID_INVOICE_STATE_TRANSITION` | 409 | A requested status transition isn't legal per `src/domain/invoiceLifecycle`'s `TRANSITIONS` map | `invoice.service.js` (`assertInvoiceTransition`, used by `issueInvoice`/`cancelInvoice`) | `error.details.allowed_transitions` lists what WOULD have worked from `error.details.current_status` |
| `INVOICE_ALREADY_FULLY_PAID` | 400 | `apply-advance` targets an invoice whose outstanding balance is already `<= 0` | `payment.service.js` (`applyAdvanceToInvoice`) | Nothing left to apply an advance toward; the advance remains available for a different invoice |
| `INVOICE_DATE_INVALID` | 400 | `invoice_date` is in the future, or more than 30 days in the past | `invoice.service.js` (`createDraftInvoice`) | Adjust `invoice_date` |
| `INVOICE_HAS_NO_LINES` | 400 | PDF generation was requested for an invoice with zero `invoice_lines` rows | `pdf.service.js` (`pickInvoiceTemplateName`) | Should not occur for any invoice that passed through normal creation (`trip_sheet_ids` requires `min(1)`); investigate if seen |
| `INVOICE_NOT_DELETABLE` | 409 | `DELETE /invoices/:id` targets a non-DRAFT invoice | `invoice.service.js` (`deleteDraftInvoice`) | Only DRAFT invoices can be deleted; cancel an issued one instead |
| `INVOICE_NOT_EDITABLE` | 409 | `PATCH /invoices/:id` or `PATCH .../lines/:lineId` targets a non-DRAFT invoice | `invoice.service.js` (`updateDraftInvoice`, `updateInvoiceLine`) | `error.details.current_status` names the actual status |
| `INVOICE_NOT_FOUND` | 404 | `invoiceId` doesn't exist, or belongs to a different tenant (indistinguishable by design) | `invoice.service.js` (every function resolving an invoice by id), `payment.service.js`, `pdf.service.js` | Verify the id and tenant |
| `INVOICE_NOT_ISSUED` | 400 | PDF generation was requested for a DRAFT invoice | `pdf.service.js` (`generateInvoicePdf`) | `error.details.current_status`; issue the invoice first |
| `INVOICE_NUMBER_COLLISION` | 409 | The DB unique constraint `invoices_number_per_tenant_unique` fires — should never happen under normal operation | `invoice.repository.js` (`transitionStatus`) | Retry; if this recurs, it's a sequence-allocation bug |
| `INVOICE_STATUS_CHANGED` | 409 | `issueInvoice`/`cancelInvoice`'s guarded `UPDATE ... WHERE status = $from` matched zero rows — someone else transitioned the invoice between the row-lock read and the write. Defensive; should not occur given the row lock | `invoice.service.js` | Reload the invoice and retry the intended transition |
| `INVOICE_STATUS_CHANGED_DURING_UPDATE` | 409 | Same defensive case, for `PATCH /invoices/:id` and `PATCH .../lines/:lineId` specifically | `invoice.service.js` (`updateDraftInvoice`, `updateInvoiceLine`) | Reload and retry the edit |
| `LINE_NOT_FOUND` | 404 | `lineId` doesn't resolve to a line on the named invoice | `invoice.service.js` (`updateInvoiceLine`) | Verify both ids |
| `PAYMENT_ALREADY_CANCELLED` | 409 | `POST /payments/:id/cancel` targets a payment that isn't `RECORDED` anymore | `payment.service.js` (`cancelPayment`) | A payment can only be cancelled once |
| `PAYMENT_NOT_ALLOWED_STATE` | 400 | A payment or advance-application was attempted against an invoice that's DRAFT or CANCELLED | `payment.service.js` (`recordPaymentOnInvoice`, `applyAdvanceToInvoice`) | `error.details.current_status`; only ISSUED/PAID invoices accept payments |
| `PAYMENT_NOT_AN_ADVANCE` | 400 | `advance_payment_id` names a payment that's already tied to an invoice (`invoice_id` not null) | `payment.service.js` (`applyAdvanceToInvoice`) | Only an unallocated advance (`invoice_id IS NULL`) can be applied |
| `PAYMENT_NOT_FOUND` | 404 | `paymentId` doesn't exist, or belongs to a different tenant | `payment.service.js` (`getPayment`, `cancelPayment`, `applyAdvanceToInvoice`) | Verify the id and tenant |
| `PAYMENT_REFERENCE_DUPLICATE` | 409 | `idx_payments_ref_unique` fires — the same `(payment_mode, reference_number)` is already recorded and active for this tenant | `payment.repository.js` (`insert`) | This is the idempotency guard doing its job — check whether this payment was already recorded before retrying |
| `PDF_FILE_MISSING` | 500 | `pdf_url` is set on the invoice/credit-note record, but the file itself is missing from `PDF_STORAGE_ROOT` | `pdf.service.js` (`getInvoicePdfBuffer`, `getCreditNotePdfBuffer`) | A genuine data-integrity gap (the file was deleted, moved, or the server changed) — see `07-debugging-playbook.md`; regenerate via `POST .../pdf` |
| `PDF_NOT_GENERATED` | 404 | `GET .../pdf` was called before any `POST .../pdf` for this document | `pdf.service.js` (`getInvoicePdfBuffer`, `getCreditNotePdfBuffer`) | Call `POST .../pdf` first |
| `PDF_RENDER_FAILED` | 500 | Puppeteer's `page.pdf()` call itself threw (browser crash, page timeout) | `pdf.service.js` (`renderPdf`) — translated from a raw Puppeteer exception per Rule 5, never leaked as an uncoded 500 | Retry; if persistent, check the Puppeteer/Chrome process is healthy (`07-debugging-playbook.md`) |
| `PDF_TEMPLATE_ERROR` | 500 | The named Handlebars template file couldn't be loaded, or threw while rendering with the given context | `pdf.service.js` (`renderPdf`) | Should not occur in normal operation — indicates a missing/broken template file, a code bug |
| `REFERENCE_REQUIRED` | 400 | A non-`CASH` payment was recorded without `reference_number` — defense-in-depth; Joi's own conditional `.when()` already rejects this at the validator layer | `payment.service.js` (`normalizePaymentInput`) | Supply `reference_number` for any non-CASH payment mode |
| `TRIP_ALREADY_HELD` | 409 | One of the requested `trip_sheet_ids` is `FINALIZED` but already held by a DIFFERENT invoice | `invoice.service.js` (`resolveTripsForInvoice`) | `error.details.held_by_invoice_id` names the other invoice; remove the trip from that draft first, or pick a different trip |
| `TRIP_ALREADY_ON_INVOICE` | 409 | The DB unique constraint `invoice_lines_trip_per_invoice_unique` fires — should not occur given `resolveTripsForInvoice`'s own pre-check | `invoiceLine.repository.js` (`insertBatch`) | Indicates a race the application-layer check didn't catch; investigate if seen |
| `TRIP_NOT_FINALIZED` | 400 | One of the requested `trip_sheet_ids` exists but isn't `FINALIZED` yet | `invoice.service.js` (`resolveTripsForInvoice`) | `error.details.current_status`; finalize the trip first (Module 3) |

## Codes shared with Module 3

Raised directly by Module 4 code resolving a trip, or by Module 3's own `tripSheet.service.js` functions Module 4 calls from inside its own transactions (`markTripsInvoiced`, `reverseTripInvoiced`) — full definitions are in `docs/modules/module-3-trip-sheets/06-error-reference.md`.

| Code | HTTP | When it fires in Module 4 |
| --- | --- | --- |
| `TRIP_NOT_FOUND` | 404 | A `trip_sheet_ids` entry doesn't resolve to any trip in the tenant (`invoice.service.js#resolveTripsForInvoice`); also surfaced defensively from `markTripsInvoiced`/`reverseTripInvoiced` if a trip vanished between the invoice's own row lock and the trip update, which shouldn't happen given the transaction boundary |
| `TRIP_STATUS_CHANGED` | 409 | Defensive — `markTripsInvoiced`/`reverseTripInvoiced`'s guarded trip-status `UPDATE` matched zero rows during issue/cancel. Should not occur given the invoice's own row lock covers the whole transaction |

## Codes shared with Module 2

Reused directly by `POST /customers/quick-create` (Task 4.6), which delegates to the same `customerRepository.insert` path `POST /customers` uses — full definitions are in `docs/modules/module-2-master-data/06-error-reference.md`.

| Code | HTTP | When it fires for quick-create |
| --- | --- | --- |
| `CUSTOMER_NOT_FOUND` | 404 | `customer_id` on any invoice/payment/ledger endpoint doesn't resolve to an active customer in the tenant |
| `B2B_REQUIRED_FIELDS` | 400 | A B2B quick-create was attempted without a `gstin` — the DB's own `customers_b2b_required_fields` CHECK, unbypassable from the application layer (see `05-design-decisions.md`) |
| `CUSTOMER_ARCHIVED_EXISTS` | 409 | The supplied `gstin`/`phone` matches an archived (not active) customer | `error.details.customerId` names it — reactivate instead of creating a duplicate |
| `CUSTOMER_GSTIN_ALREADY_EXISTS` / `CUSTOMER_PHONE_ALREADY_EXISTS` | 409 | The supplied `gstin`/`phone` matches an ACTIVE customer already |

## Codes shared with Module 1

Every Module 4 endpoint requires authentication and a tenant context. Full definitions are in `docs/modules/module-2-master-data/06-error-reference.md`, which documents them as **(shared)** entries.

| Code | HTTP | When it fires |
| --- | --- | --- |
| `AUTH_REQUIRED` | 401 | No `Authorization` header |
| `ACCESS_TOKEN_EXPIRED` | 401 | The JWT access token's `exp` has passed |
| `FORBIDDEN` | 403 | The authenticated user's role isn't listed for the required permission key (`error.details.required` names it) |
| `VALIDATION_ERROR` | 400 | Any Joi schema validation failure across every Module 4 validator |
| `NOT_FOUND` | 404 | No route matches the request path at all |
