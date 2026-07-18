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

const SERVICE_TYPES = ["LOCAL", "OUTSTATION"];
const BILLING_MODES = ["GST", "PERFORMANCE"];

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
  vehicle_id: Joi.string().guid({ version: "uuidv4" }).required(),
  driver_id: Joi.string().guid({ version: "uuidv4" }).allow(null),

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
});

const tripIdParamSchema = Joi.object({
  tripId: Joi.string().guid({ version: "uuidv4" }).required(),
});

module.exports = {
  SERVICE_TYPES,
  BILLING_MODES,
  createTripSheetSchema,
  tripIdParamSchema,
};
