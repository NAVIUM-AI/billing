# Module 3: Trip Sheet Management

_Last updated: 2026-07-19. Reviewers: TBD._

Trip sheets are the transactional heart of the system. Every billable event — a local booking, an outstation run, an internal cost-tracking trip — becomes one row in `trip_sheets`. All master data from Modules 1-2 (tenants, users, vehicles, drivers, customers, pricing rules) gets consumed here to create and price that row; every invoice Module 4 will ever issue is built from a finalized trip sheet.

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

Diagrams: [diagrams/](diagrams/) — a request data-flow trace, the entity-relationship diagram, and the lifecycle state machine.
