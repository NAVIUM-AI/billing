/**
 * Trip sheet routes, scoped to the current tenant. Thin by design —
 * validation lives in tripSheet.validator.js, business logic
 * (normalize/derive/validate/check/write, pricing dispatch, snapshotting,
 * FY-based numbering) in tripSheet.service.js.
 *
 * Task 3.1 ships create + get only. List (3.4) and lifecycle
 * transitions — finalize/cancel/invoice-linkage (3.3) — are deliberately
 * out of scope here.
 */

const express = require("express");

const authenticate = require("../../middleware/authenticate");
const tenantContext = require("../../middleware/tenantContext");
const requirePermission = require("../../middleware/requirePermission");
const validate = require("../../middleware/validate");
const { createTripSheetSchema, tripIdParamSchema } = require("../../validators/tripSheet.validator");
const tripSheetService = require("../../services/tripSheet.service");

const router = express.Router();

router.use(authenticate, tenantContext);

router.post(
  "/",
  requirePermission("trips:write"),
  validate(createTripSheetSchema),
  async (req, res) => {
    const trip = await tripSheetService.createTripSheet(
      req.tenantId,
      req.body,
      req.user.userId,
      req.db,
    );
    res.status(201).json({ trip });
  },
);

router.get(
  "/:tripId",
  requirePermission("trips:read"),
  validate(tripIdParamSchema, "params"),
  async (req, res) => {
    const trip = await tripSheetService.getTripSheet(req.tenantId, req.params.tripId, req.db);
    res.json({ trip });
  },
);

module.exports = router;
