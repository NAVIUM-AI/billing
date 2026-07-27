# Overview

_Last updated: 2026-07-23. Reviewers: TBD._

## What Module 4 does

An invoice is what turns a `FINALIZED` trip sheet (Module 3) from an internal cost record into a legally compliant document a customer can be billed against. Module 4 covers the full lifecycle: drafting an invoice by picking one or more `FINALIZED`, unheld trips for a single customer (`DRAFT`), issuing it with an atomically-allocated, gap-free invoice number and a frozen snapshot of tenant/customer state (`ISSUED`), recording payments against it until it's fully paid (`PAID`, a derived transition — never set directly), and, if it needs to be reversed after issue, cancelling it with a legally-required credit note rather than deleting anything. Two real reference PDFs from the client anchored every arithmetic and layout decision in this module: `PTT/2026-27/150` (a Local-use Tax Invoice, "Yellow" style) and `PTT/2026-27/151` (an Outstation-use Tax Invoice, "Blue" style); a third, `PTT/2026-27/152` (Proforma), was explicitly out of scope and never built.

Every invoice carries two independent classification axes, mirroring how Module 3 already treats a trip: `invoice_type` (`TAX` or `PERFORMANCE`) and, for `TAX` invoices, a single `service_type` (`LOCAL` or `OUTSTATION`) inherited from whichever trips are on it — Task 4.3 enforces that every trip on one invoice shares the same `service_type`, since the Yellow and Blue layouts are structurally different documents, not the same document with a toggle. A `PERFORMANCE` invoice carries zero GST by design (enforced at the database layer, not just the application) — it's an internal cost sheet, not a tax document, and is rendered with its own PDF template that says so explicitly.

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
Module 3: Trip Sheets
  (records + costs an actual trip; FINALIZED
   trips are the only thing Module 4 can invoice)
              │
              ▼
Module 4: Invoices                           ◄── you are here
  (drafts, issues, and cancels invoices;
   records payments; tracks receivables;
   renders PDF documents)
              │
              ▼
Module 5: (planned — not started)
```

## Tasks 4.1 – 4.6 summary

| Task | Deliverable | Key insight |
| --- | --- | --- |
| 4.1 | Invoice foundation, GST domain, draft CRUD, trip hold | A `*_paise` column declared `BIGINT` (for headroom) comes back from `pg` as a string by default — ADR-009's global type parser is what keeps money arithmetic working across every layer |
| 4.2 | Invoiceable trips picker, reimbursement auto-sum, line editing | Toll/parking/permit/fasttag auto-sum from the selected trips but remember an explicit user override (even an explicit `0`) across a later trip-set change |
| 4.3 | Invoice lifecycle, numbering, immutability, credit-note cancellation | Snapshot `tenant`/`customer` state into JSONB exactly once, at issue — an already-issued invoice never retroactively changes even if the source records are edited later |
| 4.4 | Payments ledger, PAID transition, customer statement, aging report | `ISSUED → PAID` (and its mirror-image reversal) is a *derived* transition, re-computed from the actual payment sum every time, never trusted from a caller-supplied flag |
| 4.5 | PDF rendering | Puppeteer + Handlebars, versioned templates, rendered directly from the frozen issue-time snapshot rather than a fresh tenant/customer lookup |
| 4.6 | Hardening, docs, ADRs, quick-create | Seven ADRs consolidating this module's own recurring lessons; the full docs folder you're reading now; `POST /customers/quick-create` |

## What is NOT in this module

GSTR-1 filing export (a government e-filing format) is not built — nothing in this module produces that file. Email delivery of an invoice or its PDF is not built; a PDF is generated and stored, but nothing sends it anywhere. Payment *receipt* PDFs (a document confirming a payment was received, distinct from the invoice PDF itself) are not built. Recurring/subscription invoices are not built — every invoice here originates from an explicit pick of already-existing `FINALIZED` trips, never from a schedule. Cloud object storage for generated PDFs is not built — see `05-design-decisions.md` for why local filesystem storage was judged sufficient for now.
