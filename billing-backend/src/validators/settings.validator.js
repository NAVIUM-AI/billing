/**
 * Joi schema for PATCH /settings/business. Kept separate from the route
 * file so validation rules are easy to find and reuse.
 */

const Joi = require("joi");

const bankDetailsSchema = Joi.object({
  account_name: Joi.string().max(255),
  account_number: Joi.string().max(30),
  ifsc: Joi.string().max(11),
  bank_name: Joi.string().max(255),
  branch: Joi.string().max(255),
  upi_id: Joi.string().max(100),
  // Task 4.8: the bank-account HOLDER's PAN (distinct from the
  // tenant's own PAN already validated below) — client reference PDFs
  // show both on the same document. Same format as the tenant pan
  // field; there's no separate `bank_accounts` table/row to hang a DB
  // CHECK constraint off of (see the Task 4.8 migration's own
  // comment), so this is the only validation layer for it.
  pan: Joi.string()
    .length(10)
    .pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/),
  // .unknown(false) (the object default) rejects any key not listed
  // above — bank_details is a structured field, not free-form JSON.
}).unknown(false);

const updateSettingsSchema = Joi.object({
  name: Joi.string().min(2).max(255),

  // GSTIN/PAN accept `null` explicitly so a tenant can clear a
  // previously-set value, distinct from omitting the field entirely
  // (which leaves the existing value untouched).
  gstin: Joi.string()
    .length(15)
    .pattern(/^[0-9A-Z]{15}$/)
    .allow(null),

  pan: Joi.string()
    .length(10)
    .pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/)
    .allow(null),

  state_code: Joi.string().length(2).uppercase(),

  logo_url: Joi.string().uri().max(1000).allow(null),

  // Task 4.8: client reference PDFs (PTT-150/151) show a tagline and a
  // phone line in the sender header, and a jurisdiction sentence
  // ("Subject to Bangalore jurisdiction") in the footer — see
  // known-issues.md's "Deferred" section from Task 4.7. All three
  // accept `null` to clear, same convention as gstin/pan above.
  tagline: Joi.string().max(200).allow(null),

  phone: Joi.string().max(20).allow(null),

  jurisdiction: Joi.string().max(100).allow(null),

  invoice_prefix: Joi.string()
    .min(2)
    .max(20)
    .pattern(/^[A-Za-z0-9-]+$/),

  trip_sheet_prefix: Joi.string()
    .min(2)
    .max(20)
    .uppercase()
    .pattern(/^[A-Za-z0-9-]+$/),

  bank_details: bankDetailsSchema,

  // Free-form JSONB — allow any keys, but cap the top-level key count
  // so one tenant can't stuff an unbounded blob into a row we'll read
  // back on every settings request.
  settings: Joi.object().unknown(true).max(50),
})
  .min(1)
  .messages({
    "object.min": "Provide at least one field to update.",
  });

module.exports = { updateSettingsSchema };
