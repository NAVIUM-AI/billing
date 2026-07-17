/**
 * Driver master routes, scoped to the current tenant. Thin by design —
 * validation lives in driver.validator.js, business logic (duplicate
 * detection, archive/unarchive idempotence) in driver.service.js.
 * Mirrors vehicles.routes.js (Task 2.1).
 */

const express = require("express");

const authenticate = require("../../middleware/authenticate");
const tenantContext = require("../../middleware/tenantContext");
const requirePermission = require("../../middleware/requirePermission");
const validate = require("../../middleware/validate");
const {
  createDriverSchema,
  updateDriverSchema,
  listDriversQuerySchema,
  driverIdParamSchema,
} = require("../../validators/driver.validator");
const driverService = require("../../services/driver.service");

const router = express.Router();

router.use(authenticate, tenantContext);

router.get(
  "/",
  requirePermission("drivers:read"),
  validate(listDriversQuerySchema, "query"),
  async (req, res) => {
    const { drivers, pagination } = await driverService.listDrivers(
      req.tenantId,
      req.query,
      req.db,
    );
    res.json({ drivers, pagination });
  },
);

router.post(
  "/",
  requirePermission("drivers:write"),
  validate(createDriverSchema),
  async (req, res) => {
    const driver = await driverService.createDriver(
      req.tenantId,
      req.body,
      req.user.userId,
      req.db,
    );
    res.status(201).json({ driver });
  },
);

router.get(
  "/:driverId",
  requirePermission("drivers:read"),
  validate(driverIdParamSchema, "params"),
  async (req, res) => {
    const driver = await driverService.getDriver(
      req.tenantId,
      req.params.driverId,
      req.db,
    );
    res.json({ driver });
  },
);

router.patch(
  "/:driverId",
  requirePermission("drivers:write"),
  validate(driverIdParamSchema, "params"),
  validate(updateDriverSchema),
  async (req, res) => {
    const driver = await driverService.updateDriver(
      req.tenantId,
      req.params.driverId,
      req.body,
      req.user.userId,
      req.db,
    );
    res.json({ driver });
  },
);

router.post(
  "/:driverId/archive",
  requirePermission("drivers:write"),
  validate(driverIdParamSchema, "params"),
  async (req, res) => {
    const driver = await driverService.archiveDriver(
      req.tenantId,
      req.params.driverId,
      req.user.userId,
      req.db,
    );
    res.json({ driver });
  },
);

router.post(
  "/:driverId/unarchive",
  requirePermission("drivers:write"),
  validate(driverIdParamSchema, "params"),
  async (req, res) => {
    const driver = await driverService.unarchiveDriver(
      req.tenantId,
      req.params.driverId,
      req.user.userId,
      req.db,
    );
    res.json({ driver });
  },
);

module.exports = router;
