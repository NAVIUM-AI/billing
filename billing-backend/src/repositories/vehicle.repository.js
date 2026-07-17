/**
 * SQL for the `vehicles` table. `vehicles` has FORCE ROW LEVEL SECURITY
 * (see the vehicles migration), so every query here MUST run on a
 * client that already has `app.current_tenant_id` set for this
 * transaction — there is no `pool` fallback like the Module 1 repos
 * (tenants/users) have, because those tables are NOT RLS-protected and
 * a plain pool query would just filter out every row.
 *
 * Concretely: `client` is always a client obtained via
 * req.db.withTenantContext()/queryAsTenant() (see
 * middleware/tenantContext.js) — the service layer above decides
 * whether that's a single query or a shared transaction; this file
 * just uses whatever client it's handed.
 *
 * Every WHERE clause still includes tenant_id alongside id, even though
 * RLS already enforces it — belt and suspenders (Task 1.4/1.5
 * convention), and it keeps these functions correct even if RLS were
 * ever misconfigured.
 */

const { apiError } = require("../utils/httpError");

const UPDATABLE_COLUMNS = [
  "vehicle_type",
  "make_model",
  "registration_state",
  "seating_capacity",
  "fuel_type",
  "year_of_manufacture",
  "notes",
];

// Postgres SQLSTATE for a unique_violation.
const UNIQUE_VIOLATION = "23505";

/**
 * @param {string} tenantId
 * @param {{ canonicalNumber: string, displayNumber: string, vehicleType: string, makeModel?: string, registrationState?: string, seatingCapacity?: number, fuelType?: string, yearOfManufacture?: number, notes?: string, createdBy?: string }} params
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object>}
 */
async function insert(
  tenantId,
  {
    canonicalNumber,
    displayNumber,
    vehicleType,
    makeModel,
    registrationState,
    seatingCapacity,
    fuelType,
    yearOfManufacture,
    notes,
    createdBy,
  },
  client,
) {
  try {
    const result = await client.query(
      `INSERT INTO vehicles (
         tenant_id, vehicle_number, vehicle_number_display, vehicle_type,
         make_model, registration_state, seating_capacity, fuel_type,
         year_of_manufacture, notes, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        tenantId,
        canonicalNumber,
        displayNumber,
        vehicleType,
        makeModel || null,
        registrationState || null,
        seatingCapacity || null,
        fuelType || null,
        yearOfManufacture || null,
        notes || null,
        createdBy || null,
      ],
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      throw apiError(
        409,
        "VEHICLE_ALREADY_EXISTS",
        "A vehicle with this number already exists.",
        { vehicle_number: canonicalNumber },
      );
    }
    throw err;
  }
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function findById(tenantId, id, client) {
  const result = await client.query(
    "SELECT * FROM vehicles WHERE id = $1 AND tenant_id = $2",
    [id, tenantId],
  );
  return result.rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {string} canonicalNumber
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function findByNumber(tenantId, canonicalNumber, client) {
  const result = await client.query(
    "SELECT * FROM vehicles WHERE tenant_id = $1 AND vehicle_number = $2",
    [tenantId, canonicalNumber],
  );
  return result.rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {{ limit: number, offset: number, search?: string, searchCanonical?: string, type?: string, includeArchived?: boolean }} options
 *   `search` is matched against make_model (free text); `searchCanonical`
 *   is the same input normalized to canonical vehicle-number form and
 *   matched against vehicle_number — see vehicle.service.js#listVehicles,
 *   which derives both from the single query-string `search` param.
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{ rows: object[], total: number }>}
 */
async function list(
  tenantId,
  { limit, offset, search, searchCanonical, type, includeArchived },
  client,
) {
  const conditions = ["tenant_id = $1"];
  const values = [tenantId];

  if (!includeArchived) {
    conditions.push("is_active = true");
  }

  if (search) {
    values.push(`%${searchCanonical}%`, `%${search}%`);
    conditions.push(
      `(vehicle_number ILIKE $${values.length - 1} OR make_model ILIKE $${values.length})`,
    );
  }

  if (type) {
    values.push(type);
    conditions.push(`vehicle_type = $${values.length}`);
  }

  const whereClause = conditions.join(" AND ");

  // Two separate queries (list page + total count) rather than a
  // COUNT(*) OVER() window, so pagination.total reflects the full
  // matching set even when the requested page is empty (e.g. offset
  // past the end) — a window function would return no rows at all in
  // that case, losing the total.
  const listResult = await client.query(
    `SELECT * FROM vehicles
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset],
  );

  const countResult = await client.query(
    `SELECT COUNT(*) FROM vehicles WHERE ${whereClause}`,
    values,
  );

  return { rows: listResult.rows, total: Number(countResult.rows[0].count) };
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object>}
 */
async function update(tenantId, id, patch, client) {
  const keys = Object.keys(patch).filter((key) =>
    UPDATABLE_COLUMNS.includes(key),
  );
  if (keys.length === 0) {
    throw apiError(400, "EMPTY_PATCH", "No valid fields to update.");
  }

  // $1 = id, $2 = tenantId, so column placeholders start at $3.
  const setClause = keys.map((key, i) => `${key} = $${i + 3}`).join(", ");
  const values = keys.map((key) => patch[key]);

  const result = await client.query(
    `UPDATE vehicles SET ${setClause} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, tenantId, ...values],
  );
  return result.rows[0];
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {boolean} isActive
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function setActive(tenantId, id, isActive, client) {
  const result = await client.query(
    "UPDATE vehicles SET is_active = $3 WHERE id = $1 AND tenant_id = $2 RETURNING *",
    [id, tenantId, isActive],
  );
  return result.rows[0] || null;
}

module.exports = {
  insert,
  findById,
  findByNumber,
  list,
  update,
  setActive,
};
