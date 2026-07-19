/**
 * Joi schemas for /invoices (Task 4.1). Shape-only — cross-field rules
 * that need DB state (customer lookup, trip finalized/held checks,
 * customer-mismatch) live in invoice.service.js per the Rule 2 service
 * order (normalize -> derive -> validate -> check -> write), same
 * convention as tripSheet.validator.js.
 */

const Joi = require("joi");

const INVOICE_TYPES = ["TAX", "PERFORMANCE"];

/**
 * Real-calendar-date check via explicit UTC accessors — mirrors
 * tripSheet.validator.js#isValidCalendarDate (avoids the local-midnight/
 * UTC-midnight DATE-column shift documented in Task 2.2).
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

const createInvoiceSchema = Joi.object({
  invoice_type: Joi.string()
    .valid(...INVOICE_TYPES)
    .required(),
  customer_id: Joi.string().guid({ version: "uuidv4" }).required(),
  trip_sheet_ids: Joi.array()
    .items(Joi.string().guid({ version: "uuidv4" }))
    .min(1)
    .max(50)
    .required(),

  // Defaulted to today and sanity-checked (not future, not >30 days
  // past) in the service — see invoice.service.js's Step 3, same
  // "needs a specific apiError code" reasoning as tripSheet.validator.js's
  // opening_km/closing_km comment.
  invoice_date: calendarDateField,
  due_date: calendarDateField,

  notes: Joi.string().max(2000).allow("", null),
  terms: Joi.string().max(2000).allow("", null),

  discount_rupees: Joi.number().min(0).max(1000000),
  discount_reason: Joi.string().max(255).allow("", null),

  toll_rupees: Joi.number().min(0),
  parking_rupees: Joi.number().min(0),
  permit_rupees: Joi.number().min(0),
  fasttag_rupees: Joi.number().min(0),
})
  .custom((value, helpers) => {
    if (value.invoice_date && value.due_date && value.due_date < value.invoice_date) {
      return helpers.error("date.dueBeforeInvoice");
    }
    return value;
  })
  .messages({
    "date.invalidCalendarDate": "must be a valid date in YYYY-MM-DD format",
    "date.dueBeforeInvoice": "due_date must be on or after invoice_date",
  });

// All fields optional, DRAFT-only edit. invoice_type/customer_id are
// immutable even in DRAFT (same "identity fields never patchable"
// convention as tripSheet.validator.js#updateTripSheetSchema).
// trip_sheet_ids, when present, is a FULL replacement of the trip set —
// not a merge — per the task spec.
const updateInvoiceSchema = Joi.object({
  trip_sheet_ids: Joi.array().items(Joi.string().guid({ version: "uuidv4" })).min(1).max(50),

  invoice_date: calendarDateField,
  due_date: calendarDateField,

  notes: Joi.string().max(2000).allow("", null),
  terms: Joi.string().max(2000).allow("", null),

  discount_rupees: Joi.number().min(0).max(1000000),
  discount_reason: Joi.string().max(255).allow("", null),

  toll_rupees: Joi.number().min(0),
  parking_rupees: Joi.number().min(0),
  permit_rupees: Joi.number().min(0),
  fasttag_rupees: Joi.number().min(0),
})
  .unknown(false)
  .min(1)
  .custom((value, helpers) => {
    if (value.invoice_date && value.due_date && value.due_date < value.invoice_date) {
      return helpers.error("date.dueBeforeInvoice");
    }
    return value;
  })
  .messages({
    "object.min": "Provide at least one field to update.",
    "date.invalidCalendarDate": "must be a valid date in YYYY-MM-DD format",
    "date.dueBeforeInvoice": "due_date must be on or after invoice_date",
  });

const invoiceIdParamSchema = Joi.object({
  invoiceId: Joi.string().guid({ version: "uuidv4" }).required(),
});

module.exports = {
  INVOICE_TYPES,
  createInvoiceSchema,
  updateInvoiceSchema,
  invoiceIdParamSchema,
};
