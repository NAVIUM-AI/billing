/**
 * Credit note routes, scoped to the current tenant. Read-only from the
 * API's perspective — credit notes are created internally by
 * invoice.service.js#cancelInvoice, never via a dedicated POST route
 * here (Task 4.3).
 */

const express = require("express");

const authenticate = require("../../middleware/authenticate");
const tenantContext = require("../../middleware/tenantContext");
const requirePermission = require("../../middleware/requirePermission");
const validate = require("../../middleware/validate");
const { creditNoteIdParamSchema, listCreditNotesQuerySchema } = require("../../validators/creditNote.validator");
const invoiceService = require("../../services/invoice.service");

const router = express.Router();

router.use(authenticate, tenantContext);

router.get(
  "/",
  requirePermission("invoices:read"),
  validate(listCreditNotesQuerySchema, "query"),
  async (req, res) => {
    const result = await invoiceService.listCreditNotes(req.tenantId, req.query, req.db);
    res.json(result);
  },
);

router.get(
  "/:creditNoteId",
  requirePermission("invoices:read"),
  validate(creditNoteIdParamSchema, "params"),
  async (req, res) => {
    const result = await invoiceService.getCreditNote(req.tenantId, req.params.creditNoteId, req.db);
    res.json(result);
  },
);

module.exports = router;
