/**
 * Auth business logic. Routes call this instead of touching repositories
 * or the DB pool directly, so validation/transaction rules live in one
 * place.
 */

const crypto = require("crypto");

const { pool } = require("../config/db");
const tenantRepository = require("../repositories/tenant.repository");
const userRepository = require("../repositories/user.repository");
const { hashPassword } = require("../utils/password");
const { slugify } = require("../utils/slugify");
const { apiError } = require("../utils/httpError");

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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const tenant = await tenantRepository.insertTenant(
      { name: businessName, slug, gstin, stateCode },
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

module.exports = { signup };
