# ADR-008: Auth tables (`users`, `refresh_tokens`) are intentionally excluded from Row-Level Security

_Last updated: 2026-07-19. Reviewers: TBD._

## Status

Accepted (retroactive — this has been the actual behavior since Task 1.4; this record documents a decision that was made in code but never written down).

## Context

Every business table added since Task 1.4's RLS pattern was introduced — `vehicles`, `drivers`, `customers`, `customer_contacts`, `pricing_rules`, `trip_sheets`, `trip_sheet_sequences`, `trip_tolls`, and `tenant_pings` itself — has row-level security both enabled and forced, filtering on the `app.current_tenant_id` Postgres session variable that `tenantContext` middleware sets once a request is authenticated. `users` and `refresh_tokens` are the two tables that do not follow this pattern, and that omission was never captured as a deliberate decision anywhere — it was simply how Task 1.4's migration was written, and every later ADR and doc describing "every business table has forced RLS" has had to silently carve out an exception for these two without saying so.

The reason the exception exists is structural, not an oversight: RLS depends on `app.current_tenant_id` being set before the query runs, and both `users` and `refresh_tokens` are read at points in the request lifecycle where that variable cannot yet exist, because the request hasn't been authenticated yet.

- **Login** (`auth.service.js#login`) calls `userRepository.findByEmail(email)` — a query with no tenant_id argument at all — before any token exists to derive a tenant from. The caller supplies only an email and password; which tenant that email belongs to is exactly what this query is answering. If `users` had forced RLS, this query would need `app.current_tenant_id` set to return any row, but the tenant id is not yet known to the server at this point in the flow — it's the output of this query, not an input available before it.
- **Refresh** (`auth.service.js#refresh`) calls `refreshTokenRepository.findActiveByHash`/`findAnyByHash`, which look a presented refresh token up by its SHA-256 hash alone, before `tenantContext` middleware has run (the refresh endpoint sits outside the authenticated route chain, since its entire purpose is to issue a fresh access token when the old one has expired).

## Decision

`users` and `refresh_tokens` remain outside the RLS regime. Both are queried during a pre-tenant-context phase of the request lifecycle, and tenant isolation for both is enforced at the application layer — explicit `tenant_id` (or, for `refresh_tokens`, token-hash) predicates in the repository's own SQL — rather than at the database layer via a session-variable-gated policy.

## Rationale

`user.repository.js#findByEmail` is the one query that deliberately does *not* filter by tenant: it's used both by signup (checking whether the email is already in use in *any* tenant, since the same person creating two tenants with one email would create login ambiguity later) and by login (finding which tenant an email belongs to in the first place). This is safe specifically because signup's cross-tenant check guarantees at most one `(tenant_id, email)` row can exist for a given email in practice, even though the database's own unique constraint is scoped to `(tenant_id, email)`, not `email` alone — the invariant is enforced in the application, not the schema.

Every other `users` query — `findByEmailAndTenant`, `findByIdAndTenant`, `listByTenant`, `countByTenantAndRole`, `updateRole`, `setActive` — runs after `authenticate` + `tenantContext` have populated the request with a known tenant id, and every one of them includes an explicit `WHERE tenant_id = $n` clause. `user.repository.js`'s own top-of-file comment on `findByIdAndTenant` states this directly: with RLS not enabled on `users`, that `WHERE` clause is *currently the only barrier* preventing one tenant's admin from reaching another tenant's user by guessing or enumerating a `userId` — every user-management repository function is written to guard the same way, and a userId path parameter is never trusted alone.

`refresh_tokens` takes a different but equally deliberate approach: `findActiveByHash` and `findAnyByHash` key exclusively on `token_hash` — a SHA-256 hash of a cryptographically random token, unique across the whole table by a database constraint (`refresh_tokens_hash_unique`) — with no `tenant_id` predicate in either query. This is not an isolation gap: the hash itself is the security boundary. An attacker cannot enumerate or guess another tenant's token hash any more easily than they could enumerate another tenant's own token, so scoping the lookup by tenant_id in addition would add no real isolation, only a redundant predicate. `tenant_id` is still stored on every `refresh_tokens` row and returned in the result, and every *other* operation on the table that isn't a hash lookup — `revokeAllForUser`, used on reuse-detection to invalidate a user's whole session lineage — scopes by `user_id`, which is itself only ever known after the user has already been resolved through a tenant-checked path.

## Consequences

Login and refresh work correctly without any session-variable setup, because neither needs one — `findByEmail` and the hash lookups are answerable with the information actually available at that point in the request. Auth queries stay simple and directly testable without `SET LOCAL` scaffolding around them, and `scripts/verify-auth.sh`'s direct-`psql` assertions don't need to simulate a tenant context to inspect `users`/`refresh_tokens` state.

The cost is that these two tables rely on the repository layer to get every `WHERE` clause right by hand, rather than having a database-level backstop the way every other table does. A future change to `user.repository.js` or `refreshToken.repository.js` that introduces a tenant-scoped query without the corresponding `tenant_id` predicate would leak cross-tenant with nothing at the database layer to catch it — the mitigation is that these two files are small, rarely touched, and every function's tenant-scoping intent is documented inline (as `findByIdAndTenant`'s comment already does), so a missing predicate should be visible on review rather than needing a runtime guard to catch it. If a future feature needs a genuinely tenant-scoped query against `users` (e.g. "list all users for the current tenant," which `listByTenant` already is), that query does not need RLS to be correct — the tenant id is known from the authenticated request and enforced the same way `listByTenant` already enforces it, at the repository's own `WHERE` clause.

## Alternatives considered

- **Enable RLS on `users` with a policy that allows all rows when the session variable is unset.** Rejected: this is a permanent, structural bypass baked into the policy itself — anywhere the variable is accidentally left unset for any reason, RLS silently grants full cross-tenant access instead of denying it, which is the opposite failure mode RLS exists to prevent.
- **Set a synthetic "system" tenant id during login and refresh, before the real tenant is known.** Rejected: this creates a phantom tenant with no corresponding `tenants` row that would need special-casing everywhere a foreign key or audit log references `tenant_id`, in exchange for satisfying an RLS policy that a plain `WHERE` predicate already satisfies more simply.

## References

Task 1.4 (introduced the RLS pattern via `tenant_pings`, established the forced-RLS convention every later business table follows); Task 1.5 (RBAC and user management assume tenant-scoped `users` queries — every function it added filters by `tenant_id` explicitly, consistent with this ADR); `src/repositories/user.repository.js` (the `findByIdAndTenant` comment documents this reasoning inline, predating this ADR); `scripts/verify-auth.sh` (its DB-layer assertions read `users`/`refresh_tokens` directly via `psql` with no session variable set, which only returns meaningful data because these tables are not RLS-forced).
