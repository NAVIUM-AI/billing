/**
 * Business profile settings logic. Routes call this instead of touching
 * the tenant repository directly, so response shaping (which columns
 * are safe to expose) lives in one place.
 */

const tenantRepository = require("../repositories/tenant.repository");
const { apiError } = require("../utils/httpError");

/**
 * Shapes a raw tenant row into the public "business profile" shape,
 * deliberately dropping internal bookkeeping columns.
 *
 * @param {object} tenant
 * @returns {object}
 */
function toProfile(tenant) {
  // current_invoice_seq is internal invoice-numbering state, not
  // something a client should see or infer business volume from.
  const {
    id,
    name,
    slug,
    gstin,
    pan,
    state_code,
    logo_url,
    tagline,
    phone,
    jurisdiction,
    invoice_prefix,
    trip_sheet_prefix,
    bank_details,
    settings,
    is_active,
    created_at,
    updated_at,
  } = tenant;

  return {
    id,
    name,
    slug,
    gstin,
    pan,
    state_code,
    logo_url,
    tagline,
    phone,
    jurisdiction,
    invoice_prefix,
    trip_sheet_prefix,
    bank_details,
    settings,
    is_active,
    created_at,
    updated_at,
  };
}

/**
 * @param {string} tenantId
 * @returns {Promise<object>}
 */
async function getBusinessProfile(tenantId) {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) {
    // Should be unreachable in practice — tenantId comes from a valid
    // JWT for an existing tenant — but a deleted/missing tenant is
    // cheap to guard against explicitly rather than let a raw
    // `undefined` reach toProfile().
    throw apiError(404, "TENANT_NOT_FOUND", "Tenant not found.");
  }
  return toProfile(tenant);
}

/**
 * @param {string} tenantId
 * @param {Record<string, unknown>} patch
 * @param {string} actorUserId - who made this change; unused today but
 *   threaded through so the audit-log hook below has it once it ships.
 * @returns {Promise<object>}
 */
// eslint-disable-next-line no-unused-vars
async function updateBusinessProfile(tenantId, patch, actorUserId) {
  await tenantRepository.updateProfile(tenantId, patch);

  // TODO: emit audit_log entry when audit module ships in Task 3.x.

  // Re-fetch through getBusinessProfile rather than shaping
  // updateProfile's own RETURNING row, so callers always get the exact
  // same response shape whether they just read or just wrote.
  return getBusinessProfile(tenantId);
}

module.exports = { getBusinessProfile, updateBusinessProfile };
