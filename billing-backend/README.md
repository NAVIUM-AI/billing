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
| `npm run verify:rbac`    | Run the automated RBAC + settings + user management check (see below) |
| `npm run verify:vehicles` | Run the automated vehicle master module check (see below) |
| `npm run verify:drivers` | Run the automated driver master module check (see below) |
| `npm run verify:customers` | Run the automated customer master module check (see below) |

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

## Verifying RBAC + settings

`scripts/verify-rbac-settings.sh` exercises the Task 1.5 flow end to
end: business profile read/update (including persistence and
validation), permission-gated access (an owner can update settings and
manage users, a staff member can only read settings), and the owner
self-protection rules — an owner can never demote or deactivate
themselves, and deactivating any other user immediately revokes their
refresh token. Prints a PASS/FAIL summary. Requires `jq`
(`brew install jq` if missing).

In one terminal:

```bash
npm run dev
```

In another:

```bash
npm run verify:rbac
```

Expect: `✓ All 16 checks passed. RBAC + business settings + user
management are working correctly.` (exit code `0`).

### Access matrix

Single source of truth: `src/config/accessMatrix.js`. Every
permission-gated route calls `requirePermission(key)`
(`src/middleware/requirePermission.js`), which looks up the key here —
never add role checks inline in a route handler. This table is a copy
of that file; if you change one, update the other.

| Permission              | owner | admin | accountant | staff | viewer |
| ------------------------ | :---: | :---: | :--------: | :---: | :----: |
| `settings:read`          |   ✅   |   ✅   |     ✅      |   ✅   |   ✅    |
| `settings:update`        |   ✅   |   ✅   |            |       |        |
| `users:list`             |   ✅   |   ✅   |     ✅      |       |   ✅    |
| `users:create`           |   ✅   |   ✅   |            |       |        |
| `users:update_role`      |   ✅   |   ✅   |            |       |        |
| `users:deactivate`       |   ✅   |   ✅   |            |       |        |
| `customers:read`         |   ✅   |   ✅   |     ✅      |   ✅   |   ✅    |
| `customers:write`        |   ✅   |   ✅   |     ✅      |   ✅   |        |
| `vehicles:read`          |   ✅   |   ✅   |     ✅      |   ✅   |   ✅    |
| `vehicles:write`         |   ✅   |   ✅   |     ✅      |   ✅   |        |
| `drivers:read`           |   ✅   |   ✅   |     ✅      |   ✅   |   ✅    |
| `drivers:write`          |   ✅   |   ✅   |     ✅      |   ✅   |        |
| `trips:read`             |   ✅   |   ✅   |     ✅      |   ✅   |   ✅    |
| `trips:write`            |   ✅   |   ✅   |     ✅      |   ✅   |        |
| `trips:finalize`         |   ✅   |   ✅   |     ✅      |       |        |
| `invoices:read`          |   ✅   |   ✅   |     ✅      |       |   ✅    |
| `invoices:draft`         |   ✅   |   ✅   |     ✅      |   ✅   |        |
| `invoices:issue`         |   ✅   |   ✅   |     ✅      |       |        |
| `invoices:cancel`        |   ✅   |   ✅   |            |       |        |
| `payments:read`          |   ✅   |   ✅   |     ✅      |       |   ✅    |
| `payments:record`        |   ✅   |   ✅   |     ✅      |       |        |
| `reports:read`           |   ✅   |   ✅   |     ✅      |       |   ✅    |

Notes:

- `vehicles:*` (Task 2.1) and `drivers:*` (Task 2.2) are live. `customers:*`,
  `trips:*`, `invoices:*`, `payments:*`, and `reports:*` remain
  placeholders for later Module 2+ tasks — defined now so those tasks
  reference an existing key instead of scattering new role logic.
- There is exactly one `owner` per tenant, set at signup. Owner status
  can never be granted or removed through `POST /users` or
  `PATCH /users/:userId/role` (both reject `role: "owner"` at the
  validator). Transferring ownership is a separate, deliberate flow
  not built in this task.
- A 403 from `requirePermission` always includes
  `error.details.required` (the permission key) and
  `error.details.role` (the caller's role), so the frontend can show a
  specific "you need X permission" message instead of a generic
  "forbidden".

## Verifying vehicles

`scripts/verify-vehicles.sh` exercises the Task 2.1 vehicle master
module end to end: creation and number normalization, duplicate
detection (including across formatting variants and against archived
records), validation, list/search/type filtering, cross-tenant
isolation (both via the API and directly at the DB layer), RBAC (staff
can write, viewer cannot — checked against the access matrix), and
archive/unarchive idempotence. Prints a PASS/FAIL summary. Requires
`psql` and `jq` (`brew install jq` if missing).

In one terminal:

```bash
npm run dev
```

In another:

```bash
npm run verify:vehicles
```

Expect: `✓ All 21 checks passed. Vehicle master module is working
correctly.` (exit code `0`).

### Vehicle number: canonical vs display

Every vehicle is stored with two forms of its registration number
(`src/utils/vehicleNumber.js`):

- **`vehicle_number`** (canonical) — uppercase, no separators, e.g.
  `KA51AK1031`. This is the only form ever used for lookups, the
  per-tenant uniqueness constraint, and duplicate detection, so
  `"KA 51 AK 1031"`, `"KA-51-AK-1031"`, and `"ka51ak1031"` are all
  recognized as the same vehicle.
- **`vehicle_number_display`** — exactly what the user typed at
  creation time. Shown back in the UI/invoices because
  `"KA 51 AK 1031"` reads better than the canonical form; never used
  for lookups.

`vehicle_number` is **immutable** after creation — trip sheets and
invoices (Module 2+) will reference a vehicle by identity, so editing
it later would silently rewrite history. If a number was entered
wrong, archive the vehicle and create a new one; there is no "edit
vehicle number" endpoint by design.

There is also no hard-delete endpoint — `DELETE /vehicles/:id` returns
`404` because the route simply isn't registered. Archiving
(`POST /vehicles/:id/archive`) is the supported way to retire a
vehicle; it's reversible (`POST /vehicles/:id/unarchive`) and
idempotent (archiving an already-archived vehicle just returns its
current state, no error).

Only the standard Indian civilian registration format
(`AA##A[AA]####`, e.g. `KA51AK1031`) is accepted today. The newer
"Bharat series" format (e.g. `22BH1234A`) and defence/military plates
are not supported yet — flagged as future work in
`vehicleNumber.js`.

## Verifying drivers

`scripts/verify-drivers.sh` exercises the Task 2.2 driver master module
end to end: creation with phone/license normalization, duplicate
detection across both phone and license independently (including
across formatting variants), optional-field semantics (multiple
drivers with no phone or no license coexisting), validation,
list/search, cross-tenant isolation (API + DB layer), RBAC (staff can
write), and archive/unarchive. Prints a PASS/FAIL summary. Requires
`psql` and `jq` (`brew install jq` if missing).

In one terminal:

```bash
npm run dev
```

In another:

```bash
npm run verify:drivers
```

Expect: `✓ All 17 checks passed. Driver master module is working
correctly.` (exit code `0`).

### Phone number: canonical vs display, and optional fields

Same canonical/display split as `vehicle_number` (Task 2.1), applied to
phone numbers (`src/utils/phoneNumber.js`):

- **`phone`** (canonical) — digits only, with the `91` country code
  prefixed for Indian mobiles, e.g. `919876543210`. Used for lookups
  and the per-tenant uniqueness check, so `"+91 98765 43210"`,
  `"098765-43210"`, and `"9876543210"` all normalize to the same
  record.
- **`phone_display`** — exactly what the user typed. Shown back in the
  UI; never used for lookups.

Unlike a vehicle's registration number, a driver's `phone` and
`license_number` are **both fully optional, and both editable** —
agencies that don't formally track a driver's phone or license can
still create a driver record with just a name, and either field can be
added or corrected later. When present, each is unique per tenant
(enforced by a partial unique index so any number of drivers can share
a `NULL` phone or `NULL` license at the same time — see the drivers
migration). Only the standard Indian mobile format is validated
strictly today; other formats fall back to a loose 10–15 digit check
(see the top-of-file comment in `phoneNumber.js` for the plan to swap
in `libphonenumber-js` if stricter international validation is ever
needed).

## Verifying customers

`scripts/verify-customers.sh` exercises the Task 2.3 customer master
module end to end: B2C/B2B polymorphism with conditional required
fields, GSTIN format validation + state-code cross-check +
auto-derivation, duplicate detection (GSTIN and phone, across
formatting/case variants), list/search/filter, cross-tenant isolation
(API + DB layer, across both `customers` and `customer_contacts`), the
B2B-only contacts sub-resource (including atomic primary-contact
flipping), immutable `customer_type`, and archive/unarchive. Prints a
PASS/FAIL summary. Requires `psql` and `jq` (`brew install jq` if
missing).

In one terminal:

```bash
npm run dev
```

In another:

```bash
npm run verify:customers
```

Expect: `✓ All 24 checks passed. Customer master module is working
correctly.` (exit code `0`).

### B2C vs B2B: one table, conditional requirements

A single `customers` table holds both individual (B2C) and business
(B2B) customers, distinguished by `customer_type`. Which fields are
required depends on the type, enforced at **both** the application
layer (Joi + `customer.service.js`) and the database layer (CHECK
constraints — belt and suspenders, same principle as RLS):

| | B2C | B2B |
| --- | --- | --- |
| `name` | **required** | optional (primary billing contact name) |
| `company_name` | must be absent | **required** |
| `gstin` | optional | **required** |
| `state_code` | optional | **required** (auto-derived from `gstin` if omitted) |
| Contacts sub-resource | not available (400 `CONTACTS_B2B_ONLY`) | available |

`customer_type` is **immutable** after creation — switching a customer
between B2C and B2B later would invalidate the required-fields
assumptions every past invoice was built on. There is no
"convert customer type" endpoint by design; `PATCH` rejects any
request that includes `customer_type` at all with `VALIDATION_ERROR`.

### GSTIN state-code cross-check

A GSTIN's first two digits encode the state it was issued in
(`src/utils/gstin.js` — format and state-code validation only; portal
verification against the actual GST department is a later
integration). For a B2B customer:

- If `gstin` is provided and `state_code` is not, `state_code` is
  **auto-derived** from the GSTIN.
- If both are provided, they must agree — a mismatch (e.g. a Karnataka
  GSTIN paired with `state_code: "MH"`) is rejected with
  `400 GSTIN_STATE_MISMATCH` and the response includes both the
  GSTIN-derived state and the state that was submitted, so the caller
  can see exactly what disagreed.

This matters beyond data hygiene: `state_code` drives IGST vs.
CGST+SGST calculation at invoice time (Module 4), so a customer record
with a self-contradictory state would silently produce the wrong tax
split on every invoice raised against it.

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
