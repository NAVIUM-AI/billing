/**
 * Repository functions accept an optional pg client to participate in a
 * caller-owned transaction. Pass one when doing multi-step writes.
 *
 * This is the only file that should contain SQL for the `refresh_tokens`
 * table — services call these functions instead of writing SQL directly.
 */

const { pool } = require("../config/db");

/**
 * @param {{ userId: string, tenantId: string, tokenHash: string, userAgent?: string, ipAddress?: string, expiresAt: Date }} params
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<object>} the newly created refresh_tokens row
 */
async function insert(
  { userId, tenantId, tokenHash, userAgent, ipAddress, expiresAt },
  client,
) {
  const runner = client || pool;
  const result = await runner.query(
    `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [userId, tenantId, tokenHash, userAgent || null, ipAddress || null, expiresAt],
  );
  return result.rows[0];
}

/**
 * A token is usable only while it's neither revoked nor past its
 * expiry — this is the query the login/refresh flow relies on to decide
 * whether a presented token is currently valid.
 *
 * @param {string} tokenHash
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<object|null>}
 */
async function findActiveByHash(tokenHash, client) {
  const runner = client || pool;
  const result = await runner.query(
    `SELECT * FROM refresh_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [tokenHash],
  );
  return result.rows[0] || null;
}

/**
 * Looks up a token hash regardless of revoked/expired status — used for
 * reuse detection: a hash that exists but is revoked means someone
 * presented a token we already rotated away from, which is a signal of
 * theft (see auth.service.js `refresh`).
 *
 * @param {string} tokenHash
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<object|null>}
 */
async function findAnyByHash(tokenHash, client) {
  const runner = client || pool;
  const result = await runner.query(
    "SELECT * FROM refresh_tokens WHERE token_hash = $1",
    [tokenHash],
  );
  return result.rows[0] || null;
}

/**
 * @param {string} id
 * @param {string} [replacedBy] - id of the token that replaced this one, if rotated
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<void>}
 */
async function revoke(id, replacedBy, client) {
  const runner = client || pool;
  await runner.query(
    "UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by = $2 WHERE id = $1",
    [id, replacedBy || null],
  );
}

/**
 * Revokes every active token for a user — used on reuse detection, where
 * we can no longer trust any token issued in that user's session lineage.
 *
 * @param {string} userId
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<void>}
 */
async function revokeAllForUser(userId, client) {
  const runner = client || pool;
  await runner.query(
    "UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );
}

module.exports = {
  insert,
  findActiveByHash,
  findAnyByHash,
  revoke,
  revokeAllForUser,
};
