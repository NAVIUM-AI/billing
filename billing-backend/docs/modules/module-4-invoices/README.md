# Module 4: Invoicing & GST

_Status: in progress. Task 4.1 (invoice foundation, GST domain, draft CRUD, trip hold) and Task 4.2 (invoiceable trips picker, reimbursement auto-sum, line description editing) are complete. Full module documentation (mirroring Module 2/3's structure) lands after Task 4.6._

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
