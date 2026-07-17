/**
 * Repository functions accept an optional pg client to participate in a
 * caller-owned transaction. Pass one when doing multi-step writes.
 *
 * This is the only file that should contain SQL for the `tenants` table
 * — services call these functions instead of writing SQL directly.
 */

const { pool } = require("../config/db");

/**
 * @param {string} slug
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<object|null>}
 */
async function findBySlug(slug, client) {
  const runner = client || pool;
  const result = await runner.query(
    "SELECT * FROM tenants WHERE slug = $1",
    [slug],
  );
  return result.rows[0] || null;
}

/**
 * @param {{ name: string, slug: string, gstin?: string, stateCode?: string }} params
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<object>} the newly created tenant row
 */
async function insertTenant({ name, slug, gstin, stateCode }, client) {
  const runner = client || pool;
  const result = await runner.query(
    `INSERT INTO tenants (name, slug, gstin, state_code)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [name, slug, gstin || null, stateCode || null],
  );
  return result.rows[0];
}

module.exports = { findBySlug, insertTenant };
