/**
 * Invoice routes, scoped to the current tenant. Thin by design —
 * validation lives in invoice.validator.js, business logic in
 * invoice.service.js. Task 4.1 ships DRAFT creation + full CRUD on
 * drafts; Task 4.2 adds per-line description editing; Task 4.3 adds
 * the issue/cancel lifecycle transitions.
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
  invoiceLineParamSchema,
  updateLineSchema,
  issueInvoiceSchema,
  cancelInvoiceSchema,
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

router.post(
  "/:invoiceId/issue",
  requirePermission("invoices:issue"),
  validate(invoiceIdParamSchema, "params"),
  validate(issueInvoiceSchema, "body"),
  async (req, res) => {
    const invoice = await invoiceService.issueInvoice(req.tenantId, req.params.invoiceId, req.user.userId, req.db);
    res.json({ invoice });
  },
);

router.post(
  "/:invoiceId/cancel",
  requirePermission("invoices:cancel"),
  validate(invoiceIdParamSchema, "params"),
  validate(cancelInvoiceSchema, "body"),
  async (req, res) => {
    const result = await invoiceService.cancelInvoice(
      req.tenantId,
      req.params.invoiceId,
      req.body,
      req.user.userId,
      req.db,
    );
    res.json(result);
  },
);

router.patch(
  "/:invoiceId/lines/:lineId",
  requirePermission("invoices:draft"),
  validate(invoiceLineParamSchema, "params"),
  validate(updateLineSchema, "body"),
  async (req, res) => {
    const result = await invoiceService.updateInvoiceLine(
      req.tenantId,
      req.params.invoiceId,
      req.params.lineId,
      req.body,
      req.user.userId,
      req.db,
    );
    res.json(result);
  },
);

module.exports = router;
