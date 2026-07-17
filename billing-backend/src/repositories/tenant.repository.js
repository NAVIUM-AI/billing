/**
 * Repository functions accept an optional pg client to participate in a
 * caller-owned transaction. Pass one when doing multi-step writes.
 *
 * This is the only file that should contain SQL for the `tenants` table
 * — services call these functions instead of writing SQL directly.
 */

const { pool } = require("../config/db");

// Columns callers are allowed to change via updateProfile(). Whitelisted
// here (not in the route/service) so there's exactly one place that
// decides which tenant columns are patchable — internal bookkeeping
// columns like current_invoice_seq can never reach this function no
// matter what a caller passes in.
const UPDATABLE_COLUMNS = [
  "name",
  "gstin",
  "pan",
  "state_code",
  "logo_url",
  "invoice_prefix",
  "bank_details",
  "settings",
];

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
 * @param {string} tenantId
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<object|null>}
 */
async function findById(tenantId, client) {
  const runner = client || pool;
  const result = await runner.query("SELECT * FROM tenants WHERE id = $1", [
    tenantId,
  ]);
  return result.rows[0] || null;
}

/**
 * Updates only the whitelisted, present keys of `patch`. Built as a
 * dynamic UPDATE (rather than a fixed `SET col = COALESCE($n, col)` for
 * every column) so that JSONB columns like `settings` can be cleared to
 * an empty object or `null` — COALESCE would make that impossible to
 * distinguish from "don't touch this field".
 *
 * @param {string} tenantId
 * @param {Record<string, unknown>} patch
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<object|null>} the updated tenant row
 */
async function updateProfile(tenantId, patch, client) {
  const keys = Object.keys(patch).filter((key) =>
    UPDATABLE_COLUMNS.includes(key),
  );
  if (keys.length === 0) {
    throw new Error(
      "updateProfile requires at least one updatable field in patch",
    );
  }

  // $1 is reserved for tenantId, so column placeholders start at $2.
  const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(", ");
  const values = keys.map((key) => patch[key]);

  const runner = client || pool;
  const result = await runner.query(
    `UPDATE tenants SET ${setClause} WHERE id = $1 RETURNING *`,
    [tenantId, ...values],
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

module.exports = { findBySlug, findById, insertTenant, updateProfile };
