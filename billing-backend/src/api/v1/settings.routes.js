/**
 * Business profile settings routes: read/update the current tenant's
 * own row. Thin by design — validation lives in settings.validator.js,
 * business logic in settings.service.js.
 */

const express = require("express");

const authenticate = require("../../middleware/authenticate");
const tenantContext = require("../../middleware/tenantContext");
const requirePermission = require("../../middleware/requirePermission");
const validate = require("../../middleware/validate");
const { updateSettingsSchema } = require("../../validators/settings.validator");
const settingsService = require("../../services/settings.service");

const router = express.Router();

router.use(authenticate, tenantContext);

router.get("/business", requirePermission("settings:read"), async (req, res) => {
  const profile = await settingsService.getBusinessProfile(req.tenantId);
  res.json({ profile });
});

router.patch(
  "/business",
  requirePermission("settings:update"),
  validate(updateSettingsSchema),
  async (req, res) => {
    const profile = await settingsService.updateBusinessProfile(
      req.tenantId,
      req.body,
      req.user.userId,
    );
    res.json({ profile });
  },
);

module.exports = router;
