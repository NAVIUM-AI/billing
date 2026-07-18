# Data flow: a single request end to end

_Last updated: 2026-07-18. Reviewers: TBD._

Traces `POST /api/v1/customers` (create a customer) through every layer. The same shape applies to every write in Module 2 — only the validator/service/repository names change.

```
 Client
   │  POST /api/v1/customers
   │  Authorization: Bearer <JWT>
   │  { "customer_type": "B2B", "company_name": "...", "gstin": "...", ... }
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
│   (NOT yet touching Postgres — just preparing the helpers)       │
└──────────────────────────────────────────────────────────────────┘
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ requirePermission('customers:write')                             │
│   looks up req.user.role in src/config/accessMatrix.js           │
│   403 FORBIDDEN if the role isn't listed for this key             │
└──────────────────────────────────────────────────────────────────┘
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ validate(createCustomerSchema)          [customer.validator.js]  │
│   Joi checks shape: required fields, formats, custom transforms  │
│   e.g. gstinField normalizes "29 abcde..." → "29ABCDE..." string │
│   400 VALIDATION_ERROR on failure, with per-field messages       │
└──────────────────────────────────────────────────────────────────┘
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ route handler                            [customers.routes.js]   │
│   calls customerService.createCustomer(tenantId, body, userId,   │
│                                          req.db)                 │
└──────────────────────────────────────────────────────────────────┘
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ customerService.createCustomer            [customer.service.js]  │
│   1. Normalize   — gstin/email/pan already canonical from Joi    │
│   2. Derive      — state_code from gstin if omitted              │
│   3. Validate    — B2B requires company_name+gstin+state_code    │
│                     GSTIN's embedded state must match state_code │
│   4. Persist chk — findByGstin/findByPhone: is there an ARCHIVED │
│                     record with this value? (nicer error if so)  │
│   5. Write       — db.withTenantContext(client => repo.insert()) │
└──────────────────────────────────────────────────────────────────┘
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ db.withTenantContext                        [config/db.js]       │
│   BEGIN;                                                          │
│   SELECT set_config('app.current_tenant_id', '<tenantId>', true);│
│     ── SET LOCAL, scoped to this transaction only                │
│   <runs the callback with this client>                            │
│   COMMIT;  (ROLLBACK + rethrow on error)                          │
└──────────────────────────────────────────────────────────────────┘
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ customerRepository.insert            [customer.repository.js]    │
│   Pre-checks: findByGstin/findByPhone via the SAME client          │
│   INSERT INTO customers (tenant_id, customer_type, ...)            │
│     VALUES ($1, $2, ...) RETURNING *;                              │
│   catch (err) → mapConstraintError(err) if a unique/check         │
│     constraint fires (e.g. duplicate GSTIN → 409)                 │
└──────────────────────────────────────────────────────────────────┘
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ Postgres                                                          │
│   RLS policy customers_tenant_isolation evaluates:                │
│     WITH CHECK (tenant_id = current_setting(                      │
│                   'app.current_tenant_id', true)::uuid)           │
│   Because app.current_tenant_id was SET LOCAL above, the INSERT   │
│   is only permitted if the row's tenant_id matches it — even if   │
│   application code had a bug and passed the wrong tenant_id, RLS  │
│   would reject the write.                                          │
│   FORCE ROW LEVEL SECURITY means this applies even though the     │
│   app connects as the table-owning role, which Postgres would     │
│   otherwise exempt from its own policies.                         │
└──────────────────────────────────────────────────────────────────┘
   ▼
 201 Created
 { "customer": { "id": "...", "customer_type": "B2B", ... } }
```

The two places tenant isolation is actually enforced — `tenantContext` setting the session variable, and the RLS policy checking it — are independent of each other by design. A bug that skips the middleware (impossible in practice, since every route mounts it) would still be caught by RLS; a hypothetical RLS misconfiguration would still be caught by every repository query's own `WHERE tenant_id = $n` clause. See `02-architecture.md`, "Multi-tenancy: two-layer isolation."
