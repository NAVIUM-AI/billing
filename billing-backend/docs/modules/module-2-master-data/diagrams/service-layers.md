# Service layers

_Last updated: 2026-07-18. Reviewers: TBD._

The same four-layer stack (`02-architecture.md`) redrawn as a vertical stack, with each layer's responsibility and the concrete file pattern it lives in.

```
┌─────────────────────────────────────────────────────────────────┐
│  HTTP client                                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  ROUTES                              src/api/v1/*.routes.js      │
│  ─────────────────────────────────────────────────────────────  │
│  • Wires authenticate + tenantContext + requirePermission(key)   │
│  • Calls exactly one service function per handler                │
│  • Shapes the HTTP response (status code, JSON body)              │
│  • NO business logic. NO SQL.                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  VALIDATORS                    src/validators/*.validator.js     │
│  ─────────────────────────────────────────────────────────────  │
│  • Joi schemas: required fields, types, string/number formats    │
│  • Two-form fields (phone, vehicle number, GSTIN) normalize via  │
│    .custom() into { canonical, display } or a plain canonical    │
│    string, right here at the boundary                            │
│  • Does NOT decide cross-field requirements (e.g. "GSTIN only    │
│    required for B2B") — that depends on data the schema doesn't  │
│    have clean context for; deferred to the service layer          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  SERVICES                        src/services/*.service.js       │
│  ─────────────────────────────────────────────────────────────  │
│  • ALL business rules live here                                  │
│  • Every create/update follows: normalize → derive → validate →  │
│    check → write (the "service-order rule", 02-architecture.md)  │
│  • Owns the transaction boundary: db.withTenantContext(...)      │
│  • Converts wire units to storage units (rupees → paise)         │
│  • Decides 404/409/400 business errors (not found, duplicate,    │
│    archived-exists, cross-field mismatch)                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  REPOSITORIES                 src/repositories/*.repository.js   │
│  ─────────────────────────────────────────────────────────────  │
│  • EVERY line of SQL for one table lives in exactly one file     │
│  • Accepts already-normalized primitives + a tenant-scoped       │
│    pg client — never re-normalizes, never re-derives              │
│  • Maps Postgres constraint violations (unique/check/exclusion)  │
│    to specific apiError codes                                     │
│  • Every WHERE still includes tenant_id — belt and suspenders    │
│    alongside RLS, not a substitute for it                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  POSTGRES                                                         │
│  ─────────────────────────────────────────────────────────────  │
│  • FORCE ROW LEVEL SECURITY on every business table               │
│  • CHECK constraints as the non-bypassable backstop for rules     │
│    the service layer already enforces (belt and suspenders)       │
│  • Exclusion / unique constraints as the source of truth for      │
│    concurrency-sensitive invariants (no two overlapping pricing   │
│    rules; no two contacts marked primary) that a service-layer    │
│    pre-check alone cannot fully guarantee under a race             │
└─────────────────────────────────────────────────────────────────┘
```

A request only ever flows downward through this stack; nothing below the service layer calls back up into it, and repositories never call other repositories directly (a repository that needs another table's data receives it as an argument from the service, which is the layer allowed to coordinate more than one repository — see `customer.service.js#addContact`, which reads a customer via `customerRepository.findById` before writing a contact via `customerRepository.insertContact`, both against the same transaction-scoped client).
