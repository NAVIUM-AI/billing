/**
 * Joi schemas for payments (Task 4.4): recording a payment against an
 * invoice or as a standalone customer advance, applying an advance to
 * an invoice, cancelling a payment, and listing payments. Shape-only —
 * cross-field rules that need DB state (invoice/advance lookups,
 * outstanding-amount math) live in payment.service.js per the Rule 2
 * service order, same convention as every other validator file.
 */

const Joi = require("joi");

const PAYMENT_MODES = ["CASH", "UPI", "NEFT", "RTGS", "IMPS", "CHEQUE", "CARD", "BANK_TRANSFER"];
const PAYMENT_STATUS_VALUES = ["RECORDED", "CANCELLED"];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Real-calendar-date check via explicit UTC accessors — mirrors
 * invoice.validator.js#isValidCalendarDate.
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
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

const calendarDateField = Joi.string().custom((val, helpers) => {
  if (!isValidCalendarDate(val)) return helpers.error("date.invalidCalendarDate");
  return val;
});

// Evaluated at VALIDATION time (per-request), not schema-build time —
// same "today must be a function, not a constant" discipline as every
// other date guardrail in this codebase (tripSheet.validator.js's
// tripDateField is the precedent). received_at is a TIMESTAMPTZ, so
// Joi.date().iso() (not the plain-string calendarDateField above) is
// the right primitive — no local-midnight/UTC-midnight shift risk for
// a genuine point-in-time value.
const receivedAtField = Joi.date()
  .iso()
  .custom((val, helpers) => {
    const now = new Date();
    if (val.getTime() > now.getTime()) {
      return helpers.error("date.paymentFuture");
    }
    if (val.getTime() < now.getTime() - 90 * MS_PER_DAY) {
      return helpers.error("date.paymentTooOld");
    }
    return val;
  });

// Shared by POST /invoices/:id/payments and POST /customers/:id/advances.
const recordPaymentSchema = Joi.object({
  amount_rupees: Joi.number().positive().max(10_000_000).required(),
  payment_mode: Joi.string()
    .valid(...PAYMENT_MODES)
    .required(),

  // CASH payments never carry a reference (nothing to reconcile
  // against); every other mode requires one (the DB's own
  // payments_reference_required CHECK is the backstop — this is the
  // fail-early copy per Rule 6).
  reference_number: Joi.string()
    .trim()
    .min(1)
    .max(100)
    .when("payment_mode", {
      is: "CASH",
      then: Joi.forbidden(),
      otherwise: Joi.required(),
    }),

  received_at: receivedAtField,

  notes: Joi.string().trim().max(500).allow("", null),
})
  .unknown(false)
  .messages({
    "date.paymentFuture": "received_at cannot be in the future",
    "date.paymentTooOld": "received_at cannot be more than 90 days in the past",
    "any.unknown": "reference_number is not allowed for CASH payments",
  });

const applyAdvanceSchema = Joi.object({
  advance_payment_id: Joi.string().guid({ version: "uuidv4" }).required(),
  // Optional — when omitted, the service applies
  // min(advance amount, invoice outstanding).
  amount_rupees: Joi.number().positive().max(10_000_000),
}).unknown(false);

const cancelPaymentSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(500).required(),
}).unknown(false);

const listPaymentsQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(25),
  offset: Joi.number().integer().min(0).default(0),

  customer_id: Joi.string().guid({ version: "uuidv4" }),
  invoice_id: Joi.string().guid({ version: "uuidv4" }),
  payment_mode: Joi.string().valid(...PAYMENT_MODES),

  // Comma-separated list of payment_status_enum values — same pattern
  // as tripSheet.validator.js's listTripsQuerySchema#status. Default
  // (RECORDED-only) is applied in the service, not here, so an
  // explicit status= always wins cleanly.
  status: Joi.string().custom((val, helpers) => {
    const tokens = val
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (tokens.length === 0) {
      return helpers.error("status.empty");
    }
    for (const token of tokens) {
      if (!PAYMENT_STATUS_VALUES.includes(token)) {
        return helpers.error("status.invalid", { token });
      }
    }
    return tokens.join(",");
  }),

  from_date: calendarDateField,
  to_date: calendarDateField,
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
    "status.invalid": `status values must be one of ${PAYMENT_STATUS_VALUES.join(", ")}`,
  });

const paymentIdParamSchema = Joi.object({
  paymentId: Joi.string().guid({ version: "uuidv4" }).required(),
});

// Task 4.4: GET /reports/receivables-aging. Lives here (not a
// dedicated reports.validator.js) since it's a single small schema,
// same "co-locate with the closest sibling" reasoning as
// invoice.validator.js#invoiceableTripsQuerySchema.
const agingReportQuerySchema = Joi.object({
  as_of_date: calendarDateField,
}).messages({
  "date.invalidCalendarDate": "must be a valid date in YYYY-MM-DD format",
});

module.exports = {
  PAYMENT_MODES,
  PAYMENT_STATUS_VALUES,
  recordPaymentSchema,
  applyAdvanceSchema,
  cancelPaymentSchema,
  listPaymentsQuerySchema,
  paymentIdParamSchema,
  agingReportQuerySchema,
};
