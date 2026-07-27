/**
 * Customer business logic. Routes call this instead of touching the
 * repository directly. Mirrors vehicle.service.js / driver.service.js
 * (Tasks 2.1/2.2): every method wraps its repo call(s) in
 * `db.withTenantContext()`, since the customer repository functions
 * take a raw pg client, not a finished query result.
 *
 * Cross-field business rules (B2B required-fields combination, GSTIN
 * auto-derivation of state_code, GSTIN/state mismatch) live here, not
 * in the validator — see the top-of-file comment in
 * customer.validator.js for why.
 */

const customerRepository = require("../repositories/customer.repository");
const phone = require("../utils/phoneNumber");
const gstinUtil = require("../utils/gstin");
const { apiError } = require("../utils/httpError");

/**
 * @param {string} tenantId
 * @param {object} input - validated createCustomerSchema output; input.phone is { canonical, display } or undefined
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db - req.db
 * @returns {Promise<object>}
 */
async function createCustomer(tenantId, input, actorUserId, db) {
  const phoneCanonical = input.phone ? input.phone.canonical : null;
  const phoneDisplay = input.phone ? input.phone.display : null;
  // gstin/email/pan/state_code are already canonicalized by Joi
  // (custom validator / .uppercase() / .lowercase() / .trim()) — no
  // need to re-normalize here.
  const gstin = input.gstin || null;
  let stateCode = input.state_code || null;

  // Auto-derive BEFORE the B2B required-fields check below: a B2B
  // customer that supplies gstin but omits state_code should succeed,
  // with state_code filled in for them, rather than be rejected for a
  // field we can derive ourselves.
  if (gstin && !stateCode) {
    stateCode = gstinUtil.stateFromGstin(gstin);
  }

  if (input.customer_type === "B2B") {
    if (!input.company_name || !gstin || !stateCode) {
      throw apiError(
        400,
        "B2B_REQUIRED_FIELDS",
        "B2B customer requires company_name, gstin, and state_code.",
      );
    }
  }

  // Only meaningful when the caller explicitly supplied BOTH gstin and
  // state_code — if state_code was just auto-derived above, it's
  // trivially equal to the derived value and this never fires.
  if (gstin && stateCode) {
    const derived = gstinUtil.stateFromGstin(gstin);
    if (derived && derived !== stateCode) {
      throw apiError(
        400,
        "GSTIN_STATE_MISMATCH",
        "GSTIN state code does not match provided state_code.",
        { gstin_state: derived, state_code: stateCode },
      );
    }
  }

  return db.withTenantContext(async (client) => {
    // Pre-checks are for a nicer error message on the ARCHIVED case
    // only (Task 2.1/2.2 convention) — a genuine active duplicate is
    // left to the unique constraint + repo.insert's own catch.
    if (gstin) {
      const existingByGstin = await customerRepository.findByGstin(
        tenantId,
        gstin,
        client,
      );
      if (existingByGstin && !existingByGstin.is_active) {
        throw apiError(
          409,
          "CUSTOMER_ARCHIVED_EXISTS",
          "A customer with this GSTIN exists but is archived. Reactivate it instead.",
          { customerId: existingByGstin.id, reason: "gstin" },
        );
      }
    }

    if (phoneCanonical) {
      const existingByPhone = await customerRepository.findByPhone(
        tenantId,
        phoneCanonical,
        client,
      );
      if (existingByPhone && !existingByPhone.is_active) {
        throw apiError(
          409,
          "CUSTOMER_ARCHIVED_EXISTS",
          "A customer with this phone exists but is archived. Reactivate it instead.",
          { customerId: existingByPhone.id, reason: "phone" },
        );
      }
    }

    return customerRepository.insert(
      tenantId,
      {
        customerType: input.customer_type,
        name: input.name || null,
        companyName: input.company_name || null,
        gstin,
        pan: input.pan || null,
        stateCode,
        phoneCanonical,
        phoneDisplay,
        email: input.email || null,
        address: input.address || {},
        creditDays: input.credit_days ?? 0,
        notes: input.notes,
        createdBy: actorUserId,
      },
      client,
    );
  });
}

/**
 * POST /customers/quick-create (Task 4.6) — a minimal-field variant of
 * createCustomer for an inline "new customer" modal during trip/invoice
 * creation. Reuses customerRepository.insert directly (the same
 * insertion path createCustomer itself calls) rather than duplicating
 * the INSERT SQL.
 *
 * ─── Flagged spec deviation: B2B still requires a GSTIN ───
 * The Task 4.6 spec asked for gstin to be optional even for B2B here
 * ("some B2B clients don't have GSTIN registration"), with this
 * function skipping createCustomer's own B2B_REQUIRED_FIELDS
 * application-layer check to allow it. That's only half the guard,
 * though: `customers_b2b_required_fields` (Task 2.3) is a DATABASE
 * CHECK constraint — `customer_type <> 'B2B' OR (company_name IS NOT
 * NULL AND gstin IS NOT NULL AND state_code IS NOT NULL)` — completely
 * independent of any application-layer check, and this task's own
 * constraints explicitly rule out schema changes. Skipping the
 * service-layer check therefore doesn't change the actual outcome: a
 * B2B quick-create without a gstin still fails, just one layer lower,
 * via the DB CHECK (translated by customer.repository.js's existing
 * mapConstraintError into the same clean 400 B2B_REQUIRED_FIELDS this
 * function would otherwise have thrown itself — no raw constraint
 * violation reaches the client either way). What quick-create actually
 * simplifies for B2B is the field list and the company-name default
 * (below), not the GSTIN requirement itself, which remains a real,
 * unbypassable invariant of this schema.
 *
 * @param {string} tenantId
 * @param {object} input - validated quickCreateCustomerSchema output; input.phone is { canonical, display } or undefined
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db - req.db
 * @returns {Promise<object>}
 */
async function quickCreateCustomer(tenantId, input, actorUserId, db) {
  const phoneCanonical = input.phone ? input.phone.canonical : null;
  const phoneDisplay = input.phone ? input.phone.display : null;
  const gstin = input.gstin || null;

  // Auto-derive state_code from the GSTIN when one is given — there is
  // no state_code field on this schema at all (quick-create has no way
  // to accept one directly), so a supplied GSTIN is the only source.
  const stateCode = gstin ? gstinUtil.stateFromGstin(gstin) : null;

  const companyName = input.customer_type === "B2B" ? input.company_name || input.name : null;

  return db.withTenantContext(async (client) => {
    // Same "nicer error on the archived case" pre-checks as
    // createCustomer — a genuine active duplicate is still left to the
    // unique constraint + repo.insert's own catch.
    if (gstin) {
      const existingByGstin = await customerRepository.findByGstin(tenantId, gstin, client);
      if (existingByGstin && !existingByGstin.is_active) {
        throw apiError(
          409,
          "CUSTOMER_ARCHIVED_EXISTS",
          "A customer with this GSTIN exists but is archived. Reactivate it instead.",
          { customerId: existingByGstin.id, reason: "gstin" },
        );
      }
    }
    if (phoneCanonical) {
      const existingByPhone = await customerRepository.findByPhone(tenantId, phoneCanonical, client);
      if (existingByPhone && !existingByPhone.is_active) {
        throw apiError(
          409,
          "CUSTOMER_ARCHIVED_EXISTS",
          "A customer with this phone exists but is archived. Reactivate it instead.",
          { customerId: existingByPhone.id, reason: "phone" },
        );
      }
    }

    return customerRepository.insert(
      tenantId,
      {
        customerType: input.customer_type,
        name: input.name,
        companyName,
        gstin,
        pan: null,
        stateCode,
        phoneCanonical,
        phoneDisplay,
        email: input.email || null,
        address: {},
        creditDays: 0,
        notes: null,
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
 * @param {{ includeContacts?: boolean }} [opts]
 * @returns {Promise<object>}
 */
async function getCustomer(tenantId, id, db, opts = {}) {
  return db.withTenantContext(async (client) => {
    const customer = await customerRepository.findById(tenantId, id, client);
    if (!customer) {
      throw apiError(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    }
    if (opts.includeContacts) {
      const contacts = await customerRepository.listContacts(
        tenantId,
        id,
        client,
      );
      return { ...customer, contacts };
    }
    return customer;
  });
}

/**
 * @param {string} tenantId
 * @param {{ limit: number, offset: number, search?: string, customer_type?: string, includeArchived?: boolean }} query
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ customers: object[], pagination: { total: number, limit: number, offset: number } }>}
 */
async function listCustomers(tenantId, query, db) {
  const { limit, offset, search, customer_type: customerType, includeArchived } =
    query;

  // Normalized once here, mirroring listVehicles/listDrivers — the repo
  // receives all forms and does not re-normalize.
  const searchOriginal = search ? search.trim() : null;
  const searchPhoneCanonical = searchOriginal
    ? phone.normalize(searchOriginal) || null
    : null;
  // gstinUtil.normalize just uppercases + strips whitespace — safe to
  // run on any input, even non-GSTIN search text.
  const searchGstinCanonical = searchOriginal
    ? gstinUtil.normalize(searchOriginal)
    : null;

  const { rows, total } = await db.withTenantContext((client) =>
    customerRepository.list(
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
    ),
  );

  return { customers: rows, pagination: { total, limit, offset } };
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {object} patch - validated updateCustomerSchema output; patch.phone, if present, is { canonical, display }
 * @param {string} actorUserId - unused today but threaded through so the
 *   audit-log hook below has it once it ships.
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
// eslint-disable-next-line no-unused-vars
async function updateCustomer(tenantId, id, patch, actorUserId, db) {
  return db.withTenantContext(async (client) => {
    const existing = await customerRepository.findById(tenantId, id, client);
    if (!existing) {
      throw apiError(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    }

    const repoPatch = { ...patch };
    if (patch.phone) {
      repoPatch.phone = patch.phone.canonical;
      repoPatch.phone_display = patch.phone.display;
    }

    // If this patch touches gstin or state_code, re-derive/re-validate
    // against the EFFECTIVE values (this patch layered on the existing
    // row), not just the patch in isolation — e.g. a patch that only
    // changes gstin must still be checked against the customer's
    // current state_code.
    if ("gstin" in patch || "state_code" in patch) {
      const combinedGstin = "gstin" in patch ? patch.gstin : existing.gstin;
      let combinedStateCode =
        "state_code" in patch ? patch.state_code : existing.state_code;

      if (combinedGstin && !combinedStateCode) {
        combinedStateCode = gstinUtil.stateFromGstin(combinedGstin);
        repoPatch.state_code = combinedStateCode;
      } else if (combinedGstin && combinedStateCode) {
        const derived = gstinUtil.stateFromGstin(combinedGstin);
        if (derived && derived !== combinedStateCode) {
          throw apiError(
            400,
            "GSTIN_STATE_MISMATCH",
            "GSTIN state code does not match provided state_code.",
            { gstin_state: derived, state_code: combinedStateCode },
          );
        }
      }
    }

    const updated = await customerRepository.update(
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
async function archiveCustomer(tenantId, id, actorUserId, db) {
  return db.withTenantContext(async (client) => {
    const existing = await customerRepository.findById(tenantId, id, client);
    if (!existing) {
      throw apiError(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    }

    if (!existing.is_active) {
      // Already archived — idempotent, not an error.
      return existing;
    }

    // TODO: later, refuse archive if the customer has open
    // (non-invoiced) trip sheets or unpaid invoices.

    const updated = await customerRepository.setActive(
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
async function unarchiveCustomer(tenantId, id, actorUserId, db) {
  return db.withTenantContext(async (client) => {
    const existing = await customerRepository.findById(tenantId, id, client);
    if (!existing) {
      throw apiError(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    }

    if (existing.is_active) {
      // Already active — idempotent, not an error.
      return existing;
    }

    const updated = await customerRepository.setActive(
      tenantId,
      id,
      true,
      client,
    );

    // TODO: emit audit_log entry when audit module ships in Task 3.x.

    return updated;
  });
}

/**
 * @param {string} tenantId
 * @param {string} customerId
 * @param {object} input - validated createContactSchema output; input.phone, if present, is { canonical, display }
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
async function addContact(tenantId, customerId, input, db) {
  return db.withTenantContext(async (client) => {
    const customer = await customerRepository.findById(
      tenantId,
      customerId,
      client,
    );
    if (!customer) {
      throw apiError(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    }

    // Contacts are a B2B concept — a B2C customer's own phone/email
    // (on the customer row itself) is the only contact point there is.
    if (customer.customer_type === "B2C") {
      throw apiError(
        400,
        "CONTACTS_B2B_ONLY",
        "Contacts can only be added to B2B customers.",
      );
    }

    const phoneCanonical = input.phone ? input.phone.canonical : null;
    const phoneDisplay = input.phone ? input.phone.display : null;

    return customerRepository.insertContact(
      tenantId,
      customerId,
      {
        name: input.name,
        role: input.role,
        phoneCanonical,
        phoneDisplay,
        email: input.email,
        isPrimary: input.is_primary,
      },
      client,
    );
  });
}

/**
 * @param {string} tenantId
 * @param {string} customerId
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object[]>}
 */
async function listCustomerContacts(tenantId, customerId, db) {
  return db.withTenantContext(async (client) => {
    const customer = await customerRepository.findById(
      tenantId,
      customerId,
      client,
    );
    if (!customer) {
      throw apiError(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    }
    // Primary first, then most recent — repo's ORDER BY already does
    // this (is_primary DESC, created_at DESC).
    return customerRepository.listContacts(tenantId, customerId, client);
  });
}

/**
 * @param {string} tenantId
 * @param {string} customerId
 * @param {string} contactId
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<void>}
 */
async function removeContact(tenantId, customerId, contactId, db) {
  return db.withTenantContext(async (client) => {
    const customer = await customerRepository.findById(
      tenantId,
      customerId,
      client,
    );
    if (!customer) {
      throw apiError(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    }
    await customerRepository.deleteContact(
      tenantId,
      customerId,
      contactId,
      client,
    );
  });
}

module.exports = {
  createCustomer,
  quickCreateCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
  archiveCustomer,
  unarchiveCustomer,
  addContact,
  listCustomerContacts,
  removeContact,
};
