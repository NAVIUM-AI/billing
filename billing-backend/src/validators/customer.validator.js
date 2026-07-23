/**
 * Joi schemas for the customer + customer-contact routes. Kept
 * separate from the route file so validation rules are easy to find
 * and reuse.
 *
 * Cross-field validation is easier to read as post-validate custom
 * logic in the service. Keep the Joi schema focused on shape; handle
 * the richer rules (B2B required-fields combination, GSTIN/state
 * cross-check, state_code auto-derivation) in customer.service.js.
 * Only the B2C name-required / no-company-name rule is enforced here,
 * since it's a pure shape concern (which fields are allowed to be
 * present at all), not a cross-referenced business rule.
 */

const Joi = require("joi");

const phone = require("../utils/phoneNumber");
const gstinUtil = require("../utils/gstin");

const CUSTOMER_TYPES = ["B2C", "B2B"];

// Normalizes on parse, mirroring vehicleNumberField (Task 2.1) /
// phoneField (Task 2.2).
const phoneField = Joi.string()
  .trim()
  .min(6)
  .max(20)
  .custom((val, helpers) => {
    const canonical = phone.normalize(val);
    if (!phone.isValidCanonical(canonical)) {
      return helpers.error("any.invalid");
    }
    return { canonical, display: val.trim() };
  })
  .messages({
    "any.invalid": "Invalid phone number.",
  });

// Unlike phoneField, this returns a plain canonical string (not a
// { canonical, display } pair) — a GSTIN has no separate "as entered"
// display form worth keeping; it's either a valid GSTIN or it isn't.
const gstinField = Joi.string()
  .trim()
  .custom((val, helpers) => {
    const canonical = gstinUtil.normalize(val);
    if (!gstinUtil.isFormatValid(canonical)) {
      return helpers.error("any.invalid");
    }
    return canonical;
  })
  .messages({
    "any.invalid": "Invalid GSTIN format (expected 15 chars).",
  });

const addressSchema = Joi.object({
  line1: Joi.string().max(255).allow("", null),
  line2: Joi.string().max(255).allow("", null),
  city: Joi.string().max(100).allow("", null),
  district: Joi.string().max(100).allow("", null),
  state: Joi.string().max(100).allow("", null),
  pincode: Joi.string()
    .pattern(/^[0-9]{6}$/)
    .allow("", null),
  country: Joi.string().max(100).default("India"),
}).unknown(false);

const createCustomerSchema = Joi.object({
  customer_type: Joi.string()
    .valid(...CUSTOMER_TYPES)
    .required(),

  // Required for B2C, optional (primary billing contact) for B2B —
  // enforced by the .custom() below since it depends on customer_type.
  name: Joi.string().min(2).max(255),

  // Required for B2B, forbidden for B2C — same reasoning.
  company_name: Joi.string().min(2).max(255),

  gstin: gstinField,

  pan: Joi.string()
    .uppercase()
    .trim()
    .pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/),

  state_code: Joi.string().length(2).uppercase(),

  phone: phoneField,

  email: Joi.string().email().lowercase().trim(),

  address: addressSchema,

  // 0 = due immediately. A B2C customer with credit_days > 0 is
  // unusual (retail bookings are typically paid upfront/on delivery)
  // but not invalid — e.g. a corporate travel desk booking personal
  // trips for staff might still be B2C with agreed credit terms. Not
  // rejected here.
  credit_days: Joi.number().integer().min(0).max(365).default(0),

  notes: Joi.string().max(2000),
})
  .custom((value, helpers) => {
    if (value.customer_type === "B2C") {
      if (!value.name) {
        return helpers.error("customer.b2cNameRequired");
      }
      if (value.company_name) {
        return helpers.error("customer.b2cNoCompanyName");
      }
    }
    return value;
  })
  .messages({
    "customer.b2cNameRequired": '"name" is required for B2C customers.',
    "customer.b2cNoCompanyName": "B2C customers cannot have a company_name.",
  });

// All fields optional, EXCEPT customer_type: it's immutable. Switching
// a customer between B2C and B2B after creation would invalidate the
// required-fields assumptions every past invoice was built on, so it's
// explicitly forbidden (not just omitted) — a request that tries to
// change it gets a clear validation error rather than the field being
// silently dropped.
const updateCustomerSchema = Joi.object({
  customer_type: Joi.any()
    .forbidden()
    .messages({
      "any.unknown":
        "customer_type is immutable and cannot be changed after creation.",
    }),
  name: Joi.string().min(2).max(255),
  company_name: Joi.string().min(2).max(255),
  gstin: gstinField,
  pan: Joi.string()
    .uppercase()
    .trim()
    .pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/),
  state_code: Joi.string().length(2).uppercase(),
  phone: phoneField,
  email: Joi.string().email().lowercase().trim(),
  address: addressSchema,
  credit_days: Joi.number().integer().min(0).max(365),
  notes: Joi.string().max(2000),
})
  .min(1)
  .messages({
    "object.min": "Provide at least one field to update.",
  });

// Task 4.6: POST /customers/quick-create — a minimal-field variant for
// an inline "new customer" modal during trip/invoice creation. Unlike
// createCustomerSchema, gstin is optional even for B2B here (some B2B
// clients don't have GSTIN registration yet, and the frontend flow
// this serves needs to succeed without one) — the stricter
// B2B_REQUIRED_FIELDS check createCustomer.service.js enforces does
// NOT apply to this path; see customer.service.js#quickCreateCustomer.
const quickCreateCustomerSchema = Joi.object({
  customer_type: Joi.string()
    .valid(...CUSTOMER_TYPES)
    .required(),
  // Used as both the B2C display name and, when company_name is
  // omitted, the B2B company_name default — see quickCreateCustomer.
  name: Joi.string().trim().min(2).max(255).required(),
  company_name: Joi.string().trim().min(2).max(255),
  gstin: gstinField,
  phone: phoneField,
  email: Joi.string().email().lowercase().trim(),
})
  .unknown(false)
  .messages({
    "any.unknown": "Only customer_type, name, company_name, gstin, phone, and email are accepted here.",
  });

const listCustomersQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0),
  // Matched against name, company_name, email (substring), phone
  // (canonical fragment) or gstin (exact) — see
  // customer.repository.js#list.
  search: Joi.string().min(1).max(50),
  customer_type: Joi.string().valid(...CUSTOMER_TYPES),
  includeArchived: Joi.boolean().default(false),
});

const getCustomerQuerySchema = Joi.object({
  withContacts: Joi.boolean().default(false),
});

const createContactSchema = Joi.object({
  name: Joi.string().min(2).max(255).required(),
  role: Joi.string().max(100),
  phone: phoneField,
  email: Joi.string().email().lowercase().trim(),
  is_primary: Joi.boolean().default(false),
});

const customerIdParamSchema = Joi.object({
  customerId: Joi.string().guid({ version: "uuidv4" }).required(),
});

const customerContactParamSchema = Joi.object({
  customerId: Joi.string().guid({ version: "uuidv4" }).required(),
  contactId: Joi.string().guid({ version: "uuidv4" }).required(),
});

module.exports = {
  CUSTOMER_TYPES,
  createCustomerSchema,
  updateCustomerSchema,
  quickCreateCustomerSchema,
  listCustomersQuerySchema,
  getCustomerQuerySchema,
  createContactSchema,
  customerIdParamSchema,
  customerContactParamSchema,
};
