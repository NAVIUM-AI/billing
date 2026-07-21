/**
 * Reporting routes, scoped to the current tenant (Task 4.4). Read-only,
 * financial-reporting-flavored — gated on reports:read rather than
 * payments:read/invoices:read, a narrower set than either.
 */

const express = require("express");

const authenticate = require("../../middleware/authenticate");
const tenantContext = require("../../middleware/tenantContext");
const requirePermission = require("../../middleware/requirePermission");
const validate = require("../../middleware/validate");
const { agingReportQuerySchema } = require("../../validators/payment.validator");
const paymentService = require("../../services/payment.service");

const router = express.Router();

router.use(authenticate, tenantContext);

router.get(
  "/receivables-aging",
  requirePermission("reports:read"),
  validate(agingReportQuerySchema, "query"),
  async (req, res) => {
    const result = await paymentService.getReceivablesAging(req.tenantId, req.query, req.db);
    res.json(result);
  },
);

module.exports = router;
