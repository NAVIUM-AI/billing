# Planning context

_Last updated: 2026-07-18. Reviewers: TBD._

## Business context

The domain is billing for a cab/travel agency: a business that owns or contracts vehicles and drivers, books them against customers (both individual travelers and corporate accounts), and charges according to one of a few standard pricing structures depending on the kind of trip. `scripts/test-pricing-calc.js` asserts the pricing calculators against numbers taken from two real invoice references — a Cauvery Cars outstation invoice (CI-150) and a Niriksha Travel outstation invoice (CI-1905) — which is where the outstation-slab arithmetic in `src/domain/pricing/outstation.js` was sourced from; the exact source documents are not reproduced in this repository, only the numbers the code is asserted against.

Module 2's pricing engine models three billing shapes, each with its own calculator in `src/domain/pricing/`:

- **Local package** (`local.js`) — a flat base rate for a bundled number of hours and kilometers (e.g. 8 hours / 80 km), plus per-unit overage charges once the trip exceeds either.
- **Outstation slab** (`outstation.js`) — a per-kilometer rate applied to the greater of the actual distance or a per-day minimum, plus a per-day driver allowance ("batta") and pass-through costs like tolls and parking.
- **Performance** (`performance.js`) — a simpler internal cost-tracking shape: a per-kilometer rate plus a flat allowance, used for cost cards rather than customer-facing invoices.

The arithmetic for each is documented where it lives, in the calculator files themselves and in `docs/modules/module-2-master-data/05-design-decisions.md`; how a calculated total becomes a GST-compliant invoice line is Module 4's concern, not this module's.

## User personas

| Role | What they do with master data |
| --- | --- |
| `owner` | Full access to every master, including pricing rates (`pricing:write` is one of the narrowest permissions in the system — see `src/config/accessMatrix.js`) |
| `admin` | Same as owner for master data purposes — can create/edit vehicles, drivers, customers, and pricing rules |
| `accountant` | Read access to vehicles, drivers, customers, and pricing; write access to customers (billing contact details are often an accounting concern) but not to pricing rates |
| `staff` | Can create and edit vehicles, drivers, and customers (day-to-day operational data entry) but explicitly cannot write pricing rules — rates are commercially sensitive and staff shouldn't be able to change what the business charges |
| `viewer` | Read-only across every master — no write permission on any Module 2 entity |

The exact matrix is `src/config/accessMatrix.js`; this table is a paraphrase of it for context, not a substitute — see the top-level `README.md`'s "Access matrix" section for the authoritative, kept-in-sync copy.

## Requirements that drove Module 2 design

1. **Historical invoices must regenerate at their original rates.** A rate hike in April can't silently change what a March invoice would calculate to if it were regenerated. This is why pricing rules are versioned with `effective_from`/`effective_to` ranges rather than edited in place — see ADR-005.
2. **B2B customers need GSTIN for input tax credit.** A company customer claiming GST input credit needs the agency's invoice to carry a valid GSTIN, and the GSTIN's embedded state code has to agree with the customer's declared state (it determines IGST vs. CGST+SGST at invoice time). This drove the B2C/B2B polymorphism and the GSTIN state cross-check in `customer.service.js`.
3. **The same vehicle number gets typed different ways.** "KA 51 AK 1031", "KA-51-AK-1031", and "ka51ak1031" are the same physical vehicle; without normalization each variant would silently create a duplicate record. This drove the canonical/display column pattern used for `vehicle_number` (Task 2.1) and reused for `phone` (Tasks 2.2/2.3).
4. **Multi-tenant SaaS with zero tolerance for cross-tenant leakage.** Every Module 2 table has Postgres row-level security both enabled and forced (`ALTER TABLE ... FORCE ROW LEVEL SECURITY`), so even a bug that produces a query with no `WHERE tenant_id = ...` at all still can't return another tenant's rows. This is a continuation of the pattern established in Module 1, not new to Module 2, but every table added here follows it — see ADR-003.
5. **Drivers may or may not be tracked formally.** Some agencies keep detailed license/phone records per driver; others don't track drivers as a distinct entity at all. Rather than forcing a data model that assumes formal tracking, every field on `drivers` except `full_name` is optional, including phone and license number — see `docs/modules/module-2-master-data/05-design-decisions.md`.

## Out of scope

The following are explicitly deferred, each to whichever later module actually owns them:

- **E-invoicing / IRP integration** — validating and registering invoices with the government's Invoice Registration Portal. Deferred to Module 4 (Invoicing & GST) or later.
- **Driver payouts** — tracking what an agency owes a driver for completed trips. Not yet assigned to a module.
- **Credit-limit enforcement** — a B2B customer's `credit_days` field is stored (Task 2.3) but nothing in Module 2 enforces a credit *limit* or blocks a booking when one is exceeded. Deferred to whichever module handles invoicing/collections.
- **GSTIN portal verification** — Module 2 validates GSTIN *format* and cross-checks its embedded state code, but never calls out to the GST department's systems to confirm a GSTIN is actually registered and active. Flagged as a later integration in `src/utils/gstin.js`'s top-of-file comment.
