# Overview

_Last updated: 2026-07-19. Reviewers: TBD._

## What Module 3 does

A trip sheet is the record of one billable (or internally cost-tracked) journey: which vehicle and driver ran it, for which customer, on what date, for how much. `trip_sheets` is the source-of-truth transactional table the rest of the billing system is built on — Module 2's masters (vehicles, drivers, customers, pricing rules) describe entities that exist independent of any single trip; Module 3 is where those entities are actually consumed to produce a costed, auditable record of something that happened. Two real-world reference invoices drove the arithmetic and format decisions throughout this module: a Cauvery Cars outstation invoice (CI-150, ₹92,190) and a Niriksha Travel outstation invoice (CI-1905, ₹62,768 gross / ₹37,768 net after a ₹25,000 advance) — both reproduced exactly, to the paise, by `scripts/verify-trip-sheet-outstation.sh` and `scripts/test-pricing-calc.js`.

Every trip sheet carries two independent classification axes: `service_type` (`LOCAL` or `OUTSTATION`) and `billing_mode` (`GST` or `PERFORMANCE`), giving four combinations, all of which route through the same `trip_sheets` table and the same lifecycle, differing only in which pricing calculator (`src/domain/pricing/`) computes the total. A trip sheet is created in `DRAFT` status, is freely editable while a draft, and moves through an explicit state machine (`DRAFT → FINALIZED → INVOICED`, or `→ CANCELLED` from either `DRAFT` or `FINALIZED`) that Module 4 will extend when it adds the invoice-issue flow.

## Position in the system

```
Module 1: Auth & Tenancy
  (tenants, users, JWT auth, RBAC, RLS foundation)
              │
              ▼
Module 2: Master Data Management
  (vehicles, drivers, customers, pricing rules)
              │
              ▼
Module 3: Trip Sheets                        ◄── you are here
  (records + costs an actual trip, using
   Module 2's masters and pricing engine;
   lifecycle, listing, performance sheets)
              │
              ▼
Module 4: Invoicing & GST
  (turns one or more FINALIZED trip sheets
   into a GST-compliant invoice; transitions
   them to INVOICED)
```

## Tasks 3.1 – 3.6 summary

| Task | Deliverable | Key insight |
| --- | --- | --- |
| 3.1 | `trip_sheets` schema + LOCAL trip creation | Snapshot rate/customer/vehicle fields onto the trip row at creation time — a trip's numbers never change even if the source rule or master record does later |
| 3.2 | Outstation trip creation + itemized tolls | Slab pricing on `max(actual_km, min_km_per_day × days)`, driver batta multiplied by `total_days`, `trip_tolls` as a child table for per-plaza receipts |
| 3.3 | Lifecycle state machine + draft editing | `SELECT ... FOR UPDATE` row lock plus a guarded `UPDATE ... WHERE status = $from` make every transition safe under concurrency without an application-level lock manager |
| 3.4 | List + filters + aggregates | Aggregates (sums, counts by status) are computed for the *filtered* set, not the current page, by reusing the same `WHERE` clause array for both the data query and the aggregates query |
| 3.5 | Performance sheet + CSV export | A read-only projection over `billing_mode='PERFORMANCE'` trips — no new table, no new entity, just a grouped view with RFC 4180 CSV export |
| 3.6 | Hardening + docs | Selective 5xx message masking (ADR-007), the auth-tables-no-RLS decision written down retroactively (ADR-008), and this documentation pass |

## What is NOT in this module

Invoicing, payments, and invoice-level GST computation (tax split, e-invoicing/IRP registration) are Module 4's concern — a trip sheet's `net_payable_paise` is a cost figure, not a tax-compliant invoice line. PDF rendering (trip sheet printouts, performance-sheet exports beyond CSV) is not built. The `INVOICED` status transition exists in the state machine and `markTripInvoiced` exists as a service function, but no route exposes it — Module 4's invoice-issue flow will call it directly, from within its own transaction, once that module ships.
