/**
 * Vehicle business logic. Routes call this instead of touching the
 * repository directly.
 *
 * Every method below wraps its repo call(s) in `db.withTenantContext()`
 * rather than `db.queryAsTenant()`: the vehicle repository functions
 * take a raw pg client and call `client.query()` themselves (see
 * vehicle.repository.js), so what they need from us is the checked-out,
 * tenant-scoped client itself — queryAsTenant only hands back a finished
 * query result, not a client, so it can't be threaded into a repo call.
 */

const vehicleRepository = require("../repositories/vehicle.repository");
const { normalize } = require("../utils/vehicleNumber");
const { apiError } = require("../utils/httpError");

/**
 * @param {string} tenantId
 * @param {object} input - validated createVehicleSchema output; input.vehicle_number is { canonical, display }
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db - req.db
 * @returns {Promise<object>}
 */
async function createVehicle(tenantId, input, actorUserId, db) {
  const { canonical, display } = input.vehicle_number;
  // Derived, not defaulted in the validator: the validator only sees
  // the raw string before it's transformed into { canonical, display },
  // so deriving the state code from the canonical number has to happen
  // here.
  const registrationState = input.registration_state || canonical.slice(0, 2);

  return db.withTenantContext(async (client) => {
    // Pre-check (rather than relying solely on the unique constraint)
    // so we can tell the caller WHY it conflicts — an archived vehicle
    // needs a different fix (reactivate) than a truly-duplicate active
    // one. Both this check and repo.insert's own unique-violation catch
    // run inside the same transaction, so a concurrent request creating
    // the same number between our check and our insert is still caught
    // by the DB constraint, not silently missed.
    const existing = await vehicleRepository.findByNumber(
      tenantId,
      canonical,
      client,
    );
    if (existing) {
      if (!existing.is_active) {
        throw apiError(
          409,
          "VEHICLE_ARCHIVED_EXISTS",
          "This vehicle exists but is archived. Reactivate it instead.",
          { vehicleId: existing.id },
        );
      }
      throw apiError(
        409,
        "VEHICLE_ALREADY_EXISTS",
        "A vehicle with this number already exists.",
        { vehicle_number: canonical },
      );
    }

    return vehicleRepository.insert(
      tenantId,
      {
        canonicalNumber: canonical,
        displayNumber: display,
        vehicleType: input.vehicle_type,
        makeModel: input.make_model,
        registrationState,
        seatingCapacity: input.seating_capacity,
        fuelType: input.fuel_type,
        yearOfManufacture: input.year_of_manufacture,
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
async function getVehicle(tenantId, id, db) {
  const vehicle = await db.withTenantContext((client) =>
    vehicleRepository.findById(tenantId, id, client),
  );
  if (!vehicle) {
    throw apiError(404, "VEHICLE_NOT_FOUND", "Vehicle not found.");
  }
  return vehicle;
}

/**
 * @param {string} tenantId
 * @param {{ limit: number, offset: number, search?: string, type?: string, includeArchived?: boolean }} query
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ vehicles: object[], pagination: { total: number, limit: number, offset: number } }>}
 */
async function listVehicles(tenantId, query, db) {
  const { limit, offset, search, type, includeArchived } = query;

  // Normalized once here so "ka51ak1031" and "KA 51 AK 1031" both hit
  // the same vehicle_number values — the repo uses this for the
  // vehicle_number match and the raw `search` string for the
  // free-text make_model match (see vehicle.repository.js#list).
  const searchCanonical = search ? normalize(search) : undefined;

  const { rows, total } = await db.withTenantContext((client) =>
    vehicleRepository.list(
      tenantId,
      { limit, offset, search, searchCanonical, type, includeArchived },
      client,
    ),
  );

  return { vehicles: rows, pagination: { total, limit, offset } };
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @param {string} actorUserId - unused today but threaded through so the
 *   audit-log hook below has it once it ships.
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
// eslint-disable-next-line no-unused-vars
async function updateVehicle(tenantId, id, patch, actorUserId, db) {
  return db.withTenantContext(async (client) => {
    const existing = await vehicleRepository.findById(tenantId, id, client);
    if (!existing) {
      throw apiError(404, "VEHICLE_NOT_FOUND", "Vehicle not found.");
    }

    const updated = await vehicleRepository.update(tenantId, id, patch, client);

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
async function archiveVehicle(tenantId, id, actorUserId, db) {
  return db.withTenantContext(async (client) => {
    const existing = await vehicleRepository.findById(tenantId, id, client);
    if (!existing) {
      throw apiError(404, "VEHICLE_NOT_FOUND", "Vehicle not found.");
    }

    if (!existing.is_active) {
      // Already archived — idempotent, not an error.
      return existing;
    }

    // TODO: in a later task, refuse to archive if the vehicle has open
    // (non-invoiced) trip sheets.

    const updated = await vehicleRepository.setActive(
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
async function unarchiveVehicle(tenantId, id, actorUserId, db) {
  return db.withTenantContext(async (client) => {
    const existing = await vehicleRepository.findById(tenantId, id, client);
    if (!existing) {
      throw apiError(404, "VEHICLE_NOT_FOUND", "Vehicle not found.");
    }

    if (existing.is_active) {
      // Already active — idempotent, not an error.
      return existing;
    }

    const updated = await vehicleRepository.setActive(
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
  createVehicle,
  getVehicle,
  listVehicles,
  updateVehicle,
  archiveVehicle,
  unarchiveVehicle,
};
