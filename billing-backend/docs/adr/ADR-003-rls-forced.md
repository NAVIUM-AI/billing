# ADR-003: Enable AND force Row-Level Security on every business table

_Last updated: 2026-07-18. Reviewers: TBD._

## Status

Accepted (2026-07-18)

## Context

This is a multi-tenant SaaS application where cross-tenant data leakage is not an acceptable failure mode under any circumstance, including a bug in application code. Postgres row-level security (RLS) is the mechanism chosen to enforce tenant isolation at the database layer, as a second, independent line of defense alongside application-level `WHERE tenant_id = ...` clauses (see `02-architecture.md`, "Multi-tenancy: two-layer isolation"). But Postgres RLS has a default behavior that undermines this if not explicitly overridden: a table's *owning* role is exempt from that table's own RLS policies by default, on the reasoning that the owner already has unrestricted access to the table via other means (`ALTER`, `DROP`, etc.), so RLS policies would be a false sense of restriction for that role specifically. This application connects to Postgres as `billing_app`, the same role that owns every table it creates via migrations — meaning, without an explicit override, `ENABLE ROW LEVEL SECURITY` alone would apply to precisely nobody the application actually queries as, and every RLS policy in the schema would be dead weight that looks correct in `\d` but never actually fires.

## Decision

Every business table gets both statements, always as a pair, never one without the other:

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE ROW LEVEL SECURITY;
```

`FORCE` closes the owner-exemption gap: it applies the table's RLS policies even to the owning role (and to the table creator), so the only ways to bypass RLS on a forced table are being a genuine Postgres superuser or a role explicitly granted the `BYPASSRLS` attribute — neither of which the application's runtime connection role has. Every RLS policy across Module 2 (and the tenant-isolation pattern it inherited from Module 1) follows the identical shape:

```sql
CREATE POLICY <table>_tenant_isolation ON <table>
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
```

## Consequences

This is defense in depth in the most literal sense: even a hypothetical query with no `WHERE tenant_id = ...` clause at all — a forgotten filter, a copy-pasted query that dropped it, a future contributor who doesn't yet know the convention — still cannot return or modify another tenant's rows, because the database itself refuses regardless of what the application asked for. A developer or operator who genuinely needs to bypass this (a one-off data-repair script, a support investigation) has to do so explicitly, via `SET LOCAL app.current_tenant_id = '<uuid>'` scoped to a specific tenant, or by connecting as an actual superuser — both of which are visible, intentional acts rather than an accidental side effect of a missing `WHERE` clause, making any such bypass inherently auditable rather than silent.

The cost lands mostly on operational tooling: any bulk operation, migration, or ops script that needs to touch rows across multiple tenants at once either has to loop and set the session variable per tenant, or has to run as a role with `BYPASSRLS` — a role that then needs its own tighter access controls to avoid becoming the new weak point. Debugging is also slightly harder day to day: a query that returns unexpectedly empty results is, once RLS is in play, at least as likely to mean "the tenant context was never set" as "there's genuinely no matching data," and distinguishing the two requires knowing to check for the session variable specifically (`07-debugging-playbook.md` covers this explicitly, since it's a common enough point of confusion to warrant its own entry). Both costs were accepted as the right trade for eliminating an entire class of cross-tenant leak from being possible via ordinary application-layer mistakes.
