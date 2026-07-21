/**
 * Joi schemas for /credit-notes (Task 4.3). Credit notes are read-only
 * from the API's perspective — they're created internally by
 * invoice.service.js#cancelInvoice, never via a dedicated POST route —
 * so this file only has param/query schemas, no create/update body.
 */

const Joi = require("joi");

const creditNoteIdParamSchema = Joi.object({
  creditNoteId: Joi.string().guid({ version: "uuidv4" }).required(),
});

const listCreditNotesQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(25),
  offset: Joi.number().integer().min(0).default(0),
});

module.exports = { creditNoteIdParamSchema, listCreditNotesQuerySchema };
