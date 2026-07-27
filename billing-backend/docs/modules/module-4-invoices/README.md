# Module 4: Invoice Management

_Last updated: 2026-07-23. Reviewers: TBD._

Invoice creation, lifecycle, payments, and PDF rendering. Module 4 is where the system turns one or more `FINALIZED` trip sheets (Module 3) into a legally compliant Tax Invoice with a full GST breakdown, tracks what's actually been paid against it, and produces the PDF document a customer receives — closing the loop from "a trip happened" to "the agency got paid for it."

## Reading order

1. [00-overview.md](00-overview.md)
2. [01-planning-context.md](01-planning-context.md)
3. [02-architecture.md](02-architecture.md)
4. [03-database-schema.md](03-database-schema.md)
5. [04-api-reference.md](04-api-reference.md)
6. [05-design-decisions.md](05-design-decisions.md)
7. [06-error-reference.md](06-error-reference.md)
8. [07-debugging-playbook.md](07-debugging-playbook.md)
9. [08-verification.md](08-verification.md)
10. [known-issues.md](known-issues.md)

Diagrams: [diagrams/](diagrams/) — a request data-flow trace, the entity-relationship diagram, the invoice lifecycle state machine, and the end-to-end invoice-generation flow (picker → draft → issue → PDF).
