# Planning context

_Last updated: 2026-07-23. Reviewers: TBD._

## Business context

The domain, continued from Modules 2-3, is billing for a cab/travel agency — Pravasi Tours in every verify script's fixture data. Module 3 recorded and costed an actual trip; Module 4 is where that trip becomes something the customer is legally billed for. Two real reference invoices the client supplied drove this module's GST arithmetic, layout, and terminology directly: `PTT/2026-27/150` (Local-use Tax Invoice, rendered as the "Yellow" template) and `PTT/2026-27/151` (Outstation-use Tax Invoice, "Blue"). A third reference, `PTT/2026-27/152` (Proforma), was explicitly named as out of scope for this module and was never built — there is no proforma-invoice concept anywhere in this schema.

## User personas

| Role | What they do with invoices/payments |
| --- | --- |
| `owner` | Full access: draft, edit, issue, cancel, record/cancel payments, read reports |
| `admin` | Same as owner |
| `accountant` | Draft, edit, issue, record payments, read reports — cancellation of an ISSUED invoice is grouped with owner/admin only (`invoices:cancel`), narrower than issue |
| `staff` | Draft and edit invoices, record payments (front-desk cash/UPI collection) — cannot issue, cannot cancel, cannot access financial reports |
| `viewer` | Read-only: invoices, payments, reports (widened to include reports in Task 4.6 — see `05-design-decisions.md`) |

The exact matrix is `src/config/accessMatrix.js` (`invoices:read`, `invoices:draft`, `invoices:issue`, `invoices:cancel`, `payments:record`, `payments:cancel`, `payments:read`, `reports:read`); this table paraphrases it for context. `invoices:cancel` is narrower than `invoices:issue` (owner/admin only, no accountant) — cancelling an already-issued invoice requires a credit note and is a step up in consequence from issuing one in the first place. `payments:cancel` is likewise narrower than `payments:record` (no staff) — the same "front-desk can collect, only a supervisor reverses" relationship Module 3 already established between `trips:write` and `trips:cancel`.

## Requirements that drove Module 4 design

1. **Tax invoices must be legally compliant.** CGST+SGST for an intra-state sale, IGST for inter-state, computed off the customer's and tenant's `state_code`; HSN/SAC code `996601` ("Renting of vehicles") on every line; a gap-free, per-tenant, per-invoice-type, per-fiscal-year number allocated only at the moment of issue, never at draft creation — a draft that's deleted or never issued must never have consumed a number. See `02-architecture.md` and ADR-001/ADR-002-adjacent conventions this module continues.
2. **The same customer must be billable via either a Tax invoice or a Performance (internal cost) invoice at different times**, without those being different customer records or different trip records — `invoice_type` is a property of the invoice, chosen at draft-creation time from whichever `FINALIZED` trips are picked.
3. **An issued invoice must never retroactively change**, even if the tenant's business profile or the customer's own record is edited afterward. This is the reason `tenant_snapshot`/`customer_snapshot` JSONB exist and are populated exactly once, at issue (Task 4.3; ADR-014 documents a related spec-vs-schema gap found while building this).
4. **Concurrent issue must be safe.** Two requests racing to issue the same DRAFT, or two requests each issuing a different DRAFT at the same moment, must produce exactly one winner per invoice and gap-free, non-colliding numbers across the two — the same row-lock-plus-guarded-UPDATE discipline Module 3 established for trip lifecycle transitions.
5. **Cancelling an issued invoice requires a credit note, never a deletion.** GST compliance treats a cancelled tax invoice as a document that must be formally reversed by an equal-and-opposite document, not erased as though it never existed — see `05-design-decisions.md`.
6. **Advances (money received before or independent of any specific invoice) are tracked internally and applied to a specific invoice only when the ops team explicitly does so** — never auto-applied, never shown to the customer as a line on the original invoice itself (Task 4.4).
7. **Generated PDFs must match the client's own Yellow/Blue mental model** — the exact reference documents they already send customers today, not a generic invoice template reinvented from scratch (Task 4.5).

## Out of scope

- **GSTR-1 export.** No file in a government e-filing format is produced by this module. A future module would need to aggregate issued-invoice data into that specific format.
- **Email delivery.** Nothing in this module sends a PDF or a notification anywhere — PDF generation produces a file on the server's filesystem, retrievable via an authenticated `GET`, and that's the entire delivery mechanism today.
- **Payment receipt PDFs.** Only invoice and credit-note PDFs are rendered; a document confirming a payment was received is not built.
- **Recurring/subscription invoices.** Every invoice originates from an explicit pick of already-`FINALIZED` trips at draft-creation time; there is no scheduling or auto-generation concept.
- **Cloud PDF storage.** PDFs are written to a configurable local filesystem path (`PDF_STORAGE_ROOT`), not an object-storage service — see `05-design-decisions.md` for the reasoning and what would need to change to move off it.
