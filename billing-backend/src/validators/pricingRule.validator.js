/**
 * Joi schemas for the pricing-rules routes. Kept separate from the
 * route file so validation rules are easy to find and reuse.
 *
 * Dates are validated with a hand-rolled `isoDateField` (below) instead
 * of Joi.date() or even Joi.string().isoDate(). Joi.date() converts to
 * a JS Date object; Joi.string().isoDate() looks like it stays a
 * string but actually normalizes THROUGH a Date internally and
 * reformats to a full UTC datetime ('2026-01-01' becomes
 * '2026-01-01T00:00:00.000Z') — confirmed empirically while building
 * this validator. Task 2.2 already found a real timezone bug where
 * node-postgres round-trips a DATE column through a JS Date at local
 * midnight, shifting the calendar date by the server's UTC offset on
 * the way OUT of the DB; a midnight-UTC datetime string cast to
 * `::date` risks the same shift on the way IN, in any server timezone
 * behind UTC (the ...Z instant lands on the previous local day, and a
 * DATE cast interprets it in session-local terms). `isoDateField`
 * keeps the value byte-for-byte what the client sent (after regex +
 * real-calendar-date validation) — no Date object, no reformatting, no
 * timezone involved anywhere in the pipeline.
 *
 * Type-specific rate fields are all optional at the schema layer —
 * which fields are required depends on rule_type, and that's a
 * cross-field concern handled in pricingRule.service.js (mirrors the
 * customers Task 2.3 pattern: shape here, business rules in the
 * service).
 */

const Joi = require("joi");

const { VEHICLE_TYPES } = require("./vehicle.validator");

const RULE_TYPES = ["LOCAL_PACKAGE", "OUTSTATION_SLAB", "PERFORMANCE"];

/**
 * Real-calendar-date check using explicit UTC accessors throughout
 * (Date.UTC / getUTC*), so there is no local-timezone reinterpretation
 * anywhere in the check — this only rejects nonsense like
 * '2026-02-30', it never shifts a valid date.
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

// A plain 'YYYY-MM-DD' string field — see the top-of-file comment for
// why this exists instead of Joi.date()/.isoDate().
const isoDateField = Joi.string()
  .custom((val, helpers) => {
    if (!isValidCalendarDate(val)) {
      return helpers.error("date.invalidCalendarDate");
    }
    return val;
  })
  .messages({
    "date.invalidCalendarDate": "must be a valid date in YYYY-MM-DD format",
  });

// Shared by create + supersede: every rate/count field a rule can
// carry, plus label/notes. rule_type, vehicle_type, and the
// effective_from constraints differ between the two, so those stay
// outside this shared object.
const rateAndLabelFields = {
  label: Joi.string().min(2).max(255).required(),
  notes: Joi.string().max(2000),

  // Integer counts — not money, no rupee/paise conversion.
  base_hours: Joi.number().integer().min(0).max(10000),
  base_km: Joi.number().integer().min(0).max(10000),
  min_km_per_day: Joi.number().integer().min(0).max(10000),

  // Rupee inputs (decimal, UX-friendly) — customer.service.js-style
  // normalize-in-service converts these to *_paise before they reach
  // the repository. See pricingRule.service.js Step 1.
  base_price_rupees: Joi.number().positive().max(1_000_000),
  extra_km_rate_rupees: Joi.number().positive().max(1_000_000),
  extra_hr_rate_rupees: Joi.number().positive().max(1_000_000),
  slab_rate_rupees: Joi.number().positive().max(1_000_000),
  driver_batta_per_day_rupees: Joi.number().positive().max(1_000_000),
  per_km_rate_rupees: Joi.number().positive().max(1_000_000),
  performance_batta_rupees: Joi.number().positive().max(1_000_000),
};

// Object-level check shared by create + supersede: effective_to, when
// present, must be strictly after effective_from. ISO 'YYYY-MM-DD'
// strings compare correctly with plain string operators since the
// format is fixed-width and zero-padded.
function checkEffectiveRange(value, helpers) {
  if (value.effective_to && value.effective_to <= value.effective_from) {
    return helpers.error("pricing.effectiveRangeInvalid");
  }
  return value;
}
const effectiveRangeMessages = {
  "pricing.effectiveRangeInvalid": "effective_to must be after effective_from.",
};

const createRuleSchema = Joi.object({
  rule_type: Joi.string()
    .valid(...RULE_TYPES)
    .required(),
  vehicle_type: Joi.string()
    .valid(...VEHICLE_TYPES)
    .required(),
  effective_from: isoDateField.required(),
  effective_to: isoDateField,
  ...rateAndLabelFields,
})
  .custom(checkEffectiveRange)
  .messages(effectiveRangeMessages);

// All fields optional EXCEPT label/notes/effective_to. Rate values and
// effective_from are IMMUTABLE — this is the audit guarantee. A rate
// correction goes through POST /rules/:id/supersede, never PATCH, so
// every historical calculation stays reproducible against the rule
// version that was actually in effect at the time. Each immutable
// field is explicitly `.forbidden()` (not just omitted) so a request
// that tries to change one gets a clear, field-specific validation
// error instead of the value being silently dropped.
const IMMUTABLE_FIELD_MESSAGE =
  "This field is immutable after creation. Use POST /rules/:id/supersede to change rates.";
const updateRuleSchema = Joi.object({
  label: Joi.string().min(2).max(255),
  notes: Joi.string().max(2000),
  effective_to: isoDateField,

  rule_type: Joi.any().forbidden(),
  vehicle_type: Joi.any().forbidden(),
  effective_from: Joi.any().forbidden(),
  base_hours: Joi.any().forbidden(),
  base_km: Joi.any().forbidden(),
  min_km_per_day: Joi.any().forbidden(),
  base_price_rupees: Joi.any().forbidden(),
  extra_km_rate_rupees: Joi.any().forbidden(),
  extra_hr_rate_rupees: Joi.any().forbidden(),
  slab_rate_rupees: Joi.any().forbidden(),
  driver_batta_per_day_rupees: Joi.any().forbidden(),
  per_km_rate_rupees: Joi.any().forbidden(),
  performance_batta_rupees: Joi.any().forbidden(),
})
  .min(1)
  .messages({
    "object.min": "Provide at least one field to update.",
    "any.unknown": IMMUTABLE_FIELD_MESSAGE,
  });

// rule_type + vehicle_type are inherited from the rule being
// superseded (the route reads them off the existing row), not taken
// from the request body — so they're absent here entirely, not just
// optional. effective_to is likewise absent: a supersede always
// creates a new OPEN-ENDED version (effective_to = NULL) — that's the
// entire point of supersede, "this is now the current version". A
// rule that should only be valid for a fixed window isn't a supersede
// target, it's just a rule created with both dates via POST /rules.
const supersedeSchema = Joi.object({
  // Deliberately NOT Joi.date().min('now') / a schema-build-time
  // default: "now" must be evaluated at VALIDATION time (each
  // request), not once when this module is first require()'d — a
  // long-running server would otherwise compare against the date it
  // booted on, not today.
  effective_from: isoDateField
    .required()
    .custom((val, helpers) => {
      const today = new Date().toISOString().slice(0, 10);
      if (val < today) {
        return helpers.error("pricing.effectiveFromPast");
      }
      return val;
    })
    .messages({
      "pricing.effectiveFromPast": "effective_from must be today or later.",
    }),
  ...rateAndLabelFields,
});

const listRulesQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0),
  rule_type: Joi.string().valid(...RULE_TYPES),
  vehicle_type: Joi.string().valid(...VEHICLE_TYPES),
  on_date: isoDateField,
  activeOnly: Joi.boolean().default(false),
});

const applicableRuleQuerySchema = Joi.object({
  rule_type: Joi.string()
    .valid(...RULE_TYPES)
    .required(),
  vehicle_type: Joi.string()
    .valid(...VEHICLE_TYPES)
    .required(),
  // Left undefined (not defaulted here) rather than defaulting to
  // "today" at schema-definition time — same staleness concern as
  // supersedeSchema.effective_from above. The service defaults this to
  // the current date at request time.
  on_date: isoDateField,
});

// Usage is validated loosely: which fields are required depends on
// rule_type, and the calculator itself (src/domain/pricing) already
// throws a clear TypeError on a missing field. Re-encoding that same
// per-type requirement here would just be a second copy to keep in
// sync.
const previewSchema = Joi.object({
  vehicle_type: Joi.string()
    .valid(...VEHICLE_TYPES)
    .required(),
  rule_type: Joi.string()
    .valid(...RULE_TYPES)
    .required(),
  on_date: isoDateField,
  usage: Joi.object().unknown(true).required(),
});

const ruleIdParamSchema = Joi.object({
  ruleId: Joi.string().guid({ version: "uuidv4" }).required(),
});

module.exports = {
  RULE_TYPES,
  createRuleSchema,
  updateRuleSchema,
  supersedeSchema,
  listRulesQuerySchema,
  applicableRuleQuerySchema,
  previewSchema,
  ruleIdParamSchema,
};
