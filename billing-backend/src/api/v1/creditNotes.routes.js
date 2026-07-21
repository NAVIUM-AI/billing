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
const pdfService = require("../../services/pdf.service");

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

router.post(
  "/:creditNoteId/pdf",
  requirePermission("invoices:read"),
  validate(creditNoteIdParamSchema, "params"),
  async (req, res) => {
    const result = await pdfService.generateCreditNotePdf(req.tenantId, req.params.creditNoteId, req.db);
    res.json(result);
  },
);

router.get(
  "/:creditNoteId/pdf",
  requirePermission("invoices:read"),
  validate(creditNoteIdParamSchema, "params"),
  async (req, res) => {
    const { buffer, filename } = await pdfService.getCreditNotePdfBuffer(req.tenantId, req.params.creditNoteId, req.db);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": buffer.length,
    });
    res.send(buffer);
  },
);

module.exports = router;
