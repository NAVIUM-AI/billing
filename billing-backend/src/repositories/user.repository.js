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

module.exports = {
  findByEmailAndTenant,
  findByEmail,
  findById,
  insertUser,
  touchLastLogin,
};
