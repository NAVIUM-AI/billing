/**
 * Joi schemas for the vehicle routes. Kept separate from the route file
 * so validation rules are easy to find and reuse.
 */

const Joi = require("joi");

const { normalize, isValidCanonical } = require("../utils/vehicleNumber");

// Mirrors the vehicle_type_enum Postgres type from the vehicles
// migration — keep these two in sync; add new values to both places.
const VEHICLE_TYPES = [
  "SEDAN",
  "SUV",
  "HATCHBACK",
  "INNOVA",
  "KIA_CARNIVAL",
  "TEMPO_TRAVELLER",
  "MINI_BUS",
  "BUS_50_SEATER",
  "OTHER",
];

const FUEL_TYPES = ["PETROL", "DIESEL", "CNG", "ELECTRIC", "HYBRID"];

const CURRENT_YEAR = new Date().getFullYear();

// Normalizes on parse, so downstream code (service/repo) never has to
// re-derive the canonical form or re-validate the format — the value
// Joi hands back is already { canonical, display }.
const vehicleNumberField = Joi.string()
  .trim()
  .min(4)
  .max(30)
  .required()
  .custom((val, helpers) => {
    const canonical = normalize(val);
    if (!isValidCanonical(canonical)) {
      return helpers.error("any.invalid");
    }
    return { canonical, display: val.trim() };
  })
  .messages({
    "any.invalid": "Invalid Indian vehicle registration format.",
  });

const createVehicleSchema = Joi.object({
  vehicle_number: vehicleNumberField,

  vehicle_type: Joi.string()
    .valid(...VEHICLE_TYPES)
    .required(),

  make_model: Joi.string().min(2).max(255),

  // If omitted, the service defaults this from the first 2 characters
  // of the canonical vehicle number (the state code) — deliberately
  // NOT done here, since that derivation depends on vehicle_number,
  // which by the time Joi runs is already transformed into
  // { canonical, display }.
  registration_state: Joi.string().length(2).uppercase(),

  seating_capacity: Joi.number().integer().min(1).max(60),

  fuel_type: Joi.string().valid(...FUEL_TYPES),

  year_of_manufacture: Joi.number()
    .integer()
    .min(1990)
    .max(CURRENT_YEAR + 1),

  notes: Joi.string().max(2000),
});

// Same fields as create, all optional, EXCEPT vehicle_number: it's
// immutable once set (invoices and trip sheets reference a vehicle by
// this identity). If it was entered wrong, the fix is archive +
// re-create, not an edit — see vehicle.service.js.
const updateVehicleSchema = Joi.object({
  vehicle_type: Joi.string().valid(...VEHICLE_TYPES),
  make_model: Joi.string().min(2).max(255),
  registration_state: Joi.string().length(2).uppercase(),
  seating_capacity: Joi.number().integer().min(1).max(60),
  fuel_type: Joi.string().valid(...FUEL_TYPES),
  year_of_manufacture: Joi.number()
    .integer()
    .min(1990)
    .max(CURRENT_YEAR + 1),
  notes: Joi.string().max(2000),
})
  .min(1)
  .messages({
    "object.min": "Provide at least one field to update.",
  });

const listVehiclesQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0),
  // Free-text search across vehicle_number (canonical match) and
  // make_model (substring match) — see vehicle.repository.js#list.
  search: Joi.string().min(1).max(30),
  type: Joi.string().valid(...VEHICLE_TYPES),
  includeArchived: Joi.boolean().default(false),
});

const vehicleIdParamSchema = Joi.object({
  vehicleId: Joi.string().guid({ version: "uuidv4" }).required(),
});

module.exports = {
  VEHICLE_TYPES,
  FUEL_TYPES,
  createVehicleSchema,
  updateVehicleSchema,
  listVehiclesQuerySchema,
  vehicleIdParamSchema,
};
