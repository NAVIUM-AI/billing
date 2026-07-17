# Billing Backend

Backend API for a multi-tenant billing SaaS.

## Prerequisites

- Node.js 20+
- PostgreSQL 15+

## Setup

1. Clone the repo and install dependencies:

   ```bash
   npm install
   ```

2. Copy the example env file and fill in your local values:

   ```bash
   cp .env.example .env
   ```

   Generate `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`:

   ```bash
   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
   ```

   Run it **twice** and put one output in each variable — they must be
   different values. Never commit `.env` or hardcode secrets in source.

3. Create a local Postgres database matching the name in your
   `DATABASE_URL` (default: `billing_dev`):

   ```bash
   createdb billing_dev
   ```

   The app connects as a dedicated, non-superuser role (`billing_app`
   by default) rather than your own Postgres superuser — this matters
   because Postgres row-level security (see "Verifying tenant
   isolation" below) is always bypassed for superusers, no matter what
   policies are defined. Create the role and let it own the schema:

   ```bash
   psql -d billing_dev -c "CREATE ROLE billing_app WITH LOGIN PASSWORD 'changeme' NOSUPERUSER;"
   psql -d billing_dev -c "GRANT USAGE, CREATE ON SCHEMA public TO billing_app;"
   ```

   Then point `DATABASE_URL` in `.env` at that role:

   ```
   DATABASE_URL=postgresql://billing_app:changeme@localhost:5432/billing_dev
   ```

4. Run migrations to create the schema:

   ```bash
   npm run migrate:up
   ```

5. Start the dev server (auto-restarts on file changes):

   ```bash
   npm run dev
   ```

## Verify it's running

```bash
curl http://localhost:8000/health
# => { "status": "ok", "timestamp": "..." }
```

## Scripts

| Script                | Purpose                                   |
| ---------------------- | ------------------------------------------ |
| `npm run dev`           | Start server with nodemon (auto-reload)    |
| `npm start`             | Start server (production)                  |
| `npm run migrate:up`    | Apply all pending migrations               |
| `npm run migrate:down`  | Revert the last applied migration          |
| `npm run migrate:create -- <name>` | Scaffold a new migration file  |
| `npm run verify:auth`   | Run the automated auth flow check (see below) |
| `npm run verify:tenants` | Run the automated tenant isolation check (see below) |

## Verifying auth module

`scripts/verify-auth.sh` exercises the full Task 1.3 auth flow end to
end — signup, login, `/me` (with and without a token), refresh
rotation, refresh-reuse detection, and the resulting `refresh_tokens`
DB state — and prints a PASS/FAIL summary. It signs up a fresh,
uniquely-emailed test user on every run, so it's safe to re-run
repeatedly without cleanup. Requires `docker` (Postgres running in the
`billing-pg` container) and `jq` (`brew install jq` if missing).

In one terminal:

```bash
npm run dev
```

In another:

```bash
npm run verify:auth
```

Expect: `✓ All 6 checks passed. Auth module is working correctly.`
(exit code `0`). Any failure prints which check failed and why, and
exits `1`.

## Verifying tenant isolation

`scripts/verify-tenant-isolation.sh` exercises the Task 1.4 multi-tenant
isolation layer end to end: it signs up two separate tenants, creates
pings for each, and checks that every tenant only ever sees its own
rows — via the normal `GET /pings` endpoint, via the deliberately
WHERE-less `GET /pings/leak-test` endpoint, and via a direct `psql`
connection as the app's own database role (bypassing the API and
Express middleware entirely). It prints a PASS/FAIL summary. Requires
`psql` (connecting to the same local Postgres instance the app uses)
and `jq` (`brew install jq` if missing).

In one terminal:

```bash
npm run dev
```

In another:

```bash
npm run verify:tenants
```

Expect: `✓ All 4 checks passed. Tenant isolation is enforced at both the
application and database layers.` (exit code `0`).

This proves multi-tenant data isolation is enforced at **two**
independent layers, not just one:

- **Application layer** — `tenantContext` middleware
  (`src/middleware/tenantContext.js`) sets a Postgres session variable
  (`app.current_tenant_id`) from the caller's JWT on every request, and
  `req.db.queryAsTenant()` / `req.db.withTenantContext()`
  (`src/config/db.js`) are the only way route handlers are meant to
  query tenant-scoped tables — so a route can't forget to scope a
  query.
- **Database layer** — a Postgres row-level security policy on
  `tenant_pings` (see the `enable_rls_and_ping` migration) filters rows
  by that same session variable, and `FORCE ROW LEVEL SECURITY` makes
  the policy apply even to the role that owns the table. So even a bug
  that produces a query with no `WHERE tenant_id = ...` at all — like
  `/pings/leak-test` — still can't return another tenant's data. The
  direct-`psql` check in the script goes a step further: it proves
  that connecting as the app's own database role with **no** session
  variable set returns zero rows, i.e. secure-by-default even without
  the middleware in the picture at all.

## Testing signup

`POST /api/v1/auth/signup` creates a new tenant and its first (owner)
user in one transaction. Both are returned; the user is never returned
with its `password_hash`.

**Happy path:**

```bash
curl -X POST http://localhost:8000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "businessName": "Acme Travels",
    "email": "owner@acme.com",
    "password": "Passw0rd123",
    "fullName": "Anil Owner",
    "gstin": "29ABCDE1234F1Z5",
    "stateCode": "KA"
  }'
```

Expected: `201` with `{ "tenant": {...}, "user": {...} }` — the `user`
object must NOT have a `password_hash` field.

**Duplicate email:**

Run the exact same command again.

Expected: `409` with

```json
{ "error": { "code": "EMAIL_ALREADY_EXISTS", "message": "..." } }
```

**Validation error:**

```bash
curl -X POST http://localhost:8000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{ "email": "not-an-email" }'
```

Expected: `400` with

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": { "fields": [...] } } }
```

## Testing login, refresh, logout

Auth uses an access + refresh token pair: `accessToken` is a short-lived
JWT returned in the JSON body (send it as `Authorization: Bearer
<token>`); the refresh token is a long-lived opaque string set as an
HttpOnly cookie (`refresh_token`, scoped to `/api/v1/auth`) — it never
appears in a JSON response.

**Login (happy path):**

Use the account created via signup above.

```bash
curl -i -X POST http://localhost:8000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{ "email":"owner@acme.com","password":"Passw0rd123" }'
```

Expected: `200`. Body has `{ user, accessToken }`. Response headers
include `Set-Cookie: refresh_token=...; HttpOnly`. `cookies.txt` now has
the refresh cookie.

**Access /me with token:**

```bash
ACCESS=<paste accessToken from above>
curl http://localhost:8000/api/v1/auth/me \
  -H "Authorization: Bearer $ACCESS"
```

Expected: `200` with `{ user }`.

**Access /me without token:**

```bash
curl -i http://localhost:8000/api/v1/auth/me
```

Expected: `401` with code `AUTH_REQUIRED`.

**Refresh:**

```bash
curl -i -X POST http://localhost:8000/api/v1/auth/refresh \
  -b cookies.txt -c cookies.txt
```

Expected: `200` with `{ accessToken }`. `cookies.txt` updated with a NEW
refresh cookie. The old one is now revoked.

**Refresh with an old token (reuse detection):**

Save `cookies.txt` to `cookies-old.txt` right after first login, then
refresh once (which rotates and updates `cookies.txt`). Now try:

```bash
curl -i -X POST http://localhost:8000/api/v1/auth/refresh \
  -b cookies-old.txt
```

Expected: `401` with code `REFRESH_TOKEN_REUSED`. All refresh tokens for
that user are now revoked — even the currently valid one — as a safety
measure, since a rotated-away token being presented again means it was
likely stolen at some point.

**Login (bad password):**

```bash
curl -i -X POST http://localhost:8000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{ "email":"owner@acme.com","password":"wrong" }'
```

Expected: `401` with code `INVALID_CREDENTIALS` — the same error is
returned whether the email doesn't exist or the password is wrong, to
avoid leaking which accounts exist.

**Logout:**

```bash
curl -i -X POST http://localhost:8000/api/v1/auth/logout \
  -b cookies.txt -c cookies.txt
```

Expected: `204`. `cookies.txt` no longer has an active `refresh_token`.

## Project structure

```
src/
├── config/         # env.js (single source of env config), DB connection
├── api/v1/         # Versioned API routes (thin — validate, call service, respond)
├── services/       # Business logic (transactions, orchestration)
├── repositories/    # SQL, one file per table
├── validators/      # Joi schemas
├── middleware/      # Express middleware (validation, auth, error handling, etc.)
├── utils/           # Logger, password hashing, JWT/refresh-token helpers, slugify
├── app.js           # Express app setup (middleware, routes)
└── server.js         # Entry point — starts the HTTP server
migrations/          # node-pg-migrate SQL migrations
```
