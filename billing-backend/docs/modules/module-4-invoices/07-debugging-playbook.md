# Debugging playbook

_Last updated: 2026-07-23. Reviewers: TBD._

Concrete scenarios, written as "when you see X, check Y." Every check below is something to actually run, not a hypothesis to consider.

## "Invoice number allocation returned duplicate (INVOICE_NUMBER_COLLISION)"

- Should not happen under routine operation — `invoiceNumber.js#allocateInvoiceNumber` is a single atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` inside the same transaction as the invoice's status change, so two concurrent issues for the same `(tenant_id, invoice_type, fiscal_year)` serialize on the sequence row's own lock. Seeing this means either `invoice_number_sequences`' row for this tenant/type/FY is out of sync with the invoices that actually exist, or `tenants.invoice_prefix`/`performance_prefix` changed mid-fiscal-year in a way that coincidentally produced a number matching an old prefix's number.
- Reproduce directly:

  ```sql
  SET LOCAL app.current_tenant_id = '<uuid>';
  SELECT tenant_id, invoice_type, fiscal_year, next_seq FROM invoice_number_sequences
    WHERE tenant_id = '<uuid>';
  SELECT invoice_number FROM invoices
    WHERE tenant_id = '<uuid>' ORDER BY issued_at DESC NULLS LAST LIMIT 5;
  ```

  Confirm `next_seq` is genuinely ahead of every existing invoice's own sequence number for that fiscal year and type.

## "TRIP_ALREADY_HELD when creating or editing an invoice"

- This means the trip is `FINALIZED` but its `held_by_invoice_id` already points at a DIFFERENT invoice — check `error.details.held_by_invoice_id` for which one. If you expected the trip to be free, either that other invoice is a forgotten DRAFT still holding it (release it by deleting that draft or removing the trip from its `trip_sheet_ids` on a PATCH), or the trip was already issued onto an invoice and its status has actually moved to `INVOICED` (in which case you'd see `TRIP_NOT_FINALIZED`, not this code — confirm which one you're actually getting).
- Confirm directly:

  ```sql
  SET LOCAL app.current_tenant_id = '<uuid>';
  SELECT id, status, held_by_invoice_id, invoice_id FROM trip_sheets WHERE id = '<trip-uuid>';
  ```

## "GST calculation off by 1 paise"

- `computeGST` rounds the total GST to the nearest paise FIRST (`Math.round(taxableAmountPaise * gstRate / 100)`), then splits: for an intra-state invoice, CGST gets `Math.floor(total / 2)` and SGST absorbs the remainder — an odd total GST paise amount is a real, expected, non-bug outcome (e.g. `totalGstPaise = 121` splits as `CGST 60 / SGST 61`, never `60.5`/`60.5`). If the discrepancy you're seeing is bigger than a single paise, check `round_off_paise` next — it's a SIGNED value (can be negative) applied to reach a whole-rupee `net_payable_paise`, and a sign confusion there is a much more common source of an off-by-more-than-a-paise total than the GST split itself.
- Confirm the taxable base is what you expect: `subtotal_paise - discount_paise`, clamped to `>= 0` — a discount larger than the subtotal doesn't go negative, it floors at zero taxable amount.

## "Payment split shows 0 outstanding but the incoming payment failed"

- Check `outstanding <= 0` at the moment `recordPaymentOnInvoice` ran — if the invoice was ALREADY fully paid (or over-paid) before this payment arrived, the whole payment becomes a pure advance (`invoice_id: null`), not a rejected request (see `05-design-decisions.md`'s over-payment section and ADR-013's own top-of-file note in `payment.service.js`). This is intentional, not a bug: recording a further payment against a fully-paid invoice is explicitly legal, and the entire amount routes to the customer's unallocated-advance balance instead of erroring. Check the response's `spillover_advance`/the payment's own `invoice_id` — if `invoice_id` is `null` and there's no `PAYMENT_NOT_ALLOWED_STATE` error, this worked as designed; the "failure" is that the amount didn't apply where you expected, not that the request errored.

## "PAID transition didn't fire after what looks like a full payment"

- `maybeTransitionToPaid` compares the FRESH sum of `RECORDED` payments (`paymentRepo.sumRecordedForInvoice`) against `invoice.net_payable_paise` — confirm the sum, not just the most recent payment's own amount, actually reaches the total:

  ```sql
  SET LOCAL app.current_tenant_id = '<uuid>';
  SELECT SUM(amount_paise) FROM payments
    WHERE invoice_id = '<invoice-uuid>' AND status = 'RECORDED';
  SELECT net_payable_paise, status FROM invoices WHERE id = '<invoice-uuid>';
  ```

  A payment recorded with `status != 'RECORDED'` (already cancelled, or — this shouldn't be possible via the API — never actually committed) doesn't count toward the sum. Also confirm the invoice was `ISSUED` (not already `PAID`, not `DRAFT`/`CANCELLED`) at the moment the payment was recorded — `maybeTransitionToPaid` only fires the transition when `invoice.status === 'ISSUED'` on entry, using the invoice row as loaded at the START of the request, not a stale value from earlier.

## "PDF download returns 500 PDF_FILE_MISSING"

- This means `pdf_url` is set on the invoice/credit-note row (a `POST .../pdf` succeeded at some point) but the actual file is gone from `PDF_STORAGE_ROOT`. Confirm the path:

  ```bash
  echo "$PDF_STORAGE_ROOT"   # or check .env's PDF_STORAGE_ROOT
  ```

  Common causes: the server was redeployed to a fresh filesystem/container without persisting `pdf-storage/` (it's gitignored and NOT backed up by anything in this repo — see `05-design-decisions.md`'s filesystem-storage trade-off), or something outside the application deleted the file directly. The fix is simply to call `POST .../pdf` again — generation is idempotent and will recreate the file and overwrite the stored metadata.

## "Puppeteer fails to launch on this server"

- `pdfEngine.service.js#findChromeExecutable` looks for an already-installed Chrome/Chromium at a fixed list of common paths (or `CHROME_EXECUTABLE_PATH` if set) — it does NOT download or bundle its own Chromium (`puppeteer-core`, not `puppeteer`). If no candidate path exists on this machine, every PDF-generation call fails with a thrown `Error` translated to `500 PDF_RENDER_FAILED`/`PDF_TEMPLATE_ERROR`. Fix: install Google Chrome (or any Chromium build) at one of the checked paths, or set `CHROME_EXECUTABLE_PATH` to point at wherever it actually lives. This deliberately avoids the full `puppeteer` package's bundled-Chromium postinstall download, which stalled indefinitely in this project's own development environment — see `known-issues.md`.

## "State-name / Place of Supply lookup returns nothing on a PDF"

- `stateNameForCode` (`src/constants/gstStateCodes.js`) is keyed by the 2-LETTER state code this application actually stores (`"KA"`, `"MH"`, ...), NOT the official numeric CBIC GST code (`"29"`). If a future change reintroduces a numeric-keyed lookup table, every "Place of Supply" line silently disappears from every generated PDF with no error anywhere — this exact bug shipped once already (Task 4.5) and was only caught by rendering a sample PDF and looking at it, since every automated `verify-pdf.sh` check (file exists, correct MIME type, correct size) passes regardless of which fields actually rendered. See ADR-015 for why this class of bug requires visual review, not just automated checks, to catch.

## "Cross-tenant invoice/payment/credit-note read returned 200 instead of 404"

- This should be structurally impossible — every repository function in this module takes `tenantId` as an explicit parameter and includes it in the `WHERE` clause, on top of RLS forcing the same filter at the database layer independent of the application query. If you see this, first confirm the request actually carried a valid JWT for the tenant you think it does (`GET /auth/me` with the same token); a token issued for tenant A used against what looks like tenant B's data most likely means the id being read actually does belong to tenant A. If that's not it, check whether the specific repository function in question was passed `tenantId` at all, or whether a `client.query` call somewhere bypassed the repository layer and hand-wrote SQL without the tenant filter (every ad hoc query inside `payment.service.js#getCustomerLedger`/`getReceivablesAging`, the two functions in this module that write raw SQL directly rather than going through a repository function, is the first place to check for a missing `tenant_id = $1` predicate).

## "verify:invoice-lifecycle fails on a snapshot-immutability step"

- The snapshot columns (`tenant_snapshot`, `customer_snapshot`) should be frozen permanently once an invoice is issued, regardless of what happens to the source `tenants`/`customers` rows afterward. If this fails, check whether a code path is re-fetching and re-writing the snapshot on some OTHER transition (a PATCH, a payment) instead of only at `issueInvoice` — `invoiceRepo.transitionStatus`'s `COALESCE`-based `UPDATE` is specifically written so a non-null snapshot never gets overwritten by a later call, but only if every caller consistently passes `null` for `snapshotFields` on every transition except issue. `cancelInvoice` passes `null` for both `snapshotFields` and `invoiceNumber` explicitly (a cancellation writes NEW audit fields, never touches the frozen `invoice_number`/snapshots) — if a future change to that call site accidentally passed a freshly-rebuilt snapshot instead, this is the check that would catch it.
