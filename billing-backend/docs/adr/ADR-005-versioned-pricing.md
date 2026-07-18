# ADR-005: Pricing rules are versioned; rate values are immutable after create

_Last updated: 2026-07-18. Reviewers: TBD._

## Status

Accepted (2026-07-18)

## Context

An invoice issued in March, at whatever rate was in effect then, must always recompute to the same total if it's ever regenerated or audited later — even after the business has since raised its rates. Two structural approaches address this: (a) never version the pricing master at all, and instead snapshot the resolved rate values directly onto each trip or invoice at the moment it's created, treating the master purely as "today's rate" with no history; or (b) version the master itself, so that a query for "the rate in effect on date X" is answerable for any historical `X`, not only for the present moment.

## Decision

Both, layered. `pricing_rules` is a versioned table: each row carries an `effective_from`/`effective_to` half-open date range, `effective_to = NULL` meaning "still the current version," and a Postgres exclusion constraint (`pricing_rules_no_overlap`, `EXCLUDE USING gist`) guarantees that for a fixed `(tenant_id, rule_type, vehicle_type)`, no two rows' ranges can ever overlap — so at most one rule is ever "the" applicable one for a given date, and the lookup for it is unambiguous by construction rather than by convention. Rate fields are immutable after a row is created: `PATCH /pricing/rules/:id` only permits `label`, `notes`, and `effective_to` (see `05-design-decisions.md`). Changing a rate goes through `POST /pricing/rules/:id/supersede` instead, which atomically closes the existing rule's `effective_to` at the new rule's `effective_from` and inserts the new rule as the new open-ended current version — both statements in one transaction, so there is never a moment where the old rule is closed but the new one doesn't yet exist, or vice versa.

Trip sheets, which Module 3 will introduce, are expected to *additionally* snapshot the resolved rule id and the actual rate values it used at the moment a trip is created or costed — not merely a reference back to `pricing_rules`. This second layer exists specifically so that a rule's later deletion, correction, or any other change to the master cannot retroactively alter a trip's already-recorded cost; the master is authoritative for *new* calculations, the snapshot is authoritative for what a specific past trip actually cost.

## Consequences

`GET /pricing/rules/applicable?on_date=...` (and the preview endpoint built on top of it) answers "what rate applied on this date" correctly for any date, past or present, without special-casing historical lookups — the exclusion constraint means the query is a plain `LIMIT 1` with no tie-breaking logic needed, since ties are structurally impossible. Every rate change is inherently auditable: the full history of what a rate was, when it changed, and to what, is queryable directly from `pricing_rules` by ordering rows by `effective_from` within a `(rule_type, vehicle_type)` group — there is no separate audit log to keep in sync, because the versioning *is* the audit trail.

The cost is twofold. First, once trip sheets add their own snapshot (Module 3), there are genuinely two sources of truth for "what did this rate used to be" — the versioned master and the trip's own snapshot — and they're both correct for different questions: the master answers "what would this calculate to today, using history," the snapshot answers "what did this specific trip actually use." A future engineer needs to know which one to trust for which purpose; the trip snapshot wins whenever the two disagree, since it's the one that actually reflects what was charged. Second, this design deliberately removes the ability to just fix a wrong rate by editing it — a typo'd rate has to be corrected via supersede (which, notably, still can't retroactively fix anything for dates already covered by the wrong version without a further supersede covering that same range going forward) or by archiving and recreating. This is accepted friction: the alternative, allowing in-place rate edits, is exactly the failure mode this entire design exists to prevent.
