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

## Project structure

```
src/
├── config/       # DB connection, env-derived config
├── api/v1/       # Versioned API routes
├── middleware/    # Express middleware (auth, validation, etc.)
├── services/      # Business logic
├── utils/         # Logger and other helpers
├── app.js         # Express app setup (middleware, routes)
└── server.js       # Entry point — starts the HTTP server
migrations/        # node-pg-migrate SQL migrations
```
