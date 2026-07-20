/**
 * Payment routes, scoped to the current tenant (Task 4.4). Thin by
 * design — validation lives in payment.validator.js, business logic in
 * payment.service.js. Recording a payment happens via the invoice
 * (POST /invoices/:id/payments) or customer (POST /customers/:id/advances)
 * routes, not here — these routes are for listing, reading, and
 * cancelling payments that already exist.
 */

const express = require("express");

const authenticate = require("../../middleware/authenticate");
const tenantContext = require("../../middleware/tenantContext");
const requirePermission = require("../../middleware/requirePermission");
const validate = require("../../middleware/validate");
const {
  listPaymentsQuerySchema,
  paymentIdParamSchema,
  cancelPaymentSchema,
} = require("../../validators/payment.validator");
const paymentService = require("../../services/payment.service");

const router = express.Router();

router.use(authenticate, tenantContext);

router.get(
  "/",
  requirePermission("payments:read"),
  validate(listPaymentsQuerySchema, "query"),
  async (req, res) => {
    const result = await paymentService.listPayments(req.tenantId, req.query, req.db);
    res.json(result);
  },
);

router.get(
  "/:paymentId",
  requirePermission("payments:read"),
  validate(paymentIdParamSchema, "params"),
  async (req, res) => {
    const result = await paymentService.getPayment(req.tenantId, req.params.paymentId, req.db);
    res.json(result);
  },
);

router.post(
  "/:paymentId/cancel",
  requirePermission("payments:cancel"),
  validate(paymentIdParamSchema, "params"),
  validate(cancelPaymentSchema, "body"),
  async (req, res) => {
    const result = await paymentService.cancelPayment(
      req.tenantId,
      req.params.paymentId,
      req.body,
      req.user.userId,
      req.db,
    );
    res.json(result);
  },
);

module.exports = router;
