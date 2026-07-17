/**
 * SQL for the `drivers` table. `drivers` has FORCE ROW LEVEL SECURITY
 * (see the drivers migration), so every query here MUST run on a client
 * that already has `app.current_tenant_id` set for this transaction —
 * same convention as vehicle.repository.js (Task 2.1). No `pool`
 * fallback; `client` is always a client obtained via
 * req.db.withTenantContext().
 *
 * Every WHERE clause still includes tenant_id alongside id, even though
 * RLS already enforces it — belt and suspenders (Task 1.4/1.5/2.1
 * convention).
 */

const { apiError } = require("../utils/httpError");

const UPDATABLE_COLUMNS = [
  "full_name",
  "phone",
  "phone_display",
  "license_number",
  "license_expiry_date",
  "address_line",
  "emergency_contact",
  "notes",
];

// Postgres SQLSTATE for a unique_violation.
const UNIQUE_VIOLATION = "23505";

/**
 * @param {string} tenantId
 * @param {{ fullName: string, phoneCanonical?: string, phoneDisplay?: string, licenseNumber?: string, licenseExpiryDate?: string, addressLine?: string, emergencyContact?: string, notes?: string, createdBy?: string }} params
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object>}
 */
async function insert(
  tenantId,
  {
    fullName,
    phoneCanonical,
    phoneDisplay,
    licenseNumber,
    licenseExpiryDate,
    addressLine,
    emergencyContact,
    notes,
    createdBy,
  },
  client,
) {
  try {
    const result = await client.query(
      `INSERT INTO drivers (
         tenant_id, full_name, phone, phone_display, license_number,
         license_expiry_date, address_line, emergency_contact, notes,
         created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        tenantId,
        fullName,
        phoneCanonical || null,
        phoneDisplay || null,
        licenseNumber || null,
        licenseExpiryDate || null,
        addressLine || null,
        emergencyContact || null,
        notes || null,
        createdBy || null,
      ],
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      // Two separate partial-uniqueness rules (Task 2.2 migration) can
      // both raise 23505 — branch on which constraint fired so the
      // caller gets an error that names the actual conflicting field,
      // not a generic "something already exists."
      if (err.constraint === "ux_drivers_phone_per_tenant") {
        throw apiError(
          409,
          "DRIVER_PHONE_ALREADY_EXISTS",
          "A driver with this phone number already exists.",
          { phone: phoneCanonical },
        );
      }
      if (err.constraint === "drivers_license_per_tenant_unique") {
        throw apiError(
          409,
          "DRIVER_LICENSE_ALREADY_EXISTS",
          "A driver with this license number already exists.",
          { license_number: licenseNumber },
        );
      }
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
    "SELECT * FROM drivers WHERE id = $1 AND tenant_id = $2",
    [id, tenantId],
  );
  return result.rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {string} canonicalPhone
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function findByPhone(tenantId, canonicalPhone, client) {
  const result = await client.query(
    "SELECT * FROM drivers WHERE tenant_id = $1 AND phone = $2",
    [tenantId, canonicalPhone],
  );
  return result.rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {string} licenseNumber
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function findByLicense(tenantId, licenseNumber, client) {
  const result = await client.query(
    "SELECT * FROM drivers WHERE tenant_id = $1 AND license_number = $2",
    [tenantId, licenseNumber],
  );
  return result.rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {{ limit: number, offset: number, searchOriginal?: string|null, searchPhoneCanonical?: string|null, includeArchived?: boolean }} options
 *   The service normalizes the incoming query-string `search` ONCE and
 *   hands both forms down (Task 2.1 convention) — this function does
 *   NOT re-normalize.
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{ rows: object[], total: number }>}
 */
async function list(
  tenantId,
  { limit, offset, searchOriginal, searchPhoneCanonical, includeArchived },
  client,
) {
  // Fixed-arity WHERE (vs. vehicle.repository.js's dynamically-built
  // one) since every filter here is a simple presence check the SQL
  // itself can express with IS NULL / boolean casts.
  //
  // Both ILIKE/LIKE matches are substring (%value%), not prefix-only:
  // canonical phones always carry the '91' country-code prefix, so a
  // short fragment a staff member remembers (e.g. the last 4 digits)
  // never starts the string — it has to be found anywhere within it.
  const whereClause = `
    tenant_id = $1
    AND ($2::bool OR is_active = true)
    AND (
      $3::text IS NULL
      OR full_name ILIKE '%' || $3 || '%'
      OR ($4::text IS NOT NULL AND phone LIKE '%' || $4 || '%')
    )
  `;
  const baseParams = [
    tenantId,
    includeArchived,
    searchOriginal,
    searchPhoneCanonical,
  ];

  // Two separate queries (list page + total count) rather than a
  // COUNT(*) OVER() window, so pagination.total reflects the full
  // matching set even when the requested page is empty.
  const listResult = await client.query(
    `SELECT * FROM drivers
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT $5 OFFSET $6`,
    [...baseParams, limit, offset],
  );

  const countResult = await client.query(
    `SELECT COUNT(*) FROM drivers WHERE ${whereClause}`,
    baseParams,
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
    `UPDATE drivers SET ${setClause} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
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
    "UPDATE drivers SET is_active = $3 WHERE id = $1 AND tenant_id = $2 RETURNING *",
    [id, tenantId, isActive],
  );
  return result.rows[0] || null;
}

module.exports = {
  insert,
  findById,
  findByPhone,
  findByLicense,
  list,
  update,
  setActive,
};
