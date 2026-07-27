# Architecture Decision Records

_Last updated: 2026-07-23. Reviewers: TBD._

An Architecture Decision Record captures a single significant technical decision — the problem that forced it, what was decided, and what trade-offs were accepted — at the time it was made. The point isn't to document *what* the code does (that's what the rest of `docs/` and the code itself are for); it's to preserve *why* the code looks the way it does, so that six months from now, when the reasoning has faded from everyone's memory, nobody has to reverse-engineer intent from a diff or re-litigate a decision that was already made deliberately. An ADR is written once, at decision time, and only ever amended by a new ADR that supersedes it — not edited in place to reflect hindsight.

Each ADR in this repository follows Michael Nygard's original format: **Status**, **Context**, **Decision**, **Consequences**. `template.md` is the blank starting point for a new one. Numbering is sequential (`ADR-001`, `ADR-002`, ...) and never reused, even if a later ADR supersedes an earlier one — the old number stays attached to the old record. Status values in use:

- **Proposed** — written, not yet adopted.
- **Accepted** — the decision is in effect; this is the status of every ADR below.
- **Superseded by ADR-YYY** — a later decision replaced this one; the record stays for history, with a pointer forward.
- **Deprecated** — no longer in effect and not replaced by a specific successor ADR.

## Index

| # | Title | Status | Date |
| --- | --- | --- | --- |
| [ADR-001](ADR-001-postgres-enums.md) | Use Postgres native enums for controlled vocabularies | Accepted | 2026-07-18 |
| [ADR-002](ADR-002-money-in-paise.md) | Store and compute money as integer paise | Accepted | 2026-07-18 |
| [ADR-003](ADR-003-rls-forced.md) | Enable AND force Row-Level Security on every business table | Accepted | 2026-07-18 |
| [ADR-004](ADR-004-normalize-in-service.md) | Normalization is a service-layer responsibility | Accepted | 2026-07-18 |
| [ADR-005](ADR-005-versioned-pricing.md) | Pricing rules are versioned; rate values are immutable after create | Accepted | 2026-07-18 |
| [ADR-006](ADR-006-domain-error-translation.md) | Pure domain modules throw a dedicated DomainInputError class; services translate to apiError at their boundary | Accepted | 2026-07-18 |
| [ADR-007](ADR-007-selective-5xx-masking.md) | Selective 5xx message masking in the global error handler | Accepted | 2026-07-19 |
| [ADR-008](ADR-008-auth-tables-no-rls.md) | Auth tables (users, refresh_tokens) are intentionally excluded from Row-Level Security | Accepted | 2026-07-19 |
| [ADR-009](ADR-009-bigint-as-integer.md) | Global type parser converts BIGINT columns to JS numbers at the pg driver layer | Accepted | 2026-07-23 |
| [ADR-010](ADR-010-invoice-lines-taxable-revenue.md) | Invoice lines carry only taxable service revenue; reimbursements live on invoice-level columns | Accepted | 2026-07-23 |
| [ADR-011](ADR-011-correlated-subquery-bound-params.md) | Correlated subqueries reference the outer scope via bound parameters, never unqualified column names | Accepted | 2026-07-23 |
| [ADR-012](ADR-012-dedicated-reversal-functions.md) | transitionStatus's COALESCE pattern can only add values, never clear them — reversal transitions get a dedicated function instead | Accepted | 2026-07-23 |
| [ADR-013](ADR-013-synthetic-payment-references.md) | Synthetic payment references include every parameter of the business event they represent | Accepted | 2026-07-23 |
| [ADR-014](ADR-014-specs-reference-actual-schema.md) | Task specs should reference the actual schema, not an imagined one | Accepted | 2026-07-23 |
| [ADR-015](ADR-015-visual-review-required.md) | Tasks that render a human-consumable document require visual review as an acceptance criterion | Accepted | 2026-07-23 |
