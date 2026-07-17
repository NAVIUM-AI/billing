/**
 * Password hashing helpers, backed by bcrypt.
 *
 * 12 rounds is the current industry baseline (2025). Raise to 13-14 if
 * login latency budget allows.
 */

const bcrypt = require("bcrypt");

const SALT_ROUNDS = 12;

/**
 * @param {string} plain - plaintext password
 * @returns {Promise<string>} bcrypt hash (includes salt)
 */
function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

/**
 * @param {string} plain - plaintext password to check
 * @param {string} hash - bcrypt hash to check against
 * @returns {Promise<boolean>}
 */
function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

module.exports = { hashPassword, verifyPassword };
