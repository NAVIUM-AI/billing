/**
 * Joi schemas for /invoices (Task 4.1). Shape-only — cross-field rules
 * that need DB state (customer lookup, trip finalized/held checks,
 * customer-mismatch) live in invoice.service.js per the Rule 2 service
 * order (normalize -> derive -> validate -> check -> write), same
 * convention as tripSheet.validator.js.
 */

const Joi = require("joi");

const { SERVICE_TYPES } = require("./tripSheet.validator");

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

  // Task 4.9: optional for backward compatibility with any pre-F4a
  // caller — invoice.service.js derives it from the first selected
  // trip's own service_type when omitted (same "first line is
  // authoritative" reasoning pdf.service.js#pickInvoiceTemplateName
  // already uses). The frontend always sends this explicitly.
  service_type: Joi.string().valid(...SERVICE_TYPES),

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

  // Task 4.8: whether GST is payable by the recipient under the
  // reverse-charge mechanism rather than the tenant (forward charge).
  // Deliberately NOT derived/defaulted anywhere (see the Task 4.8
  // migration's comment and known-issues.md's "Reverse Charge" deferred
  // entry) — a wrong declaration on a real tax document is a
  // compliance risk, so this stays exactly what the caller sends:
  // true, false, or omitted/null (renders nothing on the PDF).
  reverse_charge: Joi.boolean().allow(null),
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
  // Task 4.9: immutable, same pattern pricingRule.validator.js's
  // updateRuleSchema uses for rule_type/vehicle_type — explicitly
  // `.forbidden()` (not just omitted) so a request that tries to
  // change it gets a clear field-specific error instead of the value
  // being silently dropped.
  service_type: Joi.any().forbidden(),

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

  reverse_charge: Joi.boolean().allow(null),
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

// Task 4.9: GET /invoices — the tenant-wide list F4a's list screen
// needs. Mirrors tripSheet.validator.js#listTripsQuerySchema's shape
// (limit/offset/status/search/date range) as closely as this schema's
// own fields allow — `status` here is a SINGLE value, not a
// comma-separated multi-value list like trips', since invoice.
// service.js's status filter is a plain equality match, not an ANY().
const STATUS_VALUES = ["DRAFT", "ISSUED", "PAID", "CANCELLED"];

const listInvoicesQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(200).default(50),
  offset: Joi.number().integer().min(0).default(0),

  status: Joi.string().valid(...STATUS_VALUES),
  invoice_type: Joi.string().valid(...INVOICE_TYPES),
  service_type: Joi.string().valid(...SERVICE_TYPES),
  customer_id: Joi.string().guid({ version: "uuidv4" }),

  date_from: Joi.string().custom((val, helpers) => {
    if (!isValidCalendarDate(val)) return helpers.error("date.invalidCalendarDate");
    return val;
  }),
  date_to: Joi.string().custom((val, helpers) => {
    if (!isValidCalendarDate(val)) return helpers.error("date.invalidCalendarDate");
    return val;
  }),

  // Substring match on invoice_number — see invoice.repository.js#list.
  search: Joi.string().trim().min(1).max(50),
})
  .custom((value, helpers) => {
    if (value.date_from && value.date_to && value.date_from > value.date_to) {
      return helpers.error("date.rangeInverted");
    }
    return value;
  })
  .messages({
    "date.invalidCalendarDate": "must be a valid date in YYYY-MM-DD format",
    "date.rangeInverted": "date_from must be on or before date_to",
  });

const invoiceIdParamSchema = Joi.object({
  invoiceId: Joi.string().guid({ version: "uuidv4" }).required(),
});

const invoiceLineParamSchema = Joi.object({
  invoiceId: Joi.string().guid({ version: "uuidv4" }).required(),
  lineId: Joi.string().guid({ version: "uuidv4" }).required(),
});

// Task 4.2: GET /customers/:id/invoiceable-trips. invoice_id is the
// edit-case escape hatch — when set, the picker also includes trips
// currently held by THAT invoice (so a trip already on the draft being
// edited still shows as selectable, not silently missing).
const invoiceableTripsQuerySchema = Joi.object({
  invoice_id: Joi.string().guid({ version: "uuidv4" }),
});

// Task 4.2: PATCH /invoices/:invoiceId/lines/:lineId. Only description
// is editable — see invoiceLine.repository.js#LINE_UPDATABLE_COLUMNS.
const updateLineSchema = Joi.object({
  description: Joi.string().trim().min(1).max(500).required(),
})
  .unknown(false)
  .min(1);

// Task 4.3: POST /invoices/:invoiceId/issue. No required fields — the
// body is optional/empty; `.unknown(false)` still rejects a stray key
// if one is sent, rather than silently stripping it (Rule 6).
const issueInvoiceSchema = Joi.object({}).unknown(false);

// Task 4.3: POST /invoices/:invoiceId/cancel. Reason is mandatory for
// BOTH the no-credit-note (DRAFT) and credit-note (ISSUED/PAID) paths —
// same "no cancel-without-explanation" convention as
// tripSheet.validator.js#cancelTripSchema.
const cancelInvoiceSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(500).required(),
}).unknown(false);

module.exports = {
  INVOICE_TYPES,
  createInvoiceSchema,
  updateInvoiceSchema,
  invoiceIdParamSchema,
  invoiceLineParamSchema,
  invoiceableTripsQuerySchema,
  updateLineSchema,
  issueInvoiceSchema,
  cancelInvoiceSchema,
  listInvoicesQuerySchema,
};
