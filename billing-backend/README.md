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

## Project structure

```
src/
├── config/         # DB connection, env-derived config
├── api/v1/         # Versioned API routes (thin — validate, call service, respond)
├── services/       # Business logic (transactions, orchestration)
├── repositories/    # SQL, one file per table
├── validators/      # Joi schemas
├── middleware/      # Express middleware (validation, error handling, etc.)
├── utils/           # Logger, password hashing, slugify, error helpers
├── app.js           # Express app setup (middleware, routes)
└── server.js         # Entry point — starts the HTTP server
migrations/          # node-pg-migrate SQL migrations
```
