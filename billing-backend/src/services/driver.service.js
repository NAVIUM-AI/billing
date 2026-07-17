/**
 * Driver business logic. Routes call this instead of touching the
 * repository directly. Mirrors vehicle.service.js's shape (Task 2.1):
 * every method wraps its repo call(s) in `db.withTenantContext()`,
 * since the driver repository functions take a raw pg client, not a
 * finished query result.
 */

const driverRepository = require("../repositories/driver.repository");
const phone = require("../utils/phoneNumber");
const { apiError } = require("../utils/httpError");

/**
 * @param {string} tenantId
 * @param {object} input - validated createDriverSchema output; input.phone / input.emergency_contact are { canonical, display } or undefined
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db - req.db
 * @returns {Promise<object>}
 */
async function createDriver(tenantId, input, actorUserId, db) {
  const phoneCanonical = input.phone ? input.phone.canonical : null;
  const phoneDisplay = input.phone ? input.phone.display : null;
  const emergencyContact = input.emergency_contact
    ? input.emergency_contact.canonical
    : null;
  const licenseNumber = input.license_number || null;

  return db.withTenantContext(async (client) => {
    // Pre-checks are for a nicer error message on the ARCHIVED case
    // only (Task 2.1 convention) — a genuine active duplicate is left
    // to the unique constraint + repo.insert's own catch, since that's
    // already correct and doesn't need a friendlier message.
    if (phoneCanonical) {
      const existingByPhone = await driverRepository.findByPhone(
        tenantId,
        phoneCanonical,
        client,
      );
      if (existingByPhone && !existingByPhone.is_active) {
        throw apiError(
          409,
          "DRIVER_ARCHIVED_EXISTS",
          "A driver with this phone exists but is archived. Reactivate it instead.",
          { driverId: existingByPhone.id, reason: "phone" },
        );
      }
    }

    if (licenseNumber) {
      const existingByLicense = await driverRepository.findByLicense(
        tenantId,
        licenseNumber,
        client,
      );
      if (existingByLicense && !existingByLicense.is_active) {
        throw apiError(
          409,
          "DRIVER_ARCHIVED_EXISTS",
          "A driver with this license exists but is archived. Reactivate it instead.",
          { driverId: existingByLicense.id, reason: "license" },
        );
      }
    }

    return driverRepository.insert(
      tenantId,
      {
        fullName: input.full_name,
        phoneCanonical,
        phoneDisplay,
        licenseNumber,
        licenseExpiryDate: input.license_expiry_date ?? null,
        addressLine: input.address_line,
        emergencyContact,
        notes: input.notes,
        createdBy: actorUserId,
      },
      client,
    );
  });
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
async function getDriver(tenantId, id, db) {
  const driver = await db.withTenantContext((client) =>
    driverRepository.findById(tenantId, id, client),
  );
  if (!driver) {
    throw apiError(404, "DRIVER_NOT_FOUND", "Driver not found.");
  }
  return driver;
}

/**
 * @param {string} tenantId
 * @param {{ limit: number, offset: number, search?: string, includeArchived?: boolean }} query
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ drivers: object[], pagination: { total: number, limit: number, offset: number } }>}
 */
async function listDrivers(tenantId, query, db) {
  const { limit, offset, search, includeArchived } = query;

  // Normalized once here, mirroring vehicle.service.js#listVehicles —
  // the repo receives both forms and does not re-normalize.
  const searchOriginal = search ? search.trim() : null;
  const searchPhoneCanonical = searchOriginal
    ? phone.normalize(searchOriginal) || null
    : null;

  const { rows, total } = await db.withTenantContext((client) =>
    driverRepository.list(
      tenantId,
      { limit, offset, searchOriginal, searchPhoneCanonical, includeArchived },
      client,
    ),
  );

  return { drivers: rows, pagination: { total, limit, offset } };
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {object} patch - validated updateDriverSchema output; patch.phone / patch.emergency_contact, if present, are { canonical, display }
 * @param {string} actorUserId - unused today but threaded through so the
 *   audit-log hook below has it once it ships.
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
// eslint-disable-next-line no-unused-vars
async function updateDriver(tenantId, id, patch, actorUserId, db) {
  return db.withTenantContext(async (client) => {
    const existing = await driverRepository.findById(tenantId, id, client);
    if (!existing) {
      throw apiError(404, "DRIVER_NOT_FOUND", "Driver not found.");
    }

    // phone / emergency_contact arrive as { canonical, display } from
    // the validator; the repo's column whitelist expects flat `phone` /
    // `phone_display` values (emergency_contact has no separate display
    // column — it's canonical-only, per the migration).
    const repoPatch = { ...patch };
    if (patch.phone) {
      repoPatch.phone = patch.phone.canonical;
      repoPatch.phone_display = patch.phone.display;
    }
    if (patch.emergency_contact) {
      repoPatch.emergency_contact = patch.emergency_contact.canonical;
    }

    const updated = await driverRepository.update(
      tenantId,
      id,
      repoPatch,
      client,
    );

    // TODO: emit audit_log entry when audit module ships in Task 3.x.

    return updated;
  });
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {string} actorUserId - unused today but threaded through so the
 *   audit-log hook below has it once it ships.
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
// eslint-disable-next-line no-unused-vars
async function archiveDriver(tenantId, id, actorUserId, db) {
  return db.withTenantContext(async (client) => {
    const existing = await driverRepository.findById(tenantId, id, client);
    if (!existing) {
      throw apiError(404, "DRIVER_NOT_FOUND", "Driver not found.");
    }

    if (!existing.is_active) {
      // Already archived — idempotent, not an error.
      return existing;
    }

    // TODO: later, refuse archive if the driver has open (non-invoiced)
    // trip sheets.

    const updated = await driverRepository.setActive(
      tenantId,
      id,
      false,
      client,
    );

    // TODO: emit audit_log entry when audit module ships in Task 3.x.

    return updated;
  });
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {string} actorUserId - unused today but threaded through so the
 *   audit-log hook below has it once it ships.
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
// eslint-disable-next-line no-unused-vars
async function unarchiveDriver(tenantId, id, actorUserId, db) {
  return db.withTenantContext(async (client) => {
    const existing = await driverRepository.findById(tenantId, id, client);
    if (!existing) {
      throw apiError(404, "DRIVER_NOT_FOUND", "Driver not found.");
    }

    if (existing.is_active) {
      // Already active — idempotent, not an error.
      return existing;
    }

    const updated = await driverRepository.setActive(
      tenantId,
      id,
      true,
      client,
    );

    // TODO: emit audit_log entry when audit module ships in Task 3.x.

    return updated;
  });
}

module.exports = {
  createDriver,
  getDriver,
  listDrivers,
  updateDriver,
  archiveDriver,
  unarchiveDriver,
};
