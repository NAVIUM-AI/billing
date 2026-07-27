# Data flow: a single request end to end

_Last updated: 2026-07-23. Reviewers: TBD._

Traces `POST /api/v1/invoices/:invoiceId/issue` through every layer — the single request that does the most in this module: atomic numbering, snapshot freezing, and a cross-module trip-status transition, all inside one transaction. `POST /invoices` (draft creation) and `POST .../pdf` (generation) follow the same layered shape with a much shorter "check + write" phase; only the transaction's contents differ.

```
 Client
   │  POST /api/v1/invoices/:invoiceId/issue
   │  Authorization: Bearer <JWT>
   │  {} (empty body)
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ authenticate                                                     │
│   verifies the JWT, attaches req.user = { userId, tenantId, role }│
└──────────────────────────────────────────────────────────────────┘
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ tenantContext                                                    │
│   copies req.user.tenantId → req.tenantId                        │
│   attaches req.db = { queryAsTenant, withTenantContext }         │
└──────────────────────────────────────────────────────────────────┘
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ requirePermission('invoices:issue')                              │
│   looks up req.user.role in src/config/accessMatrix.js           │
│   403 FORBIDDEN if the role isn't listed for this key             │
└──────────────────────────────────────────────────────────────────┘
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ validate(issueInvoiceSchema)          [invoice.validator.js]      │
│   {} .unknown(false) — rejects a stray body key rather than       │
│   silently stripping it                                           │
└──────────────────────────────────────────────────────────────────┘
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ route handler                              [invoices.routes.js]  │
│   calls invoiceService.issueInvoice(tenantId, invoiceId,          │
│                                      userId, req.db)              │
└──────────────────────────────────────────────────────────────────┘
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ invoiceService.issueInvoice              [invoice.service.js]    │
│   ONE db.withTenantContext transaction, containing everything     │
│   below — a failure at any step rolls back the number             │
│   allocation, the snapshot writes, and every trip transition      │
│   together, rather than leaving the system half-issued.           │
└──────────────────────────────────────────────────────────────────┘
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ db.withTenantContext                        [config/db.js]       │
│   BEGIN;                                                          │
│   SELECT set_config('app.current_tenant_id', '<tenantId>', true);│
│   <runs the callback below with this client>                      │
│   COMMIT;  (ROLLBACK + rethrow on error)                          │
└──────────────────────────────────────────────────────────────────┘
   │
   ├─▶ invoiceRepo.findByIdForUpdate(tenantId, id, client)
   │     SELECT ... FOR UPDATE — row lock held for the whole
   │     transaction; a concurrent issue of the SAME invoice blocks
   │     here until this transaction commits or rolls back
   │     404 INVOICE_NOT_FOUND if missing
   │
   ├─▶ assertInvoiceTransition(invoice, 'ISSUED')
   │     src/domain/invoiceLifecycle — pure, framework-free check
   │     409 INVALID_INVOICE_STATE_TRANSITION if not DRAFT
   │
   ├─▶ tenantRepo.findById / customerRepo.findById(invoice.customer_id)
   │     both guaranteed to exist (FK, ON DELETE RESTRICT) —
   │     a 500 here would correctly signal data-integrity failure
   │
   ├─▶ allocateInvoiceNumber({ client, tenantId, invoiceType,         [invoiceNumber.js]
   │                            invoiceDate, prefix })
   │     atomic UPSERT + xmax trick against invoice_number_sequences
   │     — allocated inside THIS transaction, so a failure below
   │     rolls the allocation back with it (no burned numbers)
   │
   ├─▶ buildTenantSnapshot(tenant) / buildCustomerSnapshot(customer) [invoiceSnapshot.js]
   │     pure functions — no DB access, just shaping already-loaded rows
   │
   ├─▶ invoiceRepo.transitionStatus(..., 'ISSUED', ..., snapshotFields,   [invoice.repository.js]
   │                                  invoiceNumber, client)
   │     UPDATE invoices SET status='ISSUED', invoice_number=...,
   │       tenant_snapshot=COALESCE(...), customer_snapshot=COALESCE(...),
   │       issued_at=..., issued_by=...
   │     WHERE id=$1 AND tenant_id=$2 AND status=$fromStatus
   │     409 INVOICE_STATUS_CHANGED if zero rows matched (defensive)
   │     409 INVOICE_NUMBER_COLLISION on the unique-number constraint
   │       (should not occur under normal operation)
   │
   ├─▶ client.query(UPDATE invoices SET amount_in_words = ...)
   │     transitionStatus's own column list omits amount_in_words —
   │     written separately, same transaction
   │
   ├─▶ lineRepo.listByInvoice(tenantId, id, client) → tripIds
   │
   ├─▶ tripService.markTripsInvoiced(tenantId, tripIds, id,           [tripSheet.service.js]
   │                                  actorUserId, client)
   │     for EACH trip: findByIdForUpdate (row lock) →
   │     assertTransition(trip, 'INVOICED') [src/domain/tripLifecycle] →
   │     tripRepo.transitionStatus(..., 'INVOICED', { invoicedAt, invoiceId })
   │     409 TRIP_STATUS_CHANGED if any trip's guarded UPDATE matches
   │       zero rows (defensive — shouldn't occur, same transaction)
   │
   └─▶ tripRepo.releaseHold(tenantId, id, client)
         held_by_invoice_id is now redundant — every trip on this
         invoice is INVOICED, which alone makes it ineligible for a
         different invoice's picker
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ Postgres                                                          │
│   RLS policies on invoices / invoice_lines / trip_sheets /        │
│   invoice_number_sequences all evaluate against the SAME          │
│   app.current_tenant_id set once at the top of this transaction   │
│   FORCE ROW LEVEL SECURITY applies even though the app connects   │
│   as the table-owning role.                                       │
└──────────────────────────────────────────────────────────────────┘
   ▼
 200 OK
 { "invoice": { "id": "...", "invoice_number": "PRA-1/26-27",
                "status": "ISSUED", "tenant_snapshot": { "..." },
                "customer_snapshot": { "..." }, "issued_at": "...",
                "lines": [ "..." ] } }
```

Every downstream module (payments, PDF generation) reads this same `tenant_snapshot`/`customer_snapshot`/`invoice_number` as immutable facts from this point forward — nothing else in the codebase ever writes to those three fields again for this invoice, short of `CANCELLED` reversing the trip side (a separate, symmetric transaction in `cancelInvoice`, not shown above).
