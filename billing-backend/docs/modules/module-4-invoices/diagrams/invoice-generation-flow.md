# Invoice generation flow: picker to PDF

_Last updated: 2026-07-23. Reviewers: TBD._

The end-to-end path a real invoice takes, from an ops user picking a customer through to a downloadable PDF. Each box names the endpoint and the module/task that owns it.

```
 1. User picks a customer
    │
    ▼
 GET /customers/:customerId/invoiceable-trips        (Task 4.2, invoices:draft)
    │  Every FINALIZED, unheld trip for this customer,
    │  grouped LOCAL / OUTSTATION, with per-group and
    │  overall summaries (count, total_km, totals in paise).
    │  ?invoice_id=<draft-id> also includes trips already
    │  held by that specific draft (the edit case).
    ▼
 2. User checks the trips to bill, sees the running total
    │
    ▼
 POST /invoices                                       (Task 4.1, invoices:draft)
    │  { invoice_type, customer_id, trip_sheet_ids[] }
    │  Server-side: resolves + validates every trip
    │  (FINALIZED, unheld or held by nobody yet, same
    │  customer), auto-sums toll/parking/permit/fasttag
    │  from the trips (Task 4.2) unless the request
    │  explicitly overrides one, computes GST (TAX only),
    │  holds every trip (held_by_invoice_id), inserts
    │  invoice_lines. Returns status=DRAFT,
    │  invoice_number=null.
    ▼
 3. User reviews the draft; may adjust further
    │
    ├─▶ PATCH /invoices/:id                            (Task 4.1)
    │     Change the trip set (full replace), discount,
    │     dates, notes/terms, or a reimbursement override.
    │     Every derived total recomputed as a group.
    │
    └─▶ PATCH /invoices/:id/lines/:lineId               (Task 4.2)
          Edit one line's description only.
    ▼
 4. User is satisfied — issues the invoice
    │
    ▼
 POST /invoices/:id/issue                              (Task 4.3, invoices:issue)
    │  ONE transaction: allocates the gap-free invoice
    │  number, freezes tenant_snapshot/customer_snapshot,
    │  moves every trip FINALIZED -> INVOICED, releases
    │  the (now-redundant) trip hold. Returns
    │  status=ISSUED, a real invoice_number, and both
    │  snapshots populated.
    ▼
 5. The invoice now needs a PDF to actually send the customer
    │
    ▼
 POST /invoices/:id/pdf                       (Task 4.5, invoices:read; split Task 4.7)
    │  Loads the invoice + lines, picks Yellow (TAX/LOCAL) /
    │  Blue (TAX/OUTSTATION) / Proforma Local / Proforma
    │  Outstation template from a 2x2 (invoice_type x
    │  service_type) map, keyed by the invoice's OWN stored
    │  pdf_template_version so a re-render of an already-
    │  issued document never silently changes layout after a
    │  template version bump, renders via Puppeteer + Handlebars
    │  using the
    │  FROZEN tenant_snapshot/customer_snapshot (never a
    │  fresh tenant/customer lookup), writes the file to
    │  PDF_STORAGE_ROOT, stores pdf_url/pdf_template_
    │  version/pdf_file_size_bytes/pdf_generated_at.
    │  Idempotent — safe to call again; overwrites the
    │  same file.
    ▼
 6. Customer needs to receive it (out of scope — no email delivery built)
    │
    ▼
 GET /invoices/:id/pdf                                 (Task 4.5, invoices:read)
       Streams the stored file back:
       Content-Type: application/pdf
       Content-Disposition: attachment; filename="<invoice_number>.pdf"

 ── Later, in parallel with the above ──

 POST /invoices/:id/payments                           (Task 4.4, payments:record)
    or
 POST /invoices/:id/apply-advance                      (Task 4.4, payments:record)
    │  Each re-derives whether the invoice should move
    │  ISSUED -> PAID from a fresh sum, never from a
    │  caller-supplied flag.
    ▼
 If a payment is later reversed:
 POST /payments/:id/cancel                             (Task 4.4, payments:cancel)
    │  If cancelling drops the sum back below
    │  net_payable_paise, the invoice reverts PAID -> ISSUED
    │  automatically (the mirror-image derived transition).

 ── If the invoice needs to be reversed entirely ──

 POST /invoices/:id/cancel                             (Task 4.3, invoices:cancel)
    │  ISSUED/PAID path: creates a credit_notes row (own
    │  numbering, own snapshot AS OF CANCELLATION), moves
    │  the invoice to CANCELLED, reverses every trip on it
    │  back to FINALIZED (re-invoiceable).
    ▼
 POST /credit-notes/:id/pdf  →  GET /credit-notes/:id/pdf   (Task 4.5)
       Same generate-then-download pattern as the invoice
       PDF, rendering the credit note's own frozen totals
       and snapshots (never the original invoice's).
```

The picker (step 1) and the draft-creation/edit endpoints (steps 2-3) are the only places `trip_sheets.held_by_invoice_id` is ever written or read from the API's perspective — by the time an invoice reaches step 4 (issue), the hold's job is already done and every subsequent step (payments, PDF, cancellation) operates purely on `invoices`/`invoice_lines`/`credit_notes`/`payments` state, never touching `trip_sheets` again except for the two symmetric bulk-transition calls at issue and cancel.
