/**
 * Trip sheet routes, scoped to the current tenant. Thin by design —
 * validation lives in tripSheet.validator.js, business logic
 * (normalize/derive/validate/check/write, pricing dispatch, snapshotting,
 * FY-based numbering, lifecycle transitions) in tripSheet.service.js.
 *
 * Task 3.1 shipped create + get. Task 3.3 added PATCH (DRAFT-only edits)
 * and the finalize/cancel transitions. Task 3.4 added GET / (filtered
 * list + aggregates). Task 3.5 adds the performance-sheet projection
 * (JSON + CSV export) — both mounted BEFORE GET / and GET /:tripId so
 * the static paths read clearly ahead of the param route in this file,
 * even though Express would already disambiguate them (no ambiguity:
 * "/performance-sheet" vs "/:tripId" never collide). There is
 * deliberately NO route for the INVOICED transition — markTripInvoiced
 * exists only as a service function for Module 4 to call from its own
 * transaction; hitting a fabricated /invoice route 404s automatically
 * since no such route is registered.
 */

const express = require("express");

const authenticate = require("../../middleware/authenticate");
const tenantContext = require("../../middleware/tenantContext");
const requirePermission = require("../../middleware/requirePermission");
const validate = require("../../middleware/validate");
const {
  createTripSheetSchema,
  updateTripSheetSchema,
  cancelTripSchema,
  tripIdParamSchema,
  listTripsQuerySchema,
  performanceSheetQuerySchema,
  performanceSheetCsvQuerySchema,
} = require("../../validators/tripSheet.validator");
const tripSheetService = require("../../services/tripSheet.service");
const perfSheet = require("../../services/performanceSheet.service");

const router = express.Router();

router.use(authenticate, tenantContext);

router.get(
  "/performance-sheet",
  requirePermission("trips:read"),
  validate(performanceSheetQuerySchema, "query"),
  async (req, res) => {
    const sheet = await perfSheet.getPerformanceSheet(req.tenantId, req.query, req.db);
    res.json(sheet);
  },
);

router.get(
  "/performance-sheet/export.csv",
  requirePermission("trips:read"),
  validate(performanceSheetCsvQuerySchema, "query"),
  async (req, res) => {
    const { filename, csv, row_count, group_count } = await perfSheet.getPerformanceSheetCsv(
      req.tenantId,
      req.query,
      req.db,
    );
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Row-Count": String(row_count),
      "X-Group-Count": String(group_count),
    });
    res.send(csv);
  },
);

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
  "/",
  requirePermission("trips:read"),
  validate(listTripsQuerySchema, "query"),
  async (req, res) => {
    const result = await tripSheetService.listTrips(req.tenantId, req.query, req.db);
    res.json(result);
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

router.patch(
  "/:tripId",
  requirePermission("trips:write"),
  validate(tripIdParamSchema, "params"),
  validate(updateTripSheetSchema, "body"),
  async (req, res) => {
    const trip = await tripSheetService.updateTripSheet(
      req.tenantId,
      req.params.tripId,
      req.body,
      req.user.userId,
      req.db,
    );
    res.json({ trip });
  },
);

router.post(
  "/:tripId/finalize",
  requirePermission("trips:finalize"),
  validate(tripIdParamSchema, "params"),
  async (req, res) => {
    const trip = await tripSheetService.finalizeTripSheet(req.tenantId, req.params.tripId, req.user.userId, req.db);
    res.json({ trip });
  },
);

router.post(
  "/:tripId/cancel",
  requirePermission("trips:cancel"),
  validate(tripIdParamSchema, "params"),
  validate(cancelTripSchema, "body"),
  async (req, res) => {
    const trip = await tripSheetService.cancelTripSheet(
      req.tenantId,
      req.params.tripId,
      req.body,
      req.user.userId,
      req.db,
    );
    res.json({ trip });
  },
);

module.exports = router;
