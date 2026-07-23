# API reference

_Last updated: 2026-07-23. Reviewers: TBD._

All endpoints below require `Authorization: Bearer <accessToken>`. Invoice/credit-note endpoints are mounted under `/api/v1/invoices` and `/api/v1/credit-notes` (`src/api/v1/invoices.routes.js`, `creditNotes.routes.js`); payment endpoints under `/api/v1/payments` plus two routes nested under `/invoices`/`/customers`; the aging report under `/api/v1/reports`; quick-create under `/api/v1/customers`. Every route runs `authenticate` then `tenantContext` before any permission check. Permission keys are checked against `src/config/accessMatrix.js`; a role not listed for a given key gets `403 FORBIDDEN` with `error.details.required` naming the key. Full error code definitions are in `06-error-reference.md`.

## Summary

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/invoices` | `invoices:draft` | Create a DRAFT invoice from one or more FINALIZED trips |
| `GET` | `/api/v1/invoices/:invoiceId` | `invoices:read` | Fetch one invoice with lines, customer, tenant refs |
| `PATCH` | `/api/v1/invoices/:invoiceId` | `invoices:draft` | Edit a DRAFT invoice |
| `DELETE` | `/api/v1/invoices/:invoiceId` | `invoices:draft` | Delete a DRAFT invoice |
| `POST` | `/api/v1/invoices/:invoiceId/issue` | `invoices:issue` | `DRAFT → ISSUED` |
| `POST` | `/api/v1/invoices/:invoiceId/cancel` | `invoices:cancel` | `DRAFT/ISSUED/PAID → CANCELLED` |
| `PATCH` | `/api/v1/invoices/:invoiceId/lines/:lineId` | `invoices:draft` | Edit a line's description (DRAFT only) |
| `GET` | `/api/v1/customers/:customerId/invoiceable-trips` | `invoices:draft` | The checkbox picker for building `trip_sheet_ids` |
| `POST` | `/api/v1/invoices/:invoiceId/payments` | `payments:record` | Record a payment against a specific invoice |
| `POST` | `/api/v1/invoices/:invoiceId/apply-advance` | `payments:record` | Apply an existing unallocated advance to an invoice |
| `POST` | `/api/v1/customers/:customerId/advances` | `payments:record` | Record a standalone advance, not tied to any invoice |
| `GET` | `/api/v1/customers/:customerId/ledger` | `payments:read` | Full statement: every non-DRAFT invoice + every RECORDED payment |
| `GET` | `/api/v1/payments` | `payments:read` | List payments with filters |
| `GET` | `/api/v1/payments/:paymentId` | `payments:read` | Fetch one payment |
| `POST` | `/api/v1/payments/:paymentId/cancel` | `payments:cancel` | The only way to reverse a payment |
| `GET` | `/api/v1/reports/receivables-aging` | `reports:read` | Outstanding ISSUED invoices bucketed by days overdue |
| `POST` | `/api/v1/invoices/:invoiceId/pdf` | `invoices:read` | Generate (or regenerate) the invoice's PDF |
| `GET` | `/api/v1/invoices/:invoiceId/pdf` | `invoices:read` | Download the generated PDF |
| `GET` | `/api/v1/credit-notes` | `invoices:read` | List credit notes |
| `GET` | `/api/v1/credit-notes/:creditNoteId` | `invoices:read` | Fetch one credit note |
| `POST` | `/api/v1/credit-notes/:creditNoteId/pdf` | `invoices:read` | Generate (or regenerate) the credit note's PDF |
| `GET` | `/api/v1/credit-notes/:creditNoteId/pdf` | `invoices:read` | Download the generated credit-note PDF |
| `POST` | `/api/v1/customers/quick-create` | `customers:write` | Minimal-field customer creation for an inline modal |

There is no `GET /invoices` list endpoint in this module — invoice listing/search is not built (`TODO` for a future task).

## Invoice creation

### POST /api/v1/invoices

**Permission:** `invoices:draft`
**Purpose:** Create a new invoice in `DRAFT` status from one or more already-`FINALIZED`, unheld trips belonging to the same customer.

**Body** (`createInvoiceSchema`, `src/validators/invoice.validator.js`):

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `invoice_type` | string | yes | `TAX` or `PERFORMANCE` |
| `customer_id` | UUID | yes | Must be an active customer |
| `trip_sheet_ids` | array of UUID | yes | `min(1)`, `max(50)`. Every trip must be `FINALIZED`, unheld (or held by no invoice yet), and belong to `customer_id` |
| `invoice_date` | string | no | `YYYY-MM-DD`; defaults to today; cannot be future or more than 30 days past |
| `due_date` | string | no | Defaults to `invoice_date + customer.credit_days`; must be `>= invoice_date` |
| `notes` / `terms` | string | no | |
| `discount_rupees` | number | no | `>= 0`, `<= 1,000,000` |
| `discount_reason` | string | no | |
| `toll_rupees` / `parking_rupees` / `permit_rupees` / `fasttag_rupees` | number | no | `>= 0`. An explicit value here — including an explicit `0` — sets that field's manual-override flag (Task 4.2); omitted fields auto-sum from the selected trips |

**Response 201:**

```json
{
  "invoice": {
    "id": "...", "invoice_number": null, "invoice_type": "TAX", "status": "DRAFT",
    "customer_id": "...", "invoice_date": "2026-07-20", "due_date": "2026-08-04",
    "subtotal_paise": 483800, "gst_rate_snapshot": 5,
    "cgst_paise": 12095, "sgst_paise": 12095, "igst_paise": 0, "total_gst_paise": 24190,
    "toll_paise": 0, "parking_paise": 0, "permit_paise": 0, "fasttag_paise": 0,
    "discount_paise": 0, "round_off_paise": 10, "grand_total_paise": 507990,
    "net_payable_paise": 508000, "amount_in_words": "Rupees Five Thousand Eighty Only",
    "tenant_snapshot": null, "customer_snapshot": null, "issued_at": null,
    "lines": [ { "id": "...", "line_number": 1, "line_amount_paise": 483800, "description": "..." } ]
  }
}
```

**Error codes:** `400 VALIDATION_ERROR`, `400 INVOICE_DATE_INVALID`, `400 INVALID_GST_INPUT`, `404 CUSTOMER_NOT_FOUND`, `404 TRIP_NOT_FOUND`, `400 TRIP_NOT_FINALIZED`, `409 TRIP_ALREADY_HELD`, `400 CUSTOMER_MISMATCH`.

## Invoice retrieval

### GET /api/v1/invoices/:invoiceId

**Permission:** `invoices:read`
**Purpose:** Fetch one invoice with its lines and lightweight customer/tenant reference objects (not the full records — see `shapeCustomerRef`/`shapeTenantRef` in `invoice.service.js`).

**Response 200:** `{ "invoice": { "...": "all invoices columns", "lines": [ "..." ], "customer": { "id", "customer_type", "name", "company_name", "gstin", "state_code" }, "tenant": { "id", "name", "gstin", "state_code" } } }`.

**Error codes:** `400 VALIDATION_ERROR` (malformed UUID), `404 INVOICE_NOT_FOUND`.

## Invoice editing (DRAFT)

### PATCH /api/v1/invoices/:invoiceId

**Permission:** `invoices:draft`
**Purpose:** Edit a DRAFT invoice. Every field is optional; sending `trip_sheet_ids` REPLACES the trip set entirely (not a merge). Every derived financial column is always recomputed as a group, never patched independently.

**Body** (`updateInvoiceSchema`): same fields as create except `invoice_type`/`customer_id` (immutable, `.unknown(false)` rejects an attempt to send them rather than silently stripping). At least one field required.

**Response 200:** same shape as `GET /invoices/:invoiceId` (minus the `customer`/`tenant` reference objects, which only `GET`/issue attach).

**Error codes:** `400 VALIDATION_ERROR`, `400 INVALID_GST_INPUT`, `403 FORBIDDEN`, `404 INVOICE_NOT_FOUND`, `404 TRIP_NOT_FOUND`, `400 TRIP_NOT_FINALIZED`, `409 TRIP_ALREADY_HELD`, `400 CUSTOMER_MISMATCH`, `409 INVOICE_NOT_EDITABLE` (not DRAFT), `409 INVOICE_STATUS_CHANGED_DURING_UPDATE` (defensive).

### DELETE /api/v1/invoices/:invoiceId

**Permission:** `invoices:draft`
**Purpose:** Delete a DRAFT invoice. Cascades to `invoice_lines` and releases every trip hold — no manual cleanup needed.

**Response 200:** `{ "deleted": true, "id": "..." }`.

**Error codes:** `404 INVOICE_NOT_FOUND`, `409 INVOICE_NOT_DELETABLE` (not DRAFT).

## Invoice lifecycle transitions

### POST /api/v1/invoices/:invoiceId/issue

**Permission:** `invoices:issue`
**Purpose:** `DRAFT → ISSUED`. Allocates the gap-free invoice number, freezes `tenant_snapshot`/`customer_snapshot`, transitions every trip on the invoice `FINALIZED → INVOICED` — all in one transaction.

**Body:** none (`issueInvoiceSchema` is `{}` with `.unknown(false)` — a stray key is rejected, not silently dropped).

**Response 200:** `{ "invoice": { "...": "...", "status": "ISSUED", "invoice_number": "PRA-1/26-27", "issued_at": "...", "tenant_snapshot": { "..." }, "customer_snapshot": { "..." }, "lines": [ "..." ] } }`.

**Error codes:** `403 FORBIDDEN`, `404 INVOICE_NOT_FOUND`, `409 INVALID_INVOICE_STATE_TRANSITION` (not DRAFT), `409 INVOICE_NUMBER_COLLISION` (should not occur under normal operation), `409 INVOICE_STATUS_CHANGED` (defensive — see `07-debugging-playbook.md`).

### POST /api/v1/invoices/:invoiceId/cancel

**Permission:** `invoices:cancel`
**Purpose:** `DRAFT`, `ISSUED`, or `PAID` `→ CANCELLED`. Terminal. A DRAFT cancel is a plain status flip (no credit note — the invoice was never legally issued); an ISSUED/PAID cancel additionally creates a credit note and reverses every trip on the invoice back to `FINALIZED`.

**Body** (`cancelInvoiceSchema`): `reason` (string, trimmed, 3-500 chars, required).

**Response 200:** `{ "invoice": { "...", "status": "CANCELLED", "credit_note_id": null | "..." }, "credit_note": null | { "id", "credit_note_number", "..." } }`.

**Error codes:** `400 VALIDATION_ERROR` (missing/short reason), `403 FORBIDDEN`, `404 INVOICE_NOT_FOUND`, `409 INVALID_INVOICE_STATE_TRANSITION` (already CANCELLED), `409 CREDIT_NOTE_NUMBER_COLLISION`, `409 INVOICE_STATUS_CHANGED`.

## Line description editing

### PATCH /api/v1/invoices/:invoiceId/lines/:lineId

**Permission:** `invoices:draft`
**Purpose:** Edit a single line's `description` — the only editable field on a line; every trip-derived amount stays a frozen snapshot. DRAFT-only.

**Body** (`updateLineSchema`): `description` (string, trimmed, 1-500 chars, required).

**Response 200:** `{ "line": { "id", "line_number", "description", "...": "every other invoice_lines column, unchanged" } }`.

**Error codes:** `400 VALIDATION_ERROR`, `403 FORBIDDEN`, `404 INVOICE_NOT_FOUND`, `404 LINE_NOT_FOUND`, `409 INVOICE_NOT_EDITABLE`, `409 INVOICE_STATUS_CHANGED_DURING_UPDATE`.

## Invoiceable trips picker

### GET /api/v1/customers/:customerId/invoiceable-trips

**Permission:** `invoices:draft`
**Purpose:** The checkbox picker a client uses to build `POST /invoices`' `trip_sheet_ids` — every `FINALIZED`, unheld trip for one customer, grouped by `service_type`, with per-group and overall summaries.

**Query params:** `invoice_id` (UUID, optional) — when editing an existing draft, include trips already held by THAT invoice so they still appear as selectable.

**Response 200:**

```json
{
  "customer": { "id", "name", "company_name", "customer_type", "gstin", "state_code", "credit_days" },
  "groups": {
    "LOCAL": { "trips": [ "..." ], "summary": { "count", "total_km", "total_subtotal_paise", "total_gross_paise", "total_net_payable_paise" } },
    "OUTSTATION": { "trips": [ "..." ], "summary": { "...": "same shape" } }
  },
  "total_summary": { "...": "same shape, across both groups" }
}
```

**Error codes:** `400 VALIDATION_ERROR`, `403 FORBIDDEN`, `404 CUSTOMER_NOT_FOUND`.

## Payments

### POST /api/v1/invoices/:invoiceId/payments

**Permission:** `payments:record`
**Purpose:** Record a payment against a specific invoice. Legal on `ISSUED` or `PAID` invoices (recording a further payment on an already-fully-paid invoice is allowed — it becomes a pure advance, see `05-design-decisions.md`).

**Body** (`recordPaymentSchema`, `src/validators/payment.validator.js`):

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `amount_rupees` | number | yes | Positive, `<= 10,000,000` |
| `payment_mode` | string | yes | `CASH` / `UPI` / `NEFT` / `RTGS` / `IMPS` / `CHEQUE` / `CARD` / `BANK_TRANSFER` |
| `reference_number` | string | conditional | Forbidden for `CASH`; required for every other mode |
| `received_at` | ISO datetime | no | Defaults to now; cannot be future or more than 90 days past |
| `notes` | string | no | |

**Response 201:** `{ "payment": { "...": "the applied-portion payments row" }, "spillover_advance": null | { "...": "a payments row, when the payment exceeded outstanding" }, "invoice_transitioned_to_paid": boolean }`.

**Error codes:** `400 VALIDATION_ERROR`, `400 REFERENCE_REQUIRED`, `400 PAYMENT_NOT_ALLOWED_STATE` (invoice is DRAFT or CANCELLED), `404 INVOICE_NOT_FOUND`, `409 PAYMENT_REFERENCE_DUPLICATE`.

### POST /api/v1/invoices/:invoiceId/apply-advance

**Permission:** `payments:record`
**Purpose:** Apply an existing unallocated advance (a `payments` row with `invoice_id IS NULL`) to a specific invoice. Supports partial consumption — an advance larger than the invoice's outstanding balance is only partly consumed, leaving the remainder available for a later application elsewhere.

**Body** (`applyAdvanceSchema`): `advance_payment_id` (UUID, required); `amount_rupees` (number, optional — when omitted, applies `min(advance amount, invoice outstanding)`).

**Response 200:** `{ "applied_payment_id": "...", "remaining_advance_id": null | "...", "invoice_transitioned_to_paid": boolean }`. `remaining_advance_id` is `null` when the advance was fully consumed (the row was reassigned, not duplicated); otherwise it names the still-active, decremented advance row.

**Error codes:** `400 VALIDATION_ERROR`, `400 PAYMENT_NOT_ALLOWED_STATE`, `400 PAYMENT_NOT_AN_ADVANCE` (the id names a payment already tied to an invoice), `400 ADVANCE_NOT_ACTIVE` (already cancelled), `400 ADVANCE_CUSTOMER_MISMATCH`, `400 INVOICE_ALREADY_FULLY_PAID`, `400 APPLY_AMOUNT_INVALID`, `404 INVOICE_NOT_FOUND`, `404 ADVANCE_NOT_FOUND`.

## Advance management

### POST /api/v1/customers/:customerId/advances

**Permission:** `payments:record`
**Purpose:** Record a standalone advance — money received from a customer with no specific invoice yet.

**Body:** same `recordPaymentSchema` as `POST /invoices/:id/payments`.

**Response 201:** `{ "payment": { "...": "invoice_id is null" } }`.

**Error codes:** `400 VALIDATION_ERROR`, `400 REFERENCE_REQUIRED`, `404 CUSTOMER_NOT_FOUND`, `409 PAYMENT_REFERENCE_DUPLICATE`.

### GET /api/v1/customers/:customerId/ledger

**Permission:** `payments:read`
**Purpose:** Full customer statement — every non-DRAFT invoice and every RECORDED payment, merged into one chronological, running-balance timeline.

**Response 200:**

```json
{
  "customer": { "id", "customer_type", "name", "company_name", "gstin", "state_code", "credit_days" },
  "summary": {
    "total_invoiced_paise": 508000, "total_paid_paise": 300000,
    "total_cancelled_paise": 0, "unallocated_advance_paise": 0,
    "outstanding_paise": 208000
  },
  "entries": [
    { "type": "INVOICE", "invoice_id", "invoice_number", "invoice_date", "due_date", "debit_paise": 508000, "status": "ISSUED", "running_balance_paise": 508000 },
    { "type": "PAYMENT", "payment_id", "invoice_id", "received_at", "credit_paise": 300000, "payment_mode", "reference_number", "running_balance_paise": 208000 }
  ]
}
```

A CANCELLED invoice still appears in `entries` (for audit) but contributes `0` debit — the whole point of cancelling one via credit note is that it no longer represents money owed.

**Error codes:** `400 VALIDATION_ERROR`, `403 FORBIDDEN`, `404 CUSTOMER_NOT_FOUND`.

## Payment cancellation

### GET /api/v1/payments

**Permission:** `payments:read`
**Purpose:** List payments with filters.

**Query params** (`listPaymentsQuerySchema`): `limit` (default 25), `offset`, `customer_id`, `invoice_id`, `payment_mode`, `status` (comma-separated `RECORDED`/`CANCELLED`, defaults to `RECORDED`-only in the service if omitted), `from_date`, `to_date`.

**Response 200:** `{ "payments": [ "..." ], "pagination": { "total", "limit", "offset", "has_more" } }`.

**Error codes:** `400 VALIDATION_ERROR`, `403 FORBIDDEN`.

### GET /api/v1/payments/:paymentId

**Permission:** `payments:read`
**Purpose:** Fetch one payment.

**Response 200:** `{ "payment": { "...": "every payments column" } }`.

**Error codes:** `400 VALIDATION_ERROR`, `404 PAYMENT_NOT_FOUND`.

### POST /api/v1/payments/:paymentId/cancel

**Permission:** `payments:cancel`
**Purpose:** The ONLY way to reverse a payment — there is no `DELETE`. If cancelling drops a `PAID` invoice's cumulative RECORDED total back below `net_payable_paise`, the invoice is automatically reverted `PAID → ISSUED`.

**Body** (`cancelPaymentSchema`): `reason` (string, trimmed, 3-500 chars, required).

**Response 200:** `{ "payment": { "...", "status": "CANCELLED" }, "invoice_reverted": boolean }`.

**Error codes:** `400 VALIDATION_ERROR`, `403 FORBIDDEN`, `404 PAYMENT_NOT_FOUND`, `409 PAYMENT_ALREADY_CANCELLED`.

## Reports

### GET /api/v1/reports/receivables-aging

**Permission:** `reports:read` (widened in Task 4.6 to include `viewer` — see `05-design-decisions.md`)
**Purpose:** Every outstanding `ISSUED` invoice, bucketed by days overdue relative to `due_date`.

**Query params** (`agingReportQuerySchema`): `as_of_date` (`YYYY-MM-DD`, optional, defaults to today).

**Response 200:**

```json
{
  "as_of_date": "2026-07-23",
  "summary": {
    "total_outstanding_paise": 1234500, "total_invoices": 4,
    "buckets_summary": {
      "CURRENT": { "count": 1, "total_paise": 300000 },
      "DAYS_1_30": { "count": 2, "total_paise": 700000 },
      "DAYS_31_60": { "count": 1, "total_paise": 234500 },
      "DAYS_61_90": { "count": 0, "total_paise": 0 },
      "DAYS_90_PLUS": { "count": 0, "total_paise": 0 }
    }
  },
  "buckets": {
    "CURRENT": { "count": 1, "total_paise": 300000, "entries": [ { "invoice_id", "invoice_number", "customer_id", "customer_name", "due_date", "net_payable_paise", "paid_paise", "outstanding_paise", "days_overdue" } ] },
    "DAYS_1_30": { "...": "same entry shape" }
  }
}
```

Only invoices with `outstanding_paise > 0` appear at all — a fully paid `ISSUED` invoice (rare, since full payment normally transitions it to `PAID`) or a `CANCELLED`/`DRAFT` invoice never shows up here.

**Error codes:** `400 VALIDATION_ERROR`, `403 FORBIDDEN`.

## PDF generation and download

### POST /api/v1/invoices/:invoiceId/pdf

**Permission:** `invoices:read`
**Purpose:** Generate (or regenerate — idempotent, overwrites the same file) the invoice's PDF. Only legal on a non-DRAFT invoice.

**Response 200:** `{ "pdf_url": "/pdf-storage/{tenantId}/invoices/{file}", "pdf_template_version": "v1.0.0", "pdf_file_size_bytes": 109604, "pdf_generated_at": "..." }`.

**Error codes:** `403 FORBIDDEN`, `404 INVOICE_NOT_FOUND`, `400 INVOICE_NOT_ISSUED` (still DRAFT), `400 INVOICE_HAS_NO_LINES`, `500 PDF_TEMPLATE_ERROR`, `500 PDF_RENDER_FAILED`.

### GET /api/v1/invoices/:invoiceId/pdf

**Permission:** `invoices:read`
**Purpose:** Download the generated PDF.

**Response 200:** `application/pdf` binary body; `Content-Disposition: attachment; filename="<invoice_number with / replaced by ->.pdf"`.

**Error codes:** `403 FORBIDDEN`, `404 INVOICE_NOT_FOUND`, `404 PDF_NOT_GENERATED` (POST hasn't been called yet), `500 PDF_FILE_MISSING` (registered in the DB but missing on disk — a data-integrity concern, see `07-debugging-playbook.md`).

## Credit notes

### GET /api/v1/credit-notes

**Permission:** `invoices:read`
**Purpose:** List credit notes for the tenant.

**Query params** (`listCreditNotesQuerySchema`): `limit` (default 25), `offset`.

**Response 200:** `{ "credit_notes": [ "..." ], "pagination": { "total", "limit", "offset", "has_more" } }`.

### GET /api/v1/credit-notes/:creditNoteId

**Permission:** `invoices:read`
**Purpose:** Fetch one credit note.

**Response 200:** `{ "credit_note": { "...": "every credit_notes column" } }`.

**Error codes (both above):** `400 VALIDATION_ERROR`, `404 CREDIT_NOTE_NOT_FOUND`.

### POST /api/v1/credit-notes/:creditNoteId/pdf

**Permission:** `invoices:read`
**Purpose:** Generate (or regenerate) the credit note's PDF.

**Response 200:** same shape as the invoice PDF-generation response.

**Error codes:** `403 FORBIDDEN`, `404 CREDIT_NOTE_NOT_FOUND`, `500 PDF_TEMPLATE_ERROR`, `500 PDF_RENDER_FAILED`.

### GET /api/v1/credit-notes/:creditNoteId/pdf

**Permission:** `invoices:read`
**Purpose:** Download the generated credit-note PDF.

**Error codes:** `403 FORBIDDEN`, `404 CREDIT_NOTE_NOT_FOUND`, `404 PDF_NOT_GENERATED`, `500 PDF_FILE_MISSING`.

## Customer quick-create

### POST /api/v1/customers/quick-create

**Permission:** `customers:write`
**Purpose:** A minimal-field customer creation path (Task 4.6) for an inline "new customer" modal during trip/invoice creation — a thin wrapper over the same insertion path `POST /customers` uses, with a narrower required-field list.

**Body** (`quickCreateCustomerSchema`, `src/validators/customer.validator.js`):

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `customer_type` | string | yes | `B2C` or `B2B` |
| `name` | string | yes | 2-255 chars. Used as the B2C display name AND, when `company_name` is omitted, the B2B company name default |
| `company_name` | string | no | 2-255 chars. Only meaningful for B2B; ignored for B2C |
| `gstin` | string | no | Format-validated when supplied. **Still required by the database for a B2B customer** — see `05-design-decisions.md`/ADR-014 for why "optional even for B2B" as originally specified isn't actually achievable here |
| `phone` | string | no | Same canonical/display normalization as `POST /customers` |
| `email` | string | no | |

`.unknown(false)` — there is no `state_code` field here at all; a supplied `gstin`'s leading digits are the only source `state_code` is derived from.

**Response 201:** `{ "customer": { "...": "every customers column" } }` — same shape as `POST /customers`.

**Error codes:** `400 VALIDATION_ERROR`, `400 B2B_REQUIRED_FIELDS` (B2B without a gstin — the DB's own `customers_b2b_required_fields` CHECK, not an application-layer choice this endpoint can waive), `403 FORBIDDEN`, `409 CUSTOMER_ARCHIVED_EXISTS`, `409 CUSTOMER_GSTIN_ALREADY_EXISTS`, `409 CUSTOMER_PHONE_ALREADY_EXISTS` (all shared with Module 2 — see `docs/modules/module-2-master-data/06-error-reference.md`).
