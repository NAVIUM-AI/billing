# Verification

_Last updated: 2026-07-23. Reviewers: TBD._

## Automated verification scripts

| Script | Command | Check count | What it proves |
| --- | --- | --- | --- |
| `scripts/verify-invoice-draft.sh` | `npm run verify:invoices-draft` | 32 | Invoice foundation (Task 4.1): DRAFT creation from FINALIZED trips, GST computation (intra/inter-state split, PERFORMANCE zero-GST), trip-hold mechanism, RBAC, cross-tenant isolation |
| `scripts/verify-invoice-picker.sh` | `npm run verify:invoice-picker` | 28 | The invoiceable-trips picker (Task 4.2): LOCAL/OUTSTATION grouping, reimbursement auto-sum, manual-override persistence across a trip-set change, line-description editing |
| `scripts/verify-invoice-lifecycle.sh` | `npm run verify:invoice-lifecycle` | 32 | Full DRAFT→ISSUED→CANCELLED lifecycle (Task 4.3): atomic numbering under concurrency, snapshot immutability (proven by editing the source tenant/customer AFTER issue and re-fetching), credit-note creation, trip status wiring (FINALIZED↔INVOICED) in both directions |
| `scripts/verify-payments.sh` | `npm run verify:payments` | 33 | Payments ledger (Task 4.4, plus a Task 4.6 addition): recording, over-payment splitting, advance application (full and partial consume), payment cancellation with PAID→ISSUED reversal, customer ledger, receivables aging, RBAC including the Task 4.6 `reports:read` widening to `viewer` |
| `scripts/verify-pdf.sh` | `npm run verify:pdf` | 18 | PDF rendering (Task 4.5): all three invoice templates (Yellow/Blue/Performance) plus the credit-note template generate real, correctly-typed PDFs; DRAFT invoices reject generation; regeneration is idempotent; cross-tenant access is denied |
| `scripts/verify-customer-quick-create.sh` | `npm run verify:customer-quick` | 8 | Quick-create (Task 4.6): minimal-field B2C creation, the B2B-still-requires-GSTIN reality check, GSTIN format validation + state auto-derivation, RBAC, cross-tenant isolation |
| `scripts/test-gst-calc.js` | `npm run test:gst` | 16 (pure, no server/DB needed) | `src/domain/gst/`'s `computeGST`/`computeRoundOff`/`isSameState`/`amountInWords` in isolation |

## Running all Module 4 verifications

```bash
npm run verify:invoices-draft && \
  npm run verify:invoice-picker && \
  npm run verify:invoice-lifecycle && \
  npm run verify:payments && \
  npm run verify:pdf && \
  npm run verify:customer-quick && \
  npm run test:gst
```

`test:gst` needs neither the dev server nor a database and is safe to run any time. Every `verify:*` script needs `npm run dev` running in another terminal and a reachable Postgres instance; `verify:pdf` additionally needs a working Puppeteer/Chrome setup (see `07-debugging-playbook.md`).

## Full regression across the project

```bash
npm run test:pricing && npm run test:gst && \
  npm run verify:auth && \
  npm run verify:tenants && \
  npm run verify:rbac && \
  npm run verify:vehicles && \
  npm run verify:drivers && \
  npm run verify:customers && \
  npm run verify:customer-quick && \
  npm run verify:pricing && \
  npm run verify:trips-local && \
  npm run verify:trips-outstation && \
  npm run verify:trips-lifecycle && \
  npm run verify:trips-list && \
  npm run verify:trips-perf && \
  npm run verify:error-handler && \
  npm run verify:invoices-draft && \
  npm run verify:invoice-picker && \
  npm run verify:invoice-lifecycle && \
  npm run verify:payments && \
  npm run verify:pdf
```

## What each Module 4 script proves beyond its check count

**`verify:invoice-lifecycle`** — the snapshot-immutability check is this module's closest thing to a golden-master proof: it issues an invoice, THEN mutates the source tenant's name and the customer's own record via `PATCH /settings/business`/`PATCH /customers/:id`, then re-fetches the already-issued invoice and asserts its `tenant_snapshot`/`customer_snapshot` are byte-for-byte unchanged from what they were at issue. A naive implementation that re-derived the snapshot on every read (instead of trusting the stored, write-once JSONB) would still pass every other check in the script but fail exactly this one. The concurrency check (N simultaneous `issue` requests against N distinct DRAFTs) is the module's proof that numbering is genuinely gap-free and collision-free under real contention, not just by code inspection.

**`verify:payments`** — the over-payment split and partial-advance-application checks are where ADR-013's synthetic-reference-uniqueness fix is actually exercised: applying part of one advance to invoice A, then the remainder of the SAME advance to invoice B, would collide on `idx_payments_ref_unique` under the reference-generation scheme this script was written to catch a regression of. The aggregate-consistency checks on the customer ledger and aging report (Rule 11) assert internal consistency — does `summary.total_paid_paise` equal the sum of the `PAYMENT` entries in the same response — rather than re-deriving the underlying GST/pricing arithmetic a second, independently-fallible time inside the test itself.

**`verify:pdf`** — proves PDF GENERATION happened correctly (file exists, correct `Content-Type`, `%PDF` magic bytes, byte length matches the stored `pdf_file_size_bytes`, cross-tenant access denied) but deliberately does NOT assert exact rendered byte content, since that's a Chromium-version concern rather than application logic (Rule 11). This is exactly why the module's real content bug (ADR-015's state-code lookup, see `known-issues.md`) passed every one of these 18 checks despite "Place of Supply" never actually rendering — the gap between "a PDF was generated" and "the PDF is content-correct" is closed by visual review, not by this script.

## Baseline

As of Task 4.6 completion: 19 verify scripts (384 checks — see the project's own `package.json` `scripts` section for the exact, currently-registered set) plus 27 pure unit tests (`test:gst` + `test:pricing`), 411 checks total, all green, confirmed by a full regression run immediately before this documentation pass was finalized. This document's script table is kept in sync with `package.json` by hand and should be cross-checked against it if the two ever appear to disagree.

## Manual verification

Ad hoc `psql` queries useful for sanity-checking Module 4 state outside the automated scripts (run as a superuser, or with `SET LOCAL app.current_tenant_id` set first if running as the app role):

```sql
-- Row counts per table
SELECT COUNT(*) FROM invoices;
SELECT COUNT(*) FROM invoice_lines;
SELECT COUNT(*) FROM credit_notes;
SELECT COUNT(*) FROM payments;

-- A tenant's invoice number sequence state per type/fiscal year
SELECT tenant_id, invoice_type, fiscal_year, next_seq FROM invoice_number_sequences
  ORDER BY tenant_id, invoice_type, fiscal_year;

-- Status distribution for a given tenant
SELECT tenant_id, status, COUNT(*) FROM invoices
  GROUP BY tenant_id, status ORDER BY tenant_id, status;

-- Unallocated advances per customer
SELECT customer_id, COUNT(*), SUM(amount_paise) FROM payments
  WHERE invoice_id IS NULL AND status = 'RECORDED'
  GROUP BY customer_id;

-- Confirm FORCE ROW LEVEL SECURITY on every Module 4 table
SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class
  WHERE relname IN ('invoices', 'invoice_lines', 'invoice_number_sequences',
                     'credit_notes', 'credit_note_number_sequences', 'payments');
-- Expect relrowsecurity = t AND relforcerowsecurity = t on every row.
```
