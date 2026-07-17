/**
 * Joi schemas for the driver routes. Kept separate from the route file
 * so validation rules are easy to find and reuse.
 */

const Joi = require("joi");

const phone = require("../utils/phoneNumber");

// Normalizes on parse, mirroring vehicleNumberField (Task 2.1) — the
// value Joi hands back is already { canonical, display }, so downstream
// code never has to re-normalize or re-validate the format.
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

const createDriverSchema = Joi.object({
  full_name: Joi.string().min(2).max(255).required(),

  phone: phoneField,

  license_number: Joi.string().min(5).max(30).uppercase().trim(),

  // Allows null explicitly: an agency may want to record that a driver
  // HAS a license with no tracked expiry, distinct from omitting the
  // field (leave whatever's already there untouched, on update).
  license_expiry_date: Joi.date().iso().allow(null),

  address_line: Joi.string().max(500),

  emergency_contact: phoneField,

  notes: Joi.string().max(2000),
});

// Same fields as create, but every one of them — including phone and
// license — is editable here. Unlike a vehicle's registration number
// (Task 2.1), a driver's phone/license genuinely change over time
// (lost license, new SIM), so there's no immutability rule to enforce.
const updateDriverSchema = Joi.object({
  full_name: Joi.string().min(2).max(255),
  phone: phoneField,
  license_number: Joi.string().min(5).max(30).uppercase().trim(),
  license_expiry_date: Joi.date().iso().allow(null),
  address_line: Joi.string().max(500),
  emergency_contact: phoneField,
  notes: Joi.string().max(2000),
})
  .min(1)
  .messages({
    "object.min": "Provide at least one field to update.",
  });

const listDriversQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0),
  // Matched against full_name (substring) or phone (canonical prefix) —
  // see driver.repository.js#list.
  search: Joi.string().min(1).max(50),
  includeArchived: Joi.boolean().default(false),
});

const driverIdParamSchema = Joi.object({
  driverId: Joi.string().guid({ version: "uuidv4" }).required(),
});

module.exports = {
  createDriverSchema,
  updateDriverSchema,
  listDriversQuerySchema,
  driverIdParamSchema,
};
