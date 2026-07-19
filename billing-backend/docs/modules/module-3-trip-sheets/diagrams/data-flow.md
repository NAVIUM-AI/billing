# Data flow: a single request end to end

_Last updated: 2026-07-19. Reviewers: TBD._

Traces `POST /api/v1/trips` (create a trip sheet) through every layer. The same shape applies to every write in Module 3 — only the validator/service/repository names and the domain module consulted change.

```
 Client
   │  POST /api/v1/trips
   │  Authorization: Bearer <JWT>
   │  { "service_type": "OUTSTATION", "billing_mode": "GST",
   │    "customer_id": "...", "vehicle_id": "...", "trip_date": "...",
   │    "total_km": 1699, "total_days": 5, "fasttag_rupees": 2440, ... }
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
│ requirePermission('trips:write')                                 │
│   looks up req.user.role in src/config/accessMatrix.js           │
│   403 FORBIDDEN if the role isn't listed for this key             │
└──────────────────────────────────────────────────────────────────┘
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ validate(createTripSheetSchema)      [tripSheet.validator.js]    │
│   Joi checks shape: service_type/billing_mode enums, required    │
│   totals, trip_date not in the future, tolls array shape          │
│   400 VALIDATION_ERROR on failure, with per-field messages        │
└──────────────────────────────────────────────────────────────────┘
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ route handler                              [trips.routes.js]     │
│   calls tripSheetService.createTripSheet(tenantId, body, userId, │
│                                            req.db)                │
└──────────────────────────────────────────────────────────────────┘
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ tripSheetService.createTripSheet        [tripSheet.service.js]   │
│   1. Normalize — rupees→paise, parse trip_date, normalize tolls  │
│   2. Derive    — fiscal year from trip_date                      │
│   3. Validate  — km-range check, toll lump-sum-vs-itemized mutex │
│   4. Check + 5. Write, together inside one transaction:          │
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
   ├─▶ customerRepo.findById / vehicleRepo.findById / driverRepo.findById
   │     404 CUSTOMER_NOT_FOUND / VEHICLE_NOT_FOUND / DRIVER_NOT_FOUND
   │
   ├─▶ pricingRuleRepo.findApplicable(vehicle_type, rule_type, trip_date)
   │     400 NO_APPLICABLE_PRICING_RULE if none covers this date
   │
   ├─▶ calculate(rule, usage)              [src/domain/pricing/]
   │     pure function, zero framework imports
   │     throws DomainInputError on bad usage input
   │       → translated to 400 INVALID_CALCULATION_INPUT
   │       at the service boundary (ADR-006)
   │
   ├─▶ tripSheetSequenceRepo.allocateSeq(tenantId, fiscalYear, client)
   │     atomic UPSERT — allocates the next trip sheet number,
   │     inside this same transaction (rolls back together with
   │     the insert below if anything downstream fails)
   │
   ├─▶ tripSheetRepo.insert(..., client)
   │     INSERT INTO trip_sheets (..., snap_*, breakdown, ...)
   │     catch → 409 TRIP_NUMBER_COLLISION on the unique-number
   │       constraint (should not occur under normal operation);
   │     catch → 400 INVALID_KM_RANGE / INVALID_DATETIME_RANGE
   │       on the DB CHECK backstops
   │
   └─▶ tripTollRepo.insertBatch(tripId, tolls, client)
         multi-row INSERT for itemized tolls, if any
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ Postgres                                                          │
│   RLS policy trip_sheets_tenant_isolation evaluates:               │
│     WITH CHECK (tenant_id = current_setting(                      │
│                   'app.current_tenant_id', true)::uuid)           │
│   FORCE ROW LEVEL SECURITY means this applies even though the     │
│   app connects as the table-owning role.                          │
└──────────────────────────────────────────────────────────────────┘
   ▼
 201 Created
 { "trip": { "id": "...", "trip_sheet_number": "TS-1/26-27",
             "status": "DRAFT", "net_payable_paise": 9219000,
             "tolls": [] } }
```

The service-order rule (normalize → derive → validate → check → write) shows up in the diagram as the numbered steps inside `createTripSheet`: normalization and derivation happen before any database round trip at all, the cross-field validation happens before the transaction opens, and "check" (does the customer/vehicle/rule actually exist right now) and "write" (allocate the number, insert the trip, insert its tolls) happen together inside the single `withTenantContext` transaction — because every check from that point on needs live database state, and the whole unit must succeed or fail together: a failed insert must not burn a sequence number, and a sequence number must never be allocated for a trip that didn't actually get created. The pure pricing calculator sits entirely inside the "check + write" phase but is itself framework-free — it neither knows nor cares that it's being called from inside an HTTP request's transaction.
