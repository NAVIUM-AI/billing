/**
 * User-management business logic. Routes call this instead of touching
 * repositories directly, so the owner-protection rules below live in
 * exactly one place.
 */

const userRepository = require("../repositories/user.repository");
const refreshTokenRepository = require("../repositories/refreshToken.repository");
const { hashPassword } = require("../utils/password");
const { apiError } = require("../utils/httpError");

/**
 * @param {string} tenantId
 * @param {{ limit?: number, offset?: number, includeInactive?: boolean }} options
 * @returns {Promise<{ rows: object[], total: number }>}
 */
async function listUsers(tenantId, { limit, offset, includeInactive } = {}) {
  return userRepository.listByTenant(tenantId, {
    limit,
    offset,
    includeInactive,
  });
}

/**
 * @param {string} tenantId
 * @param {{ email: string, password: string, fullName: string, role: string }} input
 * @param {string} actorUserId - unused today but threaded through so the
 *   audit-log hook below has it once it ships.
 * @returns {Promise<object>} the new user, WITHOUT password_hash
 */
// eslint-disable-next-line no-unused-vars
async function createUser(tenantId, { email, password, fullName, role }, actorUserId) {
  const normalizedEmail = email.toLowerCase().trim();

  // Unlike signup (which blocks a duplicate email across ANY tenant —
  // see userRepository.findByEmail), here we only need to guard within
  // THIS tenant: our login flow already scopes by tenant via a
  // tenant-specific lookup path, so the same email can be a different
  // person in a different organization without any ambiguity.
  const existing = await userRepository.findByEmailAndTenant(
    normalizedEmail,
    tenantId,
  );
  if (existing) {
    throw apiError(
      409,
      "EMAIL_ALREADY_EXISTS",
      "This email is already used in your organization.",
    );
  }

  const passwordHash = await hashPassword(password);

  const user = await userRepository.insertUser({
    tenantId,
    email: normalizedEmail,
    passwordHash,
    fullName,
    role,
  });

  // insertUser's RETURNING clause already excludes password_hash, but
  // double-check here so an accidental change to that query can never
  // leak a hash through this response (same defensive pattern as
  // auth.service.js's signup).
  delete user.password_hash;

  // TODO: emit audit_log entry when audit module ships in Task 3.x.

  return user;
}

/**
 * @param {string} tenantId
 * @param {string} targetUserId
 * @param {string} newRole
 * @param {string} actorUserId
 * @returns {Promise<object>} updated user, WITHOUT password_hash
 */
async function updateUserRole(tenantId, targetUserId, newRole, actorUserId) {
  const target = await userRepository.findByIdAndTenant(targetUserId, tenantId);
  if (!target) {
    throw apiError(404, "USER_NOT_FOUND", "User not found.");
  }

  // Order matters here: an owner changing their OWN role is also,
  // incidentally, an attempt to modify the owner — so if the general
  // "don't touch the owner" rule below ran first, self-demotion would
  // always surface as the less-actionable CANNOT_MODIFY_OWNER instead
  // of the more specific CANNOT_DEMOTE_SELF. Checking the more specific
  // case first gives the caller the more useful error.
  if (
    actorUserId === targetUserId &&
    target.role === "owner" &&
    newRole !== "owner"
  ) {
    throw apiError(
      403,
      "CANNOT_DEMOTE_SELF",
      "You cannot change your own role away from owner. Ownership transfer is a separate, deliberate flow.",
    );
  }

  // Owner role is transferred via a separate future flow, not edited
  // casually by another admin.
  if (target.role === "owner") {
    throw apiError(
      403,
      "CANNOT_MODIFY_OWNER",
      "The owner's role cannot be changed here.",
    );
  }

  const updated = await userRepository.updateRole(
    targetUserId,
    tenantId,
    newRole,
  );

  // TODO: emit audit_log entry when audit module ships in Task 3.x.

  return updated;
}

/**
 * @param {string} tenantId
 * @param {string} targetUserId
 * @param {string} actorUserId
 * @returns {Promise<object>} updated user, WITHOUT password_hash
 */
async function deactivateUser(tenantId, targetUserId, actorUserId) {
  const target = await userRepository.findByIdAndTenant(targetUserId, tenantId);
  if (!target) {
    throw apiError(404, "USER_NOT_FOUND", "User not found.");
  }

  // Self-check first — same ordering rationale as updateUserRole above:
  // when the owner targets themselves, this is the more specific and
  // more actionable of the two possible errors. Also applies to
  // non-owners: prevents an admin from locking themselves out.
  if (actorUserId === targetUserId) {
    throw apiError(
      403,
      "CANNOT_DEACTIVATE_SELF",
      "You cannot deactivate your own account.",
    );
  }

  if (target.role === "owner") {
    throw apiError(
      403,
      "CANNOT_DEACTIVATE_OWNER",
      "The owner cannot be deactivated. Ownership transfer is a separate, deliberate flow.",
    );
  }

  const updated = await userRepository.setActive(targetUserId, tenantId, false);

  // Must happen now, not later: without this, a deactivated user keeps
  // a live refresh token and can keep minting new access tokens via
  // /auth/refresh, defeating the point of deactivating them.
  await refreshTokenRepository.revokeAllForUser(targetUserId);

  // TODO: emit audit_log entry when audit module ships in Task 3.x.

  return updated;
}

/**
 * @param {string} tenantId
 * @param {string} targetUserId
 * @param {string} actorUserId - unused today but threaded through so the
 *   audit-log hook below has it once it ships.
 * @returns {Promise<object>} updated user, WITHOUT password_hash
 */
// eslint-disable-next-line no-unused-vars
async function reactivateUser(tenantId, targetUserId, actorUserId) {
  const target = await userRepository.findByIdAndTenant(targetUserId, tenantId);
  if (!target) {
    throw apiError(404, "USER_NOT_FOUND", "User not found.");
  }

  const updated = await userRepository.setActive(targetUserId, tenantId, true);

  // TODO: emit audit_log entry when audit module ships in Task 3.x.

  return updated;
}

module.exports = {
  listUsers,
  createUser,
  updateUserRole,
  deactivateUser,
  reactivateUser,
};
