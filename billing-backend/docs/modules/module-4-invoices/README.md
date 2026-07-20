# Module 4: Invoicing & GST

_Status: in progress. Task 4.1 (invoice foundation, GST domain, draft CRUD, trip hold), Task 4.2 (invoiceable trips picker, reimbursement auto-sum, line description editing), and Task 4.3 (invoice lifecycle, numbering, immutability, credit-note cancellation) are complete. Full module documentation (mirroring Module 2/3's structure) lands after Task 4.6._

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
