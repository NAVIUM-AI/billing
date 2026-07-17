/**
 * Access tokens are self-contained (stateless) JWTs: anything holding a
 * valid signature and unexpired `exp` is trusted, with no DB lookup per
 * request. That's what makes them fast, but also why they're short-lived
 * (see JWT_ACCESS_TTL) — they can't be revoked before they expire.
 *
 * Refresh tokens are the opposite: opaque random strings, meaningless on
 * their own. We hash them before storing (see hashRefreshToken) so that
 * even if the `refresh_tokens` table leaked, an attacker would have SHA-256
 * hashes, not usable tokens — and being stored server-side, they CAN be
 * revoked (logout, reuse detection, etc), unlike the access token.
 */

const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const ms = require("ms");

const env = require("../config/env");

/**
 * @param {{ userId: string, tenantId: string, role: string }} params
 * @returns {string} signed JWT
 */
function signAccessToken({ userId, tenantId, role }) {
  return jwt.sign(
    { sub: userId, tenant_id: tenantId, role, type: "access" },
    env.jwt.accessSecret,
    { expiresIn: env.jwt.accessTtl },
  );
}

/**
 * @param {string} token
 * @returns {object} decoded payload
 * @throws {jwt.JsonWebTokenError|jwt.TokenExpiredError} if invalid/expired
 */
function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.accessSecret);
}

/**
 * Raw refresh token — this is what the CLIENT holds (in an HttpOnly
 * cookie). Never persisted anywhere in this form.
 * @returns {string}
 */
function generateRefreshToken() {
  return crypto.randomBytes(64).toString("hex");
}

/**
 * Deterministic hash of a raw refresh token — this is what we store in
 * the DB, so a lookup just re-hashes the incoming token and compares.
 * @param {string} rawToken
 * @returns {string} hex-encoded SHA-256 hash
 */
function hashRefreshToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/**
 * @returns {Date} the moment a newly issued refresh token should expire
 */
function refreshTokenExpiryDate() {
  return new Date(Date.now() + ms(env.jwt.refreshTtl));
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiryDate,
};
