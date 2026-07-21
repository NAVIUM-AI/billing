# Module 4: Invoicing & GST

_Status: in progress. Task 4.1 (invoice foundation, GST domain, draft CRUD, trip hold), Task 4.2 (invoiceable trips picker, reimbursement auto-sum, line description editing), Task 4.3 (invoice lifecycle, numbering, immutability, credit-note cancellation), Task 4.4 (payments ledger, PAID transition, customer statement, aging report), and Task 4.5 (PDF rendering for invoices + credit notes) are complete. Full module documentation (mirroring Module 2/3's structure) lands after Task 4.6._

## Task 4.5: PDF rendering for invoices + credit notes

Status: Complete.

**Engine** (`src/services/pdfEngine.service.js`): a single Puppeteer browser instance kept alive for the app's lifetime (launch is ~500ms; pages within it are cheap), driving Handlebars templates compiled once and cached by `(name, version)`. `puppeteer-core` is used instead of `puppeteer` — see the flagged deviation below. Templates live under `src/templates/pdf/v1.0.0/`, versioned by directory so a layout change never retroactively alters an already-generated historical PDF: `pdf.service.js` always renders with the template version already stamped on the invoice/credit-note row (falling back to the current version only on first generation).

**Storage**: PDFs are written to `PDF_STORAGE_ROOT` (env var, default `./pdf-storage`, gitignored), under `{tenantId}/invoices/` or `{tenantId}/credit-notes/`. Generation is synchronous — `POST .../pdf` blocks until the file is written and `pdf_url`/`pdf_generated_at`/`pdf_template_version`/`pdf_file_size_bytes` are persisted — and idempotent, since a regeneration simply overwrites the same file (name is `{id}-{templateVersion}.pdf`, so there's exactly one file per document per template version).

**Endpoints**: `POST`/`GET /invoices/:id/pdf` and `POST`/`GET /credit-notes/:id/pdf`, all gated on `invoices:read`. `POST` generates (or regenerates) and returns metadata; `GET` streams the stored bytes with `Content-Type: application/pdf` and a filename derived from the invoice/credit-note number. PDFs can only be generated for non-DRAFT invoices (`INVOICE_NOT_ISSUED` otherwise) — draft financials aren't legally final yet.

**Render context comes from the frozen snapshots, not live data**: `invoice.tenant_snapshot`/`invoice.customer_snapshot` (and the credit note's own snapshots) — the same write-once JSONB Task 4.3 already populates at issue/cancel — are the render source, not a fresh tenant/customer lookup. Since PDF generation is only ever legal on non-DRAFT documents, the snapshot is always present and is exactly "state as of issue," which is what a legal document must show regardless of what the tenant/customer record looks like today.

**Four templates**: Yellow (`invoice-local-tax.hbs`, LOCAL service_type), Blue (`invoice-outstation-tax.hbs`, OUTSTATION), Performance (`invoice-performance.hbs`, zero GST), and `credit-note.hbs`. TAX-invoice template selection uses the first line's `service_type` — Task 4.3 already guarantees a single service_type per invoice, so the first line is authoritative.

**Five flagged spec deviations, all resolved by using only fields that actually exist in this schema** (same "reality over spec prose" precedent as Task 4.3's `invoiceSnapshot.js`, documented in full at the top of `pdf.service.js`):
1. `tenants` has no tagline/phone/phone2/email/website/address columns at all — only `name`/`gstin`/`pan`/`state_code`/`logo_url`/`bank_details`/`gst_rate`. The header/bank-details templates render only what exists.
2. `invoices` has no `reverse_charge` or place-of-supply column — "Place of Supply" is derived from the customer's `state_code` (the standard GST convention: the recipient's state), not a fabricated invoice column.
3. `invoice_lines` stores one combined `extras_amount_paise` per line, not a base_km/base_hours/extra_km_rate/extra_hr_rate split that was never part of the Task 4.1 schema — the tables show Package Amount + Extra Charges + Driver Bata + Taxable Value instead. Per-km rate IS shown on the Blue/Performance tables, but only as a derived display value (`base_amount_paise / total_km`), never written back to the DB.
4. `invoice_lines` has no per-line toll column — toll/parking/permit/fasttag are invoice-level aggregates only, shown once in the totals block.
5. `credit_notes` has no line-item table at all, only the original invoice's frozen aggregate totals — `credit-note.hbs` renders the single-row "reversal of invoice X" summary instead of fabricated per-line detail that has nothing to read from.

**One infrastructure deviation, not a schema one**: the full `puppeteer` package's postinstall step downloads a bundled ~300MB Chromium; in this environment that download connected but transferred zero bytes for 14+ minutes — the exact corporate-proxy failure mode the task spec anticipated. Switched to `puppeteer-core` driving the system's already-installed Google Chrome (`src/services/pdfEngine.service.js#findChromeExecutable`, overridable via `CHROME_EXECUTABLE_PATH`), which needs no download at all.

**One real bug caught by looking at the rendered output, not just green tests** (Rule 9 — ships in this commit): a first draft of `src/constants/gstStateCodes.js` keyed state names by the official numeric CBIC GST code ("29" → Karnataka). But `tenants.state_code`/`customers.state_code` in this app are 2-letter abbreviations ("KA"), derived from a GSTIN's leading digits via `src/utils/gstin.js#GST_STATE_MAP` and compared as plain strings by `src/domain/gst/index.js#isSameState` — the numeric code never appears anywhere in this schema. The lookup silently missed on every tenant/customer, so "Place of Supply" never rendered on any PDF despite every automated check passing (byte count > 0 says nothing about which fields rendered). Caught by actually opening a generated PDF; fixed by re-keying the constant to the 2-letter codes this app really uses.

Verified via `scripts/verify-pdf.sh` (18 checks: all three invoice templates + credit note generate real PDFs with correct `Content-Type`/`%PDF` magic bytes/matching byte length; DRAFT invoices reject PDF generation; ungenerated PDFs 404; regeneration is idempotent; cross-tenant access is denied; unauthenticated access is denied) — per Rule 11, these assert that a PDF *was generated correctly*, not specific byte content, since exact Chromium rendering output is a browser-version concern, not application logic.

## Task 4.4: Payments ledger + PAID transition + customer statement + aging report

Status: Complete.

**Payments** (`payments` table, Task 4.4 migration): lifecycle is RECORDED → CANCELLED (terminal — cancellation is the only reversal path, there is no DELETE). A payment either applies to a specific invoice (`invoice_id` set) or sits as an unallocated advance on the customer (`invoice_id` null). Modes: CASH, UPI, NEFT, RTGS, IMPS, CHEQUE, CARD, BANK_TRANSFER. CASH payments carry no reference; every other mode requires one, enforced at both the DB (`payments_reference_required` CHECK) and Joi layers. Idempotency: a unique index on `(tenant_id, payment_mode, reference_number)` scoped to non-CASH, RECORDED rows stops the same NEFT UTR / UPI txn ID from being recorded twice — but a cancelled payment's reference is free to reuse, since it's no longer "active."

**Endpoints**:
- `POST /invoices/:id/payments` — record a payment against a specific invoice
- `POST /customers/:id/advances` — standalone advance, not tied to any invoice
- `POST /invoices/:id/apply-advance` — apply an existing unallocated advance to an invoice
- `POST /payments/:id/cancel` — the only way to reverse a payment
- `GET /payments`, `GET /payments/:id` — list/read
- `GET /customers/:id/ledger` — full statement (every non-DRAFT invoice + every RECORDED payment, merged into one running-balance timeline)
- `GET /reports/receivables-aging` — outstanding ISSUED invoices bucketed by days overdue (CURRENT, 1-30, 31-60, 61-90, 90+)

**Derived transitions** (`src/domain/invoiceLifecycle/`): ISSUED → PAID fires automatically once cumulative RECORDED payments reach `net_payable_paise`; PAID → ISSUED is the mirror-image reversal, firing automatically when cancelling a payment drops the cumulative total back below `net_payable_paise`. Both are first-class entries in the state machine's own `TRANSITIONS` map, not a special case bolted onto `payment.service.js` — same "the state machine encodes every legal transition, regardless of trigger" principle the trip lifecycle module already followed for its own derived transitions.

**Over-payment behavior**: paying more than an invoice's outstanding balance splits the payment — the outstanding amount applies to the invoice, the excess spills into a new unallocated advance on the same customer, linked back via `parent_payment_id` for audit. The spillover's reference number gets a `#advance-of-{id}` suffix so it doesn't collide with the idempotency index on the (already-recorded) applied portion.

**Advance application**: applying an advance either fully consumes it (the row is reassigned to point at the invoice — no new row) or partially consumes it (a new applied-portion row is inserted, referencing the advance via `parent_payment_id`, and the advance row's own `amount_paise` is decremented in place).

**Two bugs found in the spec's own pseudocode and fixed in this commit** (both documented at the top of `payment.service.js`):
1. Recording a payment on an invoice with zero (or negative) outstanding — legal, since payments are allowed on already-PAID invoices too — would, under the spec's literal split formula, try to insert an "applied" row with `amount_paise <= 0`, violating `payments`' own `amount_paise > 0` CHECK. Fixed: when outstanding is already `<= 0`, the entire payment becomes a pure advance instead.
2. The spec's partial-advance-application reference (`applied-from-advance-{advance.id}`) is stable across repeated partial applications of the same advance to different invoices, so a second partial application of a non-CASH advance would collide with the idempotency index. Fixed by including the target invoice id in the reference.

Full Module 4 docs after Task 4.6.

## Task 4.3: Invoice lifecycle + numbering + credit-note cancellation

Status: Complete.

**State machine** (`src/domain/invoiceLifecycle/`):
- DRAFT → ISSUED (`POST /invoices/:id/issue`, `invoices:issue`)
- DRAFT → CANCELLED (no credit note — the invoice was never legally issued)
- ISSUED → PAID (derived from payments, Task 4.4 — no code path exercises this transition yet)
- ISSUED → CANCELLED (auto credit note)
- PAID → CANCELLED (auto credit note)
- CANCELLED is terminal

**Numbering** (`src/utils/invoiceNumber.js`, atomic UPSERT+xmax allocation — same pattern as Task 3.1's trip sheet numbering):
- TAX invoices: `PRA-1/26-27`, `PRA-2/26-27`, ... (`tenant.invoice_prefix`)
- PERFORMANCE invoices: `PRA-PS-1/26-27`, ... (`tenant.performance_prefix`) — a separate sequence from TAX
- Credit notes: `PRA-CN-1/26-27`, ... (`tenant.credit_note_prefix`, auto-derived at signup as `invoice_prefix + '-CN'`)
- Per-tenant, per-type, per-fiscal-year sequences. A failed issue never consumes a number — the UPSERT only fires once every prior check has passed, inside the same transaction as the status change.

**Snapshotting at issue** (`src/utils/invoiceSnapshot.js`): tenant and customer state are frozen into `invoice.tenant_snapshot` / `invoice.customer_snapshot` JSONB at the moment of issue, and never overwritten afterward — a later edit to either record does not retroactively change an already-issued document. Note: the snapshot's field list is narrower than the tenants/customers tables might suggest, because it only includes columns that actually exist on those tables (`tenants` has no address/phone/email/website columns; `customers`' address is a single nested JSONB blob, not flat `address_line1`/`city`/`state`/`pincode` columns — the snapshot keeps the flat shape but sources it from the nested column).

**Trip status wiring**:
- On issue: FINALIZED → INVOICED for every trip on the invoice (`tripSheet.service.js#markTripsInvoiced`); `invoice_id` backreference set; `held_by_invoice_id` cleared.
- On cancel of an ISSUED/PAID invoice: INVOICED → FINALIZED (`tripSheet.service.js#reverseTripInvoiced`) — the trip becomes re-invoiceable. This required adding `INVOICED → FINALIZED` to `src/domain/tripLifecycle/`'s own transition table (Task 3.3 had shipped it terminal, anticipating — incorrectly, it turned out — that the reversal would be purely an invoice-level concern).
- Both trip functions take a `client` directly rather than opening their own transaction, so the invoice status change and every trip transition on it commit or roll back together as one unit.

**Credit note flow** (`src/repositories/creditNote.repository.js`):
- Cancelling an ISSUED or PAID invoice automatically creates a `credit_notes` row with its own gap-free per-FY numbering.
- The credit note snapshots tenant/customer state independently, as of the cancellation moment — not copied from the original invoice's (older) snapshot. A tenant renamed between issue and cancellation shows up in the credit note but not in the original invoice.
- Financial figures mirror the original invoice's frozen totals (the reversal amount). Reason is required (min 3 chars), same convention as trip cancellation.

**Concurrency**: row locks via `SELECT ... FOR UPDATE` plus a guarded `UPDATE ... WHERE status = $prev`, identical to every other lifecycle transition in this codebase. Two requests issuing the same DRAFT concurrently produce exactly one 200 and the rest 409s; issuing N distinct DRAFTs concurrently produces N sequential, gap-free numbers.

Full Module 4 docs after Task 4.6.

## Task 4.2: Invoiceable trips picker + reimbursement auto-sum

Status: Complete.

Endpoints:
- `GET /customers/:id/invoiceable-trips` — the checkbox picker; groups FINALIZED unheld trips by service_type (LOCAL, OUTSTATION); supports an `invoice_id` query param for the edit case (includes trips already held by that invoice, so a trip on the draft being edited still shows as selectable).
- `PATCH /invoices/:id/lines/:lineId` — per-line description editing (DRAFT only).

Behavior:
- On invoice creation, reimbursement columns (toll, parking, permit, fasttag) auto-sum from the selected trips' data. The user can override any field explicitly; overrides set a per-field `manual_override` flag that persists across trip-set changes, so an explicit choice is never silently discarded by a later PATCH that swaps the trip set.
- An explicit `0` for a reimbursement field counts as an override too — "no fasttag on this invoice" is a real, intentional answer, not "the user didn't touch this field."
- LOCAL and OUTSTATION trips can share one invoice. Line rendering differs by service_type (Task 4.5 PDF template).

Full Module 4 docs after Task 4.6.
