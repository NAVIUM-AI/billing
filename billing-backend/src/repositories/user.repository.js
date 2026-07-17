/**
 * Repository functions accept an optional pg client to participate in a
 * caller-owned transaction. Pass one when doing multi-step writes.
 *
 * This is the only file that should contain SQL for the `users` table
 * — services call these functions instead of writing SQL directly.
 */

const { pool } = require("../config/db");

// Columns to return for a "public" user row — deliberately excludes
// password_hash so it's impossible to accidentally leak it by forgetting
// to strip it at the call site.
const PUBLIC_COLUMNS = `
  id, tenant_id, email, full_name, role, is_active,
  last_login_at, created_at, updated_at
`;

/**
 * @param {string} email
 * @param {string} tenantId
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<object|null>}
 */
async function findByEmailAndTenant(email, tenantId, client) {
  const runner = client || pool;
  const result = await runner.query(
    "SELECT * FROM users WHERE email = $1 AND tenant_id = $2",
    [email, tenantId],
  );
  return result.rows[0] || null;
}

/**
 * Our schema allows the same email to exist under different tenants
 * (the unique constraint is on (tenant_id, email), not email alone).
 * For signup specifically we still want to block it: if we let the same
 * person spin up two tenants with one email, they'll likely be confused
 * about which "account" they're logging into later since login (a
 * future task) will need a tenant-scoped lookup. So during signup we
 * check for the email ANYWHERE, not just within the new tenant.
 *
 * @param {string} email
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<object|null>}
 */
async function findByEmail(email, client) {
  const runner = client || pool;
  const result = await runner.query("SELECT * FROM users WHERE email = $1", [
    email,
  ]);
  return result.rows[0] || null;
}

/**
 * @param {{ tenantId: string, email: string, passwordHash: string, fullName: string, role: string }} params
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<object>} the newly created user row, WITHOUT password_hash
 */
async function insertUser(
  { tenantId, email, passwordHash, fullName, role },
  client,
) {
  const runner = client || pool;
  const result = await runner.query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PUBLIC_COLUMNS}`,
    [tenantId, email, passwordHash, fullName, role],
  );
  return result.rows[0];
}

/**
 * @param {string} userId
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<void>}
 */
async function touchLastLogin(userId, client) {
  const runner = client || pool;
  await runner.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [
    userId,
  ]);
}

/**
 * @param {string} id
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<object|null>} full row, including password_hash — callers must strip it before returning to a client
 */
async function findById(id, client) {
  const runner = client || pool;
  const result = await runner.query("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0] || null;
}

/**
 * Same as findById, but also guards on tenant_id. Note on tenant
 * guarding (Task 1.5): RLS is NOT enabled on `users` (see the Task 1.4
 * migration comment — auth lookups like login need to work without a
 * tenant context set), so this WHERE clause is CURRENTLY the only
 * barrier preventing one tenant's admin from reaching another tenant's
 * user by guessing/enumerating a userId. Every user-management
 * repository function below guards the same way — never trust a userId
 * path param alone.
 *
 * @param {string} userId
 * @param {string} tenantId
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<object|null>} full row, including password_hash — callers must strip it before returning to a client
 */
async function findByIdAndTenant(userId, tenantId, client) {
  const runner = client || pool;
  const result = await runner.query(
    "SELECT * FROM users WHERE id = $1 AND tenant_id = $2",
    [userId, tenantId],
  );
  return result.rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {{ limit?: number, offset?: number, includeInactive?: boolean }} [options]
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<{ rows: object[], total: number }>}
 */
async function listByTenant(
  tenantId,
  { limit = 50, offset = 0, includeInactive = false } = {},
  client,
) {
  const runner = client || pool;
  // COUNT(*) OVER() gets the total matching-row count (for pagination)
  // in the same round trip as the page of rows itself, rather than a
  // separate COUNT(*) query.
  const result = await runner.query(
    `SELECT ${PUBLIC_COLUMNS}, COUNT(*) OVER() AS total
     FROM users
     WHERE tenant_id = $1
       AND ($2::boolean OR is_active = true)
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [tenantId, includeInactive, limit, offset],
  );

  const total = result.rows.length > 0 ? Number(result.rows[0].total) : 0;
  const rows = result.rows.map(({ total: _total, ...row }) => row);
  return { rows, total };
}

/**
 * Counts active users with a given role in a tenant — used to enforce
 * "at least one active owner" style rules.
 *
 * @param {string} tenantId
 * @param {string} role
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<number>}
 */
async function countByTenantAndRole(tenantId, role, client) {
  const runner = client || pool;
  const result = await runner.query(
    "SELECT COUNT(*) FROM users WHERE tenant_id = $1 AND role = $2 AND is_active = true",
    [tenantId, role],
  );
  return Number(result.rows[0].count);
}

/**
 * @param {string} userId
 * @param {string} tenantId
 * @param {string} newRole
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<object|null>} updated row, WITHOUT password_hash
 */
async function updateRole(userId, tenantId, newRole, client) {
  const runner = client || pool;
  const result = await runner.query(
    `UPDATE users SET role = $3
     WHERE id = $1 AND tenant_id = $2
     RETURNING ${PUBLIC_COLUMNS}`,
    [userId, tenantId, newRole],
  );
  return result.rows[0] || null;
}

/**
 * @param {string} userId
 * @param {string} tenantId
 * @param {boolean} isActive
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<object|null>} updated row, WITHOUT password_hash
 */
async function setActive(userId, tenantId, isActive, client) {
  const runner = client || pool;
  const result = await runner.query(
    `UPDATE users SET is_active = $3
     WHERE id = $1 AND tenant_id = $2
     RETURNING ${PUBLIC_COLUMNS}`,
    [userId, tenantId, isActive],
  );
  return result.rows[0] || null;
}

module.exports = {
  findByEmailAndTenant,
  findByEmail,
  findById,
  findByIdAndTenant,
  insertUser,
  touchLastLogin,
  listByTenant,
  countByTenantAndRole,
  updateRole,
  setActive,
};
