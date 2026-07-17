/**
 * SQL for the `customers` and `customer_contacts` tables. Both have
 * FORCE ROW LEVEL SECURITY (see the customers migration), so every
 * query here MUST run on a client that already has
 * `app.current_tenant_id` set for this transaction — same convention
 * as vehicle.repository.js / driver.repository.js (Tasks 2.1/2.2). No
 * `pool` fallback; `client` is always a client obtained via
 * req.db.withTenantContext().
 *
 * Every WHERE clause still includes tenant_id alongside id, even though
 * RLS already enforces it — belt and suspenders (established
 * convention since Task 1.4).
 */

const { apiError } = require("../utils/httpError");

const UPDATABLE_COLUMNS = [
  "name",
  "company_name",
  "gstin",
  "pan",
  "state_code",
  "phone",
  "phone_display",
  "email",
  "address",
  "credit_days",
  "notes",
];

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

/**
 * Shared between insert() and update(): both can hit the same unique
 * and check constraints (e.g. a PATCH that changes gstin to one
 * already used by another customer, or that would leave a B2B
 * customer without a company_name). Centralizing the mapping means a
 * constraint violation always surfaces as the same clear error
 * regardless of which statement triggered it, instead of insert-only
 * handling leaking a raw 500 on update.
 *
 * @param {Error & { code?: string, constraint?: string }} err
 * @param {{ gstin?: string, phoneCanonical?: string }} context
 */
function mapConstraintError(err, { gstin, phoneCanonical } = {}) {
  if (err.code === UNIQUE_VIOLATION) {
    if (err.constraint === "ux_customers_gstin_per_tenant") {
      throw apiError(
        409,
        "CUSTOMER_GSTIN_ALREADY_EXISTS",
        "A customer with this GSTIN already exists.",
        { gstin },
      );
    }
    if (err.constraint === "ux_customers_phone_per_tenant") {
      throw apiError(
        409,
        "CUSTOMER_PHONE_ALREADY_EXISTS",
        "A customer with this phone already exists.",
        { phone: phoneCanonical },
      );
    }
  }

  if (err.code === CHECK_VIOLATION) {
    if (err.constraint === "customers_b2b_required_fields") {
      throw apiError(
        400,
        "B2B_REQUIRED_FIELDS",
        "B2B customer requires company_name, gstin, and state_code.",
      );
    }
    if (err.constraint === "customers_b2c_required_fields") {
      throw apiError(400, "B2C_REQUIRED_FIELDS", "B2C customer requires name.");
    }
    if (
      err.constraint === "customers_gstin_format" ||
      err.constraint === "customers_pan_format" ||
      err.constraint === "customers_state_code_format"
    ) {
      throw apiError(400, "INVALID_FORMAT", err.constraint);
    }
  }

  throw err;
}

/**
 * @param {string} tenantId
 * @param {object} params
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object>}
 */
async function insert(
  tenantId,
  {
    customerType,
    name,
    companyName,
    gstin,
    pan,
    stateCode,
    phoneCanonical,
    phoneDisplay,
    email,
    address,
    creditDays,
    notes,
    createdBy,
  },
  client,
) {
  try {
    const result = await client.query(
      `INSERT INTO customers (
         tenant_id, customer_type, name, company_name, gstin, pan,
         state_code, phone, phone_display, email, address, credit_days,
         notes, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        tenantId,
        customerType,
        name || null,
        companyName || null,
        gstin || null,
        pan || null,
        stateCode || null,
        phoneCanonical || null,
        phoneDisplay || null,
        email || null,
        JSON.stringify(address || {}),
        creditDays ?? 0,
        notes || null,
        createdBy || null,
      ],
    );
    return result.rows[0];
  } catch (err) {
    mapConstraintError(err, { gstin, phoneCanonical });
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
    "SELECT * FROM customers WHERE id = $1 AND tenant_id = $2",
    [id, tenantId],
  );
  return result.rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {string} gstin
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function findByGstin(tenantId, gstin, client) {
  const result = await client.query(
    "SELECT * FROM customers WHERE tenant_id = $1 AND gstin = $2",
    [tenantId, gstin],
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
    "SELECT * FROM customers WHERE tenant_id = $1 AND phone = $2",
    [tenantId, canonicalPhone],
  );
  return result.rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {{ limit: number, offset: number, searchOriginal?: string|null, searchPhoneCanonical?: string|null, searchGstinCanonical?: string|null, customerType?: string|null, includeArchived?: boolean }} options
 *   The service normalizes the incoming query-string `search` ONCE and
 *   hands all three forms down (Task 2.1/2.2 convention) — this
 *   function does NOT re-normalize.
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{ rows: object[], total: number }>}
 */
async function list(
  tenantId,
  {
    limit,
    offset,
    searchOriginal,
    searchPhoneCanonical,
    searchGstinCanonical,
    customerType,
    includeArchived,
  },
  client,
) {
  // Fixed-arity WHERE (Task 2.2 convention) — every filter is a simple
  // presence check the SQL itself expresses via IS NULL / boolean casts.
  //
  // The phone match is substring (%value%), not prefix-only: canonical
  // phones always carry the '91' country-code prefix, so a short
  // fragment a staff member remembers (e.g. the last 4 digits) never
  // starts the string — see driver.repository.js#list for the same
  // reasoning.
  const whereClause = `
    tenant_id = $1
    AND ($2::bool OR is_active = true)
    AND ($3::text IS NULL OR customer_type = $3::customer_type_enum)
    AND (
      $4::text IS NULL
      OR name ILIKE '%' || $4 || '%'
      OR company_name ILIKE '%' || $4 || '%'
      OR email ILIKE '%' || $4 || '%'
      OR ($5::text IS NOT NULL AND phone LIKE '%' || $5 || '%')
      OR ($6::text IS NOT NULL AND gstin = $6)
    )
  `;
  const baseParams = [
    tenantId,
    includeArchived,
    customerType,
    searchOriginal,
    searchPhoneCanonical,
    searchGstinCanonical,
  ];

  // Two separate queries (list page + total count) rather than a
  // COUNT(*) OVER() window, so pagination.total reflects the full
  // matching set even when the requested page is empty.
  const listResult = await client.query(
    `SELECT * FROM customers
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT $7 OFFSET $8`,
    [...baseParams, limit, offset],
  );

  const countResult = await client.query(
    `SELECT COUNT(*) FROM customers WHERE ${whereClause}`,
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
  const values = keys.map((key) =>
    key === "address" ? JSON.stringify(patch[key]) : patch[key],
  );

  try {
    const result = await client.query(
      `UPDATE customers SET ${setClause} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, ...values],
    );
    return result.rows[0];
  } catch (err) {
    mapConstraintError(err, {
      gstin: patch.gstin,
      phoneCanonical: patch.phone,
    });
  }
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
    "UPDATE customers SET is_active = $3 WHERE id = $1 AND tenant_id = $2 RETURNING *",
    [id, tenantId, isActive],
  );
  return result.rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {string} customerId
 * @param {{ name: string, role?: string, phoneCanonical?: string, phoneDisplay?: string, email?: string, isPrimary?: boolean }} params
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object>}
 */
async function insertContact(
  tenantId,
  customerId,
  { name, role, phoneCanonical, phoneDisplay, email, isPrimary },
  client,
) {
  if (isPrimary) {
    // Flip off any existing primary contact first, in the same
    // transaction as the insert below, so two concurrent "set as
    // primary" requests can't both succeed and leave two primaries —
    // the second one to commit will simply win.
    await client.query(
      "UPDATE customer_contacts SET is_primary = false WHERE customer_id = $1 AND is_primary = true",
      [customerId],
    );
  }

  try {
    const result = await client.query(
      `INSERT INTO customer_contacts (
         customer_id, tenant_id, name, role, phone, phone_display,
         email, is_primary
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        customerId,
        tenantId,
        name,
        role || null,
        phoneCanonical || null,
        phoneDisplay || null,
        email || null,
        Boolean(isPrimary),
      ],
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION && err.constraint === "ux_customer_contacts_one_primary") {
      // Fallback for the race the flip-off above can't fully close: two
      // requests both flip off the existing primary, then both try to
      // insert as primary — one wins, the other hits this constraint.
      throw apiError(
        409,
        "CONTACT_PRIMARY_CONFLICT",
        "Another contact was just set as primary. Please retry.",
      );
    }
    throw err;
  }
}

/**
 * @param {string} tenantId
 * @param {string} customerId
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object[]>}
 */
async function listContacts(tenantId, customerId, client) {
  const result = await client.query(
    `SELECT * FROM customer_contacts
     WHERE customer_id = $1 AND tenant_id = $2
     ORDER BY is_primary DESC, created_at DESC`,
    [customerId, tenantId],
  );
  return result.rows;
}

/**
 * @param {string} tenantId
 * @param {string} customerId
 * @param {string} contactId
 * @param {import('pg').PoolClient} client
 * @returns {Promise<void>}
 */
async function deleteContact(tenantId, customerId, contactId, client) {
  await client.query(
    "DELETE FROM customer_contacts WHERE id = $1 AND customer_id = $2 AND tenant_id = $3",
    [contactId, customerId, tenantId],
  );
}

module.exports = {
  insert,
  findById,
  findByGstin,
  findByPhone,
  list,
  update,
  setActive,
  insertContact,
  listContacts,
  deleteContact,
};
