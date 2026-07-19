/**
 * Invoice routes, scoped to the current tenant. Thin by design —
 * validation lives in invoice.validator.js, business logic in
 * invoice.service.js. Task 4.1 ships DRAFT creation + full CRUD on
 * drafts only; there is deliberately no issue/cancel route yet — those
 * are Task 4.3, once invoice numbering and immutability snapshots
 * exist.
 */

const express = require("express");

const authenticate = require("../../middleware/authenticate");
const tenantContext = require("../../middleware/tenantContext");
const requirePermission = require("../../middleware/requirePermission");
const validate = require("../../middleware/validate");
const {
  createInvoiceSchema,
  updateInvoiceSchema,
  invoiceIdParamSchema,
} = require("../../validators/invoice.validator");
const invoiceService = require("../../services/invoice.service");

const router = express.Router();

router.use(authenticate, tenantContext);

router.post(
  "/",
  requirePermission("invoices:draft"),
  validate(createInvoiceSchema),
  async (req, res) => {
    const invoice = await invoiceService.createDraftInvoice(req.tenantId, req.body, req.user.userId, req.db);
    res.status(201).json({ invoice });
  },
);

router.get(
  "/:invoiceId",
  requirePermission("invoices:read"),
  validate(invoiceIdParamSchema, "params"),
  async (req, res) => {
    const invoice = await invoiceService.getInvoice(req.tenantId, req.params.invoiceId, req.db);
    res.json({ invoice });
  },
);

router.patch(
  "/:invoiceId",
  requirePermission("invoices:draft"),
  validate(invoiceIdParamSchema, "params"),
  validate(updateInvoiceSchema, "body"),
  async (req, res) => {
    const invoice = await invoiceService.updateDraftInvoice(
      req.tenantId,
      req.params.invoiceId,
      req.body,
      req.user.userId,
      req.db,
    );
    res.json({ invoice });
  },
);

router.delete(
  "/:invoiceId",
  requirePermission("invoices:draft"),
  validate(invoiceIdParamSchema, "params"),
  async (req, res) => {
    const result = await invoiceService.deleteDraftInvoice(req.tenantId, req.params.invoiceId, req.user.userId, req.db);
    res.json(result);
  },
);

module.exports = router;
