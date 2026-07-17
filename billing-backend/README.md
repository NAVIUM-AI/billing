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
