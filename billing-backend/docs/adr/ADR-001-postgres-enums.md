# ADR-001: Use Postgres native enums for controlled vocabularies

_Last updated: 2026-07-18. Reviewers: TBD._

## Status

Accepted (2026-07-18)

## Context

Several columns across the schema have a small, finite, business-meaningful set of valid values: a vehicle's `vehicle_type` (`vehicles.vehicle_type`, introduced in Task 2.1 and reused by `pricing_rules.vehicle_type`), a customer's `customer_type` (`B2C`/`B2B`), and a pricing rule's `rule_type` (`LOCAL_PACKAGE`/`OUTSTATION_SLAB`/`PERFORMANCE`). Three options were available for representing each: (a) a plain `VARCHAR` column with the allowed values enforced only in application code, (b) a lookup table with a foreign key from the main table to it, or (c) a Postgres native `ENUM` type.

## Decision

Use native Postgres `ENUM` types (`vehicle_type_enum`, `customer_type_enum`, `pricing_rule_type_enum`), one per controlled vocabulary, each defined with `CREATE TYPE ... AS ENUM (...)` in the migration that introduces it.

## Consequences

An `INSERT` or `UPDATE` with a value outside the enum's declared set fails immediately at the database layer, with no possibility of an invalid value slipping through a code path that forgot to validate — this is strictly stronger than the VARCHAR-plus-application-allowlist option, where every single write path has to remember to check. The storage footprint is small (an enum value is stored as 4 bytes, an OID-like reference, not the text itself), and the schema is self-documenting: `\d vehicle_type_enum` in `psql` shows every valid value without needing to go read application code or a separate lookup table.

The cost shows up when the vocabulary needs to change. Adding a value is a normal migration (`ALTER TYPE vehicle_type_enum ADD VALUE 'NEW_VALUE'`) and, as of Postgres 12+, can run inside a transaction alongside other DDL without the historical restriction that required it to run standalone — but renaming or removing a value is genuinely hard, requiring either a full type-recreation dance (create a new type, migrate every dependent column, drop the old type) or leaving a value permanently in the enum even after the business stops using it. Because a rolling deploy can also briefly have some application instances aware of a newly-added value and others not, any code path that switches exhaustively on an enum's values (see `src/domain/pricing/dispatch.js`'s `switch (rule.rule_type)`) needs a `default` case that fails loudly rather than silently mishandling an unrecognized value — which `dispatch.js` does, throwing a `TypeError` naming the unrecognized `rule_type`.

The alternative lookup-table option was rejected mainly on the "add a value" axis: it would make adding a vocabulary value a plain `INSERT` instead of a migration, which sounds like a win, but it also means the constraint that a column can *only* hold one of the currently-valid values requires an explicit foreign key plus (for anything requiring per-row uniqueness or ordering among the values) more schema than a bare enum needs. Given the specific vocabularies in this schema change rarely — a new vehicle category or a new pricing rule shape is a deliberate, infrequent product decision, not a runtime configuration value — the migration cost of adding an enum value was judged an acceptable trade for the stronger write-time guarantee.
