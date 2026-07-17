/**
 * Vehicle master routes, scoped to the current tenant. Thin by design —
 * validation lives in vehicle.validator.js, business logic (duplicate
 * detection, archive/unarchive idempotence) in vehicle.service.js.
 */

const express = require("express");

const authenticate = require("../../middleware/authenticate");
const tenantContext = require("../../middleware/tenantContext");
const requirePermission = require("../../middleware/requirePermission");
const validate = require("../../middleware/validate");
const {
  createVehicleSchema,
  updateVehicleSchema,
  listVehiclesQuerySchema,
  vehicleIdParamSchema,
} = require("../../validators/vehicle.validator");
const vehicleService = require("../../services/vehicle.service");

const router = express.Router();

router.use(authenticate, tenantContext);

router.get(
  "/",
  requirePermission("vehicles:read"),
  validate(listVehiclesQuerySchema, "query"),
  async (req, res) => {
    const { vehicles, pagination } = await vehicleService.listVehicles(
      req.tenantId,
      req.query,
      req.db,
    );
    res.json({ vehicles, pagination });
  },
);

router.post(
  "/",
  requirePermission("vehicles:write"),
  validate(createVehicleSchema),
  async (req, res) => {
    const vehicle = await vehicleService.createVehicle(
      req.tenantId,
      req.body,
      req.user.userId,
      req.db,
    );
    res.status(201).json({ vehicle });
  },
);

router.get(
  "/:vehicleId",
  requirePermission("vehicles:read"),
  validate(vehicleIdParamSchema, "params"),
  async (req, res) => {
    const vehicle = await vehicleService.getVehicle(
      req.tenantId,
      req.params.vehicleId,
      req.db,
    );
    res.json({ vehicle });
  },
);

router.patch(
  "/:vehicleId",
  requirePermission("vehicles:write"),
  validate(vehicleIdParamSchema, "params"),
  validate(updateVehicleSchema),
  async (req, res) => {
    const vehicle = await vehicleService.updateVehicle(
      req.tenantId,
      req.params.vehicleId,
      req.body,
      req.user.userId,
      req.db,
    );
    res.json({ vehicle });
  },
);

router.post(
  "/:vehicleId/archive",
  requirePermission("vehicles:write"),
  validate(vehicleIdParamSchema, "params"),
  async (req, res) => {
    const vehicle = await vehicleService.archiveVehicle(
      req.tenantId,
      req.params.vehicleId,
      req.user.userId,
      req.db,
    );
    res.json({ vehicle });
  },
);

router.post(
  "/:vehicleId/unarchive",
  requirePermission("vehicles:write"),
  validate(vehicleIdParamSchema, "params"),
  async (req, res) => {
    const vehicle = await vehicleService.unarchiveVehicle(
      req.tenantId,
      req.params.vehicleId,
      req.user.userId,
      req.db,
    );
    res.json({ vehicle });
  },
);

module.exports = router;
