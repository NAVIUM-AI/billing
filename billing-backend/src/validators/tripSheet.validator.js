/**
 * Joi schema for POST /trips (LOCAL trip creation, Task 3.1). Kept
 * separate from the route file so validation rules are easy to find and
 * reuse.
 *
 * Cross-field rules that need DB state (customer/vehicle lookups, the
 * opening/closing km check, service_type branching) live in
 * tripSheet.service.js per the Rule 2 service order
 * (normalize -> derive -> validate -> check -> write) — this schema is
 * shape-only. The one exception is opening_km/closing_km ordering,
 * which IS a pure shape concern (comparing two fields already on the
 * request) — see the service for why it's still checked there instead
 * of here: apiError needs a specific code (INVALID_KM_RANGE) that Joi's
 * generic VALIDATION_ERROR wrapping would obscure.
 */

const Joi = require("joi");

const { VEHICLE_TYPES } = require("./vehicle.validator");

const SERVICE_TYPES = ["LOCAL", "OUTSTATION"];
const BILLING_MODES = ["GST", "PERFORMANCE"];

// Mirrors tripSheet.service.js#deriveRuleType exactly — duplicated
// here (rather than imported) because this file is deliberately
// framework/business-logic-free (shape-only, per this file's own
// top-of-file comment); the two must be kept in sync by hand if a new
// service_type/billing_mode combination is ever added.
function ruleTypeFor(serviceType, billingMode) {
  if (serviceType === "LOCAL" && billingMode === "GST") return "LOCAL_PACKAGE";
  if (serviceType === "OUTSTATION" && billingMode === "GST") return "OUTSTATION_SLAB";
  return "PERFORMANCE";
}

// Which manual-mode rate fields are required for each formula. Mirrors
// pricingRule.validator.js#rateAndLabelFields's own bounds
// (.positive().max(1_000_000) for rupee fields, .integer().min(0).
// max(10000) for plain counts) for consistency with the fleet-mode
// equivalents of these same fields.
const MANUAL_RATE_FIELDS_BY_FORMULA = {
  LOCAL_PACKAGE: ["base_price_rupees", "base_hours", "base_km", "extra_km_rate_rupees", "extra_hr_rate_rupees"],
  OUTSTATION_SLAB: ["slab_rate_rupees", "min_km_per_day", "driver_batta_per_day_rupees"],
  // NOTE: performance_batta_rupees is a FLAT one-time amount, not a
  // per-day rate — src/domain/pricing/performance.js#calculatePerformance
  // uses rule.performance_batta_paise as-is with no total_days
  // multiplication (confirmed by reading the actual calculator, Part
  // A), unlike LOCAL_PACKAGE/OUTSTATION_SLAB's genuinely per-unit
  // fields. Fleet-mode's own pricing_rules.performance_batta_rupees
  // field (pricingRule.validator.js) has no "per day" semantics either
  // — this mirrors that exactly rather than inventing a day-multiplier
  // the real system doesn't have.
  PERFORMANCE: ["per_km_rate_rupees", "performance_batta_rupees"],
};

/**
 * Real-calendar-date check using explicit UTC accessors throughout
 * (Date.UTC / getUTC*) — mirrors pricingRule.validator.js's
 * isValidCalendarDate. See that file's top-of-file comment for why
 * dates are validated as plain strings instead of via Joi.date() /
 * Joi.string().isoDate(): both round-trip through a JS Date and
 * reformat to a full UTC datetime, risking the same local-midnight
 * DATE-column shift documented in Task 2.2.
 *
 * @param {string} str
 * @returns {boolean}
 */
function isValidCalendarDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

// Deliberately NOT Joi.date().max('now') / a schema-build-time default:
// "today" must be evaluated at VALIDATION time (each request), not once
// when this module is first require()'d — a long-running server would
// otherwise compare against the date it booted on. Leeway: today itself
// is allowed ("not in the future" means "today or earlier").
const tripDateField = Joi.string()
  .custom((val, helpers) => {
    if (!isValidCalendarDate(val)) {
      return helpers.error("date.invalidCalendarDate");
    }
    const today = new Date().toISOString().slice(0, 10);
    if (val > today) {
      return helpers.error("date.tripDateFuture");
    }
    return val;
  })
  .messages({
    "date.invalidCalendarDate": "must be a valid date in YYYY-MM-DD format",
    "date.tripDateFuture": "trip_date cannot be in the future",
  });

// One itemized toll-plaza receipt. For OUTSTATION trips: the tolls
// array is the preferred input. toll_rupees is retained for backward
// compatibility with LOCAL trips and for OUTSTATION trips where the
// customer only provides a lump-sum receipt total. See
// tripSheet.service.js for the cross-field rule (TOLL_INPUT_CONFLICT)
// that rejects supplying both — that check needs to compare against
// the *other* field in the request, which is exactly the kind of
// cross-field concern this file's top comment says belongs in the
// service, not here.
const tollReceiptSchema = Joi.object({
  plaza_name: Joi.string().trim().min(2).max(255).required(),
  toll_id: Joi.string().trim().max(50).allow("", null),
  amount_rupees: Joi.number().positive().max(50000).required(),
  crossed_at: Joi.string().isoDate().allow(null),
  vehicle_number: Joi.string().trim().max(30).allow("", null),
  closing_balance_rupees: Joi.number().min(0).allow(null),
  notes: Joi.string().max(500).allow("", null),
});

const createTripSheetSchema = Joi.object({
  service_type: Joi.string()
    .valid(...SERVICE_TYPES)
    .required(),
  billing_mode: Joi.string()
    .valid(...BILLING_MODES)
    .required(),

  customer_id: Joi.string().guid({ version: "uuidv4" }).required(),
  // Required in fleet mode, absent in manual mode — enforced by the
  // cross-field .custom() below, not .required() here (Joi field-level
  // .required() can't express "required unless these OTHER fields are
  // present instead").
  vehicle_id: Joi.string().guid({ version: "uuidv4" }),
  driver_id: Joi.string().guid({ version: "uuidv4" }).allow(null),

  // ─── Manual mode (sub-contracted/partner vehicles) ───
  // Deliberately looser than vehicles.vehicle_number's own
  // isValidCanonical() Indian-plate-format check (utils/vehicleNumber.js)
  // — a partner operator's vehicle may not follow that format at all,
  // and this task's own spec asks for exactly "uppercase, 3-20 chars",
  // nothing stricter.
  manual_vehicle_number: Joi.string().trim().uppercase().min(3).max(20),
  manual_vehicle_type: Joi.string().valid(...VEHICLE_TYPES),

  // Manual per-trip rate fields, one group per formula — see
  // MANUAL_RATE_FIELDS_BY_FORMULA for which are required for a given
  // service_type/billing_mode. Rupee inputs stay rupees here and
  // convert to paise in tripSheet.service.js (rupeesToPaise), matching
  // every other _rupees field already on this schema (toll_rupees,
  // parking_rupees, etc.) — NOT converted at this validator boundary,
  // despite this task's own instruction to do so, for consistency with
  // this file's one real established convention (see PART A/Rule 10
  // note in the task debrief).
  base_price_rupees: Joi.number().positive().max(1_000_000),
  base_hours: Joi.number().integer().min(0).max(10000),
  base_km: Joi.number().integer().min(0).max(10000),
  extra_km_rate_rupees: Joi.number().positive().max(1_000_000),
  extra_hr_rate_rupees: Joi.number().positive().max(1_000_000),
  slab_rate_rupees: Joi.number().positive().max(1_000_000),
  min_km_per_day: Joi.number().integer().min(0).max(10000),
  driver_batta_per_day_rupees: Joi.number().positive().max(1_000_000),
  per_km_rate_rupees: Joi.number().positive().max(1_000_000),
  performance_batta_rupees: Joi.number().positive().max(1_000_000),

  trip_date: tripDateField.required(),
  // TIMESTAMPTZ columns, not plain DATE — no local-midnight shift risk,
  // Joi.date().iso() is safe here.
  start_datetime: Joi.date().iso(),
  end_datetime: Joi.date().iso(),

  opening_km: Joi.number().integer().min(0),
  closing_km: Joi.number().integer().min(0),
  total_km: Joi.number().integer().min(0).required(),
  total_hours: Joi.number().integer().min(0).required(),
  total_days: Joi.number().integer().min(1).max(90).default(1),

  // Task 3.1: outstation-only fields allowed on local trips too.
  // Business may reject via UI. If this becomes a source of errors,
  // tighten here.
  toll_rupees: Joi.number().min(0).default(0),
  parking_rupees: Joi.number().min(0).default(0),
  permit_rupees: Joi.number().min(0).default(0),
  fasttag_rupees: Joi.number().min(0).default(0),
  advance_rupees: Joi.number().min(0).default(0),

  // Itemized toll-plaza receipts (Task 3.2, OUTSTATION trips). Capped
  // at 50 here in Joi, not the service, per the task's explicit
  // constraint — a realistic outstation trip has well under 20. The
  // trip row's toll_paise is DERIVED by summing this array when it's
  // non-empty; the wire contract must not accept both this AND a
  // nonzero toll_rupees on the same request (enforced in the service —
  // see the top-of-file comment on tollReceiptSchema).
  tolls: Joi.array().items(tollReceiptSchema).max(50).default([]),

  booked_by: Joi.string().max(255),
  pax_note: Joi.string().max(255),
  remarks: Joi.string().max(2000),
})
  // Fleet vs. manual mode discriminator, plus per-formula required rate
  // fields for manual mode. Cross-field (needs to compare vehicle_id
  // against manual_vehicle_number/type, and rate fields against the
  // service_type+billing_mode combo), so it lives in a schema-level
  // .custom() rather than any single field's own rule — same reasoning
  // as this file's existing date-range/toll-conflict .custom() checks.
  .custom((value, helpers) => {
    const hasVehicleId = value.vehicle_id !== undefined;
    const hasManual = value.manual_vehicle_number !== undefined || value.manual_vehicle_type !== undefined;

    if (hasVehicleId && hasManual) {
      return helpers.error("manual.conflict");
    }
    if (!hasVehicleId && !hasManual) {
      return helpers.error("manual.missing");
    }

    if (hasManual) {
      if (value.manual_vehicle_number === undefined || value.manual_vehicle_type === undefined) {
        return helpers.error("manual.incomplete");
      }

      const formula = ruleTypeFor(value.service_type, value.billing_mode);
      const requiredFields = MANUAL_RATE_FIELDS_BY_FORMULA[formula];
      const missing = requiredFields.filter((f) => value[f] === undefined);
      if (missing.length > 0) {
        return helpers.error("manual.rateFieldsMissing", { formula, missing: missing.join(", ") });
      }
    }

    return value;
  })
  .messages({
    "manual.conflict": "Provide either vehicle_id (fleet) OR manual_vehicle_number/manual_vehicle_type (manual) — not both.",
    "manual.missing": "Provide either vehicle_id (fleet) OR manual_vehicle_number + manual_vehicle_type (manual).",
    "manual.incomplete": "Manual mode requires both manual_vehicle_number and manual_vehicle_type.",
    "manual.rateFieldsMissing": "Manual mode for this service_type/billing_mode ({{#formula}}) requires: {{#missing}}.",
  });

// All fields optional, editable-in-DRAFT versions of createTripSheetSchema's
// data fields. Deliberately does NOT include service_type, billing_mode,
// customer_id, vehicle_id, or anything identity/audit-shaped — those
// define the trip and are immutable even in DRAFT (see
// tripSheet.repository.js#DRAFT_UPDATABLE_COLUMNS, the enforcement
// layer this schema's omissions mirror).
//
// `.unknown(false)` is explicit here, not left to Joi.object()'s
// default: the shared validate() middleware (src/middleware/validate.js)
// always passes `stripUnknown: true`, which — confirmed empirically
// while building this schema — SILENTLY STRIPS an unrecognized key
// instead of erroring unless the schema itself calls `.unknown(false)`.
// Without this explicit call, a PATCH body like
// `{ total_km: 5, customer_id: "..." }` would have `customer_id`
// quietly dropped rather than rejected — exactly the kind of "looks
// like it worked, actually did something else" bug Rule 6 (fail early)
// exists to prevent.
const updateTripSheetSchema = Joi.object({
  trip_date: tripDateField,
  start_datetime: Joi.date().iso(),
  end_datetime: Joi.date().iso(),

  opening_km: Joi.number().integer().min(0),
  closing_km: Joi.number().integer().min(0),
  total_km: Joi.number().integer().min(0),
  total_hours: Joi.number().integer().min(0),
  total_days: Joi.number().integer().min(1).max(90),

  toll_rupees: Joi.number().min(0),
  parking_rupees: Joi.number().min(0),
  permit_rupees: Joi.number().min(0),
  fasttag_rupees: Joi.number().min(0),
  advance_rupees: Joi.number().min(0),

  // Same tolls-vs-toll_rupees mutex constraint as createTripSheetSchema
  // is enforced in the service (tripSheet.service.js), not here — see
  // that schema's tollReceiptSchema comment for why.
  tolls: Joi.array().items(tollReceiptSchema).max(50),

  booked_by: Joi.string().max(255),
  pax_note: Joi.string().max(255),
  remarks: Joi.string().max(2000),

  driver_id: Joi.string().guid({ version: "uuidv4" }).allow(null),
})
  .unknown(false)
  .min(1)
  .messages({
    "object.min": "Provide at least one field to update.",
  });

// Cancellation reason is required — legally necessary in many audit
// contexts, and there's no cancel-without-explanation path in this
// system.
const cancelTripSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(500).required(),
}).unknown(false);

const tripIdParamSchema = Joi.object({
  tripId: Joi.string().guid({ version: "uuidv4" }).required(),
});

const STATUS_VALUES = ["DRAFT", "FINALIZED", "INVOICED", "CANCELLED"];
const SORT_BY_VALUES = ["trip_date", "created_at", "total_km", "net_payable_paise"];

// Rule 6: fail early at Joi with clear codes so the service and repo see
// only known-good, sanitized inputs. The sort whitelist is a security
// boundary, not a UX nicety — sortBy is used to build an ORDER BY clause
// via string interpolation in the repo (Postgres has no way to
// parameterize a column/identifier name), so anything that reaches the
// repo MUST already be constrained to a fixed, hardcoded set of column
// names. Both this schema's `.valid(...)` AND the repo's own hardcoded
// SORT_WHITELIST enforce that constraint independently (defense in
// depth) — see tripSheet.repository.js#list.
const listTripsQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(25),
  offset: Joi.number().integer().min(0).default(0),

  customer_id: Joi.string().guid({ version: "uuidv4" }),
  vehicle_id: Joi.string().guid({ version: "uuidv4" }),
  driver_id: Joi.string().guid({ version: "uuidv4" }),

  from_date: Joi.string().custom((val, helpers) => {
    if (!isValidCalendarDate(val)) return helpers.error("date.invalidCalendarDate");
    return val;
  }),
  to_date: Joi.string().custom((val, helpers) => {
    if (!isValidCalendarDate(val)) return helpers.error("date.invalidCalendarDate");
    return val;
  }),

  // Comma-separated list of trip_status_enum values, e.g. "DRAFT,FINALIZED".
  // Parsed and validated here (not left as an opaque string) so an
  // unknown status token is rejected with a clear 400 instead of
  // silently matching zero rows at the repo layer.
  status: Joi.string().custom((val, helpers) => {
    const tokens = val
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (tokens.length === 0) {
      return helpers.error("status.empty");
    }
    for (const token of tokens) {
      if (!STATUS_VALUES.includes(token)) {
        return helpers.error("status.invalid", { token });
      }
    }
    return tokens.join(",");
  }),

  service_type: Joi.string().valid(...SERVICE_TYPES),
  billing_mode: Joi.string().valid(...BILLING_MODES),

  search: Joi.string().trim().min(1).max(50),

  sort_by: Joi.string()
    .valid(...SORT_BY_VALUES)
    .default("trip_date"),
  sort_dir: Joi.string().valid("asc", "desc").default("desc"),

  includeCancelled: Joi.boolean().default(false),
})
  .custom((value, helpers) => {
    if (value.from_date && value.to_date && value.from_date > value.to_date) {
      return helpers.error("date.rangeInverted");
    }
    return value;
  })
  .messages({
    "date.invalidCalendarDate": "must be a valid date in YYYY-MM-DD format",
    "date.rangeInverted": "from_date must be on or before to_date",
    "status.empty": "status must contain at least one value",
    "status.invalid": `status values must be one of ${STATUS_VALUES.join(", ")}`,
  });

const PERF_SORT_BY_VALUES = ["trip_date", "total_km", "net_payable_paise"];

// Performance sheet is billing_mode='PERFORMANCE' trips only. This
// filter is implicit and cannot be overridden — it's the definition of
// a performance sheet. Callers who want GST trips use the general
// /trips list (Task 3.4). That's why there's no billing_mode field on
// this schema at all: unlike listTripsQuerySchema, there's nothing to
// choose here.
const performanceSheetQuerySchema = Joi.object({
  customer_id: Joi.string().guid({ version: "uuidv4" }),
  vehicle_id: Joi.string().guid({ version: "uuidv4" }),
  driver_id: Joi.string().guid({ version: "uuidv4" }),

  from_date: Joi.string().custom((val, helpers) => {
    if (!isValidCalendarDate(val)) return helpers.error("date.invalidCalendarDate");
    return val;
  }),
  to_date: Joi.string().custom((val, helpers) => {
    if (!isValidCalendarDate(val)) return helpers.error("date.invalidCalendarDate");
    return val;
  }),

  service_type: Joi.string().valid(...SERVICE_TYPES),

  // No Joi-level .default() here, deliberately — the effective default
  // ("DRAFT,FINALIZED,INVOICED", i.e. everything but CANCELLED) is
  // achieved the same way Task 3.4's listTripsQuerySchema achieves it:
  // via includeCancelled below, not by hardcoding a status list that
  // would then permanently win over includeCancelled=true (an explicit
  // statusIn always overrides includeCancelled at the repo layer — see
  // listPerformanceRows). Baking a default status string in here would
  // make includeCancelled=true silently do nothing.
  status: Joi.string().custom((val, helpers) => {
    const tokens = val
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (tokens.length === 0) {
      return helpers.error("status.empty");
    }
    for (const token of tokens) {
      if (!STATUS_VALUES.includes(token)) {
        return helpers.error("status.invalid", { token });
      }
    }
    return tokens.join(",");
  }),

  includeCancelled: Joi.boolean().default(false),

  // Subset of Task 3.4's list sort keys — customer and created_at are
  // excluded (a performance sheet is date-sequenced, not a general
  // ledger view). Chronological ascending is the default: a cost sheet
  // reads more naturally oldest-to-newest than a general list does.
  sort_by: Joi.string()
    .valid(...PERF_SORT_BY_VALUES)
    .default("trip_date"),
  sort_dir: Joi.string().valid("asc", "desc").default("asc"),
})
  .custom((value, helpers) => {
    if (value.from_date && value.to_date && value.from_date > value.to_date) {
      return helpers.error("date.rangeInverted");
    }
    return value;
  })
  .messages({
    "date.invalidCalendarDate": "must be a valid date in YYYY-MM-DD format",
    "date.rangeInverted": "from_date must be on or before to_date",
    "status.empty": "status must contain at least one value",
    "status.invalid": `status values must be one of ${STATUS_VALUES.join(", ")}`,
  });

// Same shape as the JSON query — the CSV endpoint's hard row cap
// (10000) is enforced in the service (performanceSheet.service.js),
// not here, since it's a runtime data-volume guard, not a shape
// concern of the request itself.
const performanceSheetCsvQuerySchema = performanceSheetQuerySchema;

module.exports = {
  SERVICE_TYPES,
  BILLING_MODES,
  createTripSheetSchema,
  updateTripSheetSchema,
  cancelTripSchema,
  tripIdParamSchema,
  listTripsQuerySchema,
  performanceSheetQuerySchema,
  performanceSheetCsvQuerySchema,
};
