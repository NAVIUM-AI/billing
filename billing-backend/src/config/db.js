/**
 * Database connection module.
 *
 * We use a single shared `pg.Pool` for the whole app instead of opening a
 * new client per request — pooling reuses connections, which matters once
 * we have concurrent requests hitting Postgres.
 *
 * Tenant isolation (row-level security, see the `enable_rls_and_ping`
 * migration) is enforced by a Postgres session variable,
 * `app.current_tenant_id`. That variable MUST be set with `SET LOCAL`
 * inside a transaction, never plain `SET`: pool connections are reused
 * across unrelated requests, so a plain `SET` would leak one request's
 * tenant into whichever request happens to grab that same connection
 * next. `SET LOCAL` is scoped to the current transaction and is
 * automatically cleared on COMMIT/ROLLBACK, so every request starts
 * clean regardless of which pooled connection it lands on.
 *
 * Three ways to run queries, pick based on what the query needs:
 *   - query()             → tenant-agnostic ops (login, signup, health
 *                           check) — anything that must work with no
 *                           tenant context at all, e.g. looking a user
 *                           up by email before we know their tenant.
 *   - queryAsTenant()     → a single tenant-scoped read/write.
 *   - withTenantContext() → multiple tenant-scoped statements that need
 *                           to succeed or fail together.
 */

const { Pool, types } = require("pg");
const env = require("./env");

// By default, node-postgres parses a DATE column (OID 1082) into a JS
// Date at LOCAL midnight. Since res.json() serializes Dates via
// .toISOString() (which converts to UTC), a plain calendar date like
// license_expiry_date = '2030-12-31' silently shifts to
// '2030-12-30T18:30:00.000Z' on any server whose local timezone is
// ahead of UTC (e.g. IST). Returning the raw 'YYYY-MM-DD' string
// instead sidesteps timezone conversion entirely — correct behavior
// for a value that represents a calendar date, not a point in time.
types.setTypeParser(types.builtins.DATE, (val) => val);

// By default, node-postgres returns a BIGINT column (OID 20, e.g. the
// invoices table's *_paise columns) as a JS STRING, not a number —
// correct in general (int8 can exceed Number.MAX_SAFE_INTEGER), but
// every BIGINT column in this schema is a paise amount or a count that
// will never get remotely close to that ceiling. Left unparsed, plain
// arithmetic on these values breaks silently: `220000 + "0"` doesn't
// throw, it string-concatenates to `"2200000"`, and the corruption only
// surfaces several steps later (a domain function rejecting the final,
// garbled result as "not an integer"). Parsing to Number here means
// every layer above the DB driver — services, tests, and API responses
// — sees a consistent JS number for money, matching every INTEGER
// money column elsewhere in the schema, instead of two different wire
// shapes for the same concept depending on which column happens to be
// declared BIGINT vs INTEGER.
types.setTypeParser(types.builtins.INT8, (val) => parseInt(val, 10));

const pool = new Pool({
  connectionString: env.databaseUrl,
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

/**
 * Checks out a client, sets the tenant session variable for the
 * duration of a transaction, runs `fn(client)`, then commits. Use this
 * when a route needs more than one tenant-scoped statement to succeed
 * or fail as a unit (see auth.service.js's signup/refresh for the same
 * BEGIN/COMMIT/ROLLBACK pattern without tenant context).
 *
 * @template T
 * @param {string} tenantId
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTenantContext(tenantId, fn) {
  if (!tenantId) {
    throw new Error("withTenantContext requires tenantId");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // set_config's third arg (is_local=true) is the functional
    // equivalent of `SET LOCAL app.current_tenant_id = $1` — we use the
    // function form because `SET LOCAL` doesn't support query
    // parameters, and string-interpolating tenantId directly into SQL
    // would be a SQL-injection risk.
    await client.query(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      [tenantId],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Convenience wrapper for the common case: one tenant-scoped query, no
 * other statements needed in the same transaction.
 *
 * @param {string} tenantId
 * @param {string} text
 * @param {Array<*>} [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
async function queryAsTenant(tenantId, text, params) {
  return withTenantContext(tenantId, (client) => client.query(text, params));
}

module.exports = { pool, query, withTenantContext, queryAsTenant };
