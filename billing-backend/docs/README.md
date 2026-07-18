# Billing Backend — Engineering Documentation

_Last updated: 2026-07-18. Reviewers: TBD._

## About this documentation

This is the engineering documentation for the billing backend, organized by module in the order the system was built. Each module's docs cover the business context that drove its design, the architecture and database schema, the API contracts, the reasoning behind non-obvious decisions, and the operational knowledge (error codes, debugging, verification) an engineer needs to work on it confidently without re-deriving everything from the source. Architecture Decision Records (ADRs) live separately and capture cross-cutting technical choices that outlive any single module.

## Reading order for new engineers

Start with a module's `00-overview.md` to understand what it does and where it sits in the system, then `01-planning-context.md` for why it exists in its current shape. From there, `02-architecture.md` and `03-database-schema.md` give the structural picture, `04-api-reference.md` is the contract you'll actually code against, and `05-design-decisions.md` explains the trade-offs so you don't accidentally "fix" something that was deliberate. `06-error-reference.md`, `07-debugging-playbook.md`, and `08-verification.md` are the ones you'll come back to repeatedly once you're actively building on the module. The ADRs in `adr/` are worth skimming once — they capture decisions (native enums, money-as-paise, forced RLS, normalize-in-service, versioned pricing) that apply across every module, not just the one that introduced them.

## Module docs

| Module | Covers | Status |
| --- | --- | --- |
| Module 1: Auth & Tenancy | Signup/login, JWT + refresh tokens, RBAC, tenant isolation (RLS) | TODO — not yet written |
| Module 2: Master Data Management | Vehicles, drivers, customers, pricing rules | [Complete](modules/module-2-master-data/00-overview.md) |
| Module 3: Trip Sheets | TODO | Not started |
| Module 4: Invoicing & GST | TODO | Not started |

## Architecture Decision Records

Cross-cutting technical decisions live in [`adr/`](adr/README.md), each as a standalone record in Michael Nygard's format (Context / Decision / Consequences). Start there if you're trying to understand *why* something is built a particular way rather than *what* it does.

## How to contribute

Docs are written from the actual code, not from memory or intent — if you change behavior that a doc describes, update the doc in the same change, and if you're documenting something you're not certain about, mark it `TODO` rather than guessing. Keep prose in explanation sections and reserve bullet lists for genuine reference material (tables of endpoints, error codes, columns); a wall of bullets where a paragraph belongs is harder to read, not easier.
