/**
 * Database connection module.
 *
 * We use a single shared `pg.Pool` for the whole app instead of opening a
 * new client per request — pooling reuses connections, which matters once
 * we have concurrent requests hitting Postgres.
 *
 * All raw SQL queries should go through the exported `query()` helper so
 * we have one place to add logging/metrics later if needed.
 */

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Without this listener, an error on an idle client (e.g. the DB restarting)
// would crash the whole Node process with an unhandled 'error' event.
pool.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("Unexpected error on idle PostgreSQL client", err);
});

/**
 * Run a SQL query against the pool.
 * @param {string} text - SQL text, using $1, $2, ... placeholders.
 * @param {Array<*>} [params] - Values for the placeholders.
 * @returns {Promise<import('pg').QueryResult>}
 */
function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };
