# Module 2: Master Data Management

_Last updated: 2026-07-18. Reviewers: TBD._

## What this module does

Master data is the set of records that describe the stable entities a business operates on, as opposed to transactional data, which records the events that happen to those entities over time. A vehicle exists whether or not it's on a trip today; a customer exists whether or not they have an invoice this month. Keeping master data in its own set of tables — rather than inlining a vehicle's registration number or a customer's GSTIN into every trip sheet and invoice row that references it — means an agency onboards a vehicle, driver, or customer once and reuses that record for every future transaction, and a correction (a fixed phone number, a renamed vehicle) only has to happen in one place.

Module 2 introduces four such entities: **vehicles** (Task 2.1), **drivers** (Task 2.2), **customers** (Task 2.3, split into B2C individuals and B2B companies), and **pricing rules** (Task 2.4, the versioned rate tables that later modules will use to calculate what a trip costs). All four follow the same shape — a tenant-scoped Postgres table protected by row-level security, a repository that holds the raw SQL, a service that holds the business rules, Joi validators at the HTTP boundary, and a `scripts/verify-*.sh` script that exercises the whole stack end to end — because that consistency is itself part of the design: once an engineer understands one master, the other three are variations on the same pattern rather than four things to learn separately.

Pricing rules are the odd one out in a useful way: they're master data (a rate doesn't change per-trip) but they also carry a pure calculation engine (`src/domain/pricing/`) with zero framework dependencies, because "what does this trip cost" is a piece of business logic worth being able to test and audit in isolation from the HTTP/database plumbing around it.

## Position in the system

Module 2 sits between Module 1, which establishes who a request is coming from and which tenant it belongs to, and Module 3, which will use vehicles, drivers, customers, and pricing rules to actually build trip sheets. Everything in Module 2 depends on Module 1's `authenticate` + `tenantContext` + `requirePermission` middleware chain and on the tenant/user schema it created; nothing in Module 2 depends on anything that comes after it.

```
Module 1: Auth & Tenancy
  (tenants, users, JWT auth, RBAC, RLS foundation)
              │
              ▼
Module 2: Master Data Management            ◄── you are here
  (vehicles, drivers, customers, pricing rules)
              │
              ▼
Module 3: Trip Sheets
  (uses vehicles/drivers/customers/pricing rules
   to record and cost an actual trip)
              │
              ▼
Module 4: Invoicing & GST
  (turns a trip sheet into a GST-compliant invoice)
```

## Modules 2.1 – 2.4 summary

| Task | Entity | Key behavior |
| --- | --- | --- |
| 2.1 | Vehicles | Canonical + display registration number, normalized on write so formatting variants dedupe; `vehicle_number` immutable after creation |
| 2.2 | Drivers | Every field except `full_name` is optional (agencies that don't formally track drivers can still use the module); phone and license each dedupe independently via partial unique indexes |
| 2.3 | Customers | Single table for B2C (individual) and B2B (company) customers, with conditional required fields enforced at both the Joi and database layers; GSTIN's embedded state code is cross-checked against `state_code` |
| 2.4 | Pricing rules | Versioned rate tables — `PATCH` can only touch `label`/`notes`/`effective_to`, a rate change goes through `POST /supersede` instead, and a Postgres exclusion constraint guarantees at most one rule is active per (tenant, rule type, vehicle type) on any given date |

## What is NOT in this module

Trip sheets (recording an actual journey against a vehicle/driver/customer) are Module 3. Invoices, payments, and GST computation are Module 4. Reports/analytics don't have a module number assigned yet. Pricing rules define *rates*; they do not calculate a real invoice total for a real trip — that consumption happens in Module 3, which will read the applicable rule via `GET /pricing/rules/applicable` and run it through the calculators in `src/domain/pricing/`.
