/**
 * Auth business logic. Routes call this instead of touching repositories
 * or the DB pool directly, so validation/transaction rules live in one
 * place.
 */

const crypto = require("crypto");

const { pool } = require("../config/db");
const tenantRepository = require("../repositories/tenant.repository");
const userRepository = require("../repositories/user.repository");
const refreshTokenRepository = require("../repositories/refreshToken.repository");
const { hashPassword, verifyPassword } = require("../utils/password");
const { slugify } = require("../utils/slugify");
const { deriveInvoicePrefix, derivePerformancePrefix } = require("../utils/invoicePrefix");
const { apiError } = require("../utils/httpError");
const {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiryDate,
} = require("../utils/tokens");

const MAX_SLUG_ATTEMPTS = 5;

/**
 * Finds a slug for `businessName` that isn't already taken. Tries the
 * plain slug first, then appends a short random suffix on collision
 * (e.g. "acme" -> "acme-a3f2") since business names are not unique and
 * slugs must be.
 *
 * @param {string} businessName
 * @returns {Promise<string>}
 */
async function generateAvailableSlug(businessName) {
  const base = slugify(businessName);

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidate =
      attempt === 0 ? base : `${base}-${crypto.randomBytes(2).toString("hex")}`;

    // eslint-disable-next-line no-await-in-loop
    const existing = await tenantRepository.findBySlug(candidate);
    if (!existing) {
      return candidate;
    }
  }

  throw apiError(
    409,
    "SLUG_UNAVAILABLE",
    "Could not generate a unique identifier for this business name. Please try a different name.",
  );
}

/**
 * Creates a new tenant and its first (owner) user atomically.
 *
 * @param {{ businessName: string, email: string, password: string, fullName: string, gstin?: string, stateCode?: string }} input
 * @returns {Promise<{ tenant: object, user: object }>}
 */
async function signup({
  businessName,
  email,
  password,
  fullName,
  gstin,
  stateCode,
}) {
  const normalizedEmail = email.toLowerCase().trim();

  const slug = await generateAvailableSlug(businessName);

  // Signup-specific rule: block if this email exists under ANY tenant,
  // not just the one being created — see the comment on
  // userRepository.findByEmail for why.
  const existingUser = await userRepository.findByEmail(normalizedEmail);
  if (existingUser) {
    throw apiError(
      409,
      "EMAIL_ALREADY_EXISTS",
      "An account with this email already exists.",
    );
  }

  const passwordHash = await hashPassword(password);

  // Task 4.1: auto-derive default invoice prefixes from the business
  // name at signup, same as trip_sheet_prefix's hardcoded 'TS' default
  // — both are editable afterward in settings.
  const invoicePrefix = deriveInvoicePrefix(businessName);
  const performancePrefix = derivePerformancePrefix(invoicePrefix);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tenant = await tenantRepository.insertTenant(
      { name: businessName, slug, gstin, stateCode, invoicePrefix, performancePrefix },
      client,
    );

    const user = await userRepository.insertUser(
      {
        tenantId: tenant.id,
        email: normalizedEmail,
        passwordHash,
        fullName,
        role: "owner",
      },
      client,
    );

    await client.query("COMMIT");

    // insertUser's RETURNING clause already excludes password_hash, but
    // we double-check here so an accidental change to that query can
    // never leak a hash through this response.
    delete user.password_hash;

    return { tenant, user };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Verifies credentials and issues a fresh access/refresh token pair.
 *
 * @param {{ email: string, password: string, userAgent?: string, ipAddress?: string }} input
 * @returns {Promise<{ user: object, accessToken: string, refreshToken: string, refreshExpiresAt: Date }>}
 */
async function login({ email, password, userAgent, ipAddress }) {
  const user = await userRepository.findByEmail(email);

  // Same error whether the account doesn't exist, is deactivated, or the
  // password is wrong. Distinguishing them in the response would let an
  // attacker enumerate which emails have accounts on this system.
  if (!user || !user.is_active) {
    throw apiError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
  }

  const passwordMatches = await verifyPassword(password, user.password_hash);
  if (!passwordMatches) {
    throw apiError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
  }

  const accessToken = signAccessToken({
    userId: user.id,
    tenantId: user.tenant_id,
    role: user.role,
  });

  const rawRefreshToken = generateRefreshToken();
  const tokenHash = hashRefreshToken(rawRefreshToken);
  const expiresAt = refreshTokenExpiryDate();

  await refreshTokenRepository.insert({
    userId: user.id,
    tenantId: user.tenant_id,
    tokenHash,
    userAgent,
    ipAddress,
    expiresAt,
  });

  await userRepository.touchLastLogin(user.id);

  delete user.password_hash;

  return {
    user,
    accessToken,
    refreshToken: rawRefreshToken,
    refreshExpiresAt: expiresAt,
  };
}

/**
 * Rotates a refresh token: the presented token is revoked and a new one
 * issued in the same call, so each refresh token is single-use. Also
 * implements reuse detection — see the inline comment below.
 *
 * @param {{ rawRefreshToken: string, userAgent?: string, ipAddress?: string }} input
 * @returns {Promise<{ accessToken: string, refreshToken: string, refreshExpiresAt: Date }>}
 */
async function refresh({ rawRefreshToken, userAgent, ipAddress }) {
  if (!rawRefreshToken) {
    throw apiError(401, "REFRESH_TOKEN_MISSING", "Not authenticated.");
  }

  const tokenHash = hashRefreshToken(rawRefreshToken);
  const activeRow = await refreshTokenRepository.findActiveByHash(tokenHash);

  if (!activeRow) {
    // The token isn't currently active — it may be expired, or it may
    // have already been rotated away from. Those look identical from the
    // outside, so we have to check history to tell them apart.
    const anyRow = await refreshTokenRepository.findAnyByHash(tokenHash);

    if (anyRow && anyRow.revoked_at) {
      // This hash was issued and later revoked (normally via rotation),
      // yet someone just presented it again. A legitimate client would
      // only ever hold the LATEST token in a rotation chain, so this is
      // a strong signal the token was stolen at some point in the past.
      // We can't tell which token in the chain is compromised, so we
      // revoke everything for this user and force a fresh login.
      await refreshTokenRepository.revokeAllForUser(anyRow.user_id);
      throw apiError(401, "REFRESH_TOKEN_REUSED", "Session invalidated.");
    }

    // Never existed, or existed and simply expired without being
    // rotated (e.g. the user was away past JWT_REFRESH_TTL) — either
    // way, this is an ordinary "not authenticated", not theft.
    throw apiError(401, "REFRESH_TOKEN_INVALID", "Not authenticated.");
  }

  const user = await userRepository.findById(activeRow.user_id);
  if (!user || !user.is_active) {
    await refreshTokenRepository.revoke(activeRow.id);
    throw apiError(401, "REFRESH_TOKEN_INVALID", "Not authenticated.");
  }

  const newRawRefreshToken = generateRefreshToken();
  const newTokenHash = hashRefreshToken(newRawRefreshToken);
  const newExpiresAt = refreshTokenExpiryDate();

  const client = await pool.connect();
  let newRow;
  try {
    await client.query("BEGIN");

    newRow = await refreshTokenRepository.insert(
      {
        userId: user.id,
        tenantId: user.tenant_id,
        tokenHash: newTokenHash,
        userAgent,
        ipAddress,
        expiresAt: newExpiresAt,
      },
      client,
    );

    await refreshTokenRepository.revoke(activeRow.id, newRow.id, client);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const accessToken = signAccessToken({
    userId: user.id,
    tenantId: user.tenant_id,
    role: user.role,
  });

  return {
    accessToken,
    refreshToken: newRawRefreshToken,
    refreshExpiresAt: newRow.expires_at,
  };
}

/**
 * Revokes a refresh token. Always succeeds from the caller's point of
 * view (idempotent, no error on a missing/already-invalid token) so
 * logout never leaks whether a given cookie was valid.
 *
 * @param {{ rawRefreshToken: string|undefined }} input
 * @returns {Promise<void>}
 */
async function logout({ rawRefreshToken }) {
  if (!rawRefreshToken) {
    return;
  }

  const tokenHash = hashRefreshToken(rawRefreshToken);
  const row = await refreshTokenRepository.findActiveByHash(tokenHash);
  if (row) {
    await refreshTokenRepository.revoke(row.id);
  }
}

module.exports = { signup, login, refresh, logout };
