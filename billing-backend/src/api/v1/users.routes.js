/**
 * User-management routes, scoped to the current tenant. Thin by design
 * — validation lives in user.validator.js, business logic (owner
 * protections, email uniqueness, token revocation on deactivation) in
 * user.service.js.
 */

const express = require("express");

const authenticate = require("../../middleware/authenticate");
const tenantContext = require("../../middleware/tenantContext");
const requirePermission = require("../../middleware/requirePermission");
const validate = require("../../middleware/validate");
const {
  createUserSchema,
  updateRoleSchema,
  setActiveSchema,
  userIdParamSchema,
  listUsersQuerySchema,
} = require("../../validators/user.validator");
const userService = require("../../services/user.service");

const router = express.Router();

router.use(authenticate, tenantContext);

router.get(
  "/",
  requirePermission("users:list"),
  validate(listUsersQuerySchema, "query"),
  async (req, res) => {
    const { limit, offset, includeInactive } = req.query;
    const { rows, total } = await userService.listUsers(req.tenantId, {
      limit,
      offset,
      includeInactive,
    });
    res.json({ users: rows, pagination: { total, limit, offset } });
  },
);

router.post(
  "/",
  requirePermission("users:create"),
  validate(createUserSchema),
  async (req, res) => {
    const user = await userService.createUser(
      req.tenantId,
      req.body,
      req.user.userId,
    );
    res.status(201).json({ user });
  },
);

router.patch(
  "/:userId/role",
  requirePermission("users:update_role"),
  validate(userIdParamSchema, "params"),
  validate(updateRoleSchema),
  async (req, res) => {
    const user = await userService.updateUserRole(
      req.tenantId,
      req.params.userId,
      req.body.role,
      req.user.userId,
    );
    res.json({ user });
  },
);

router.patch(
  "/:userId/status",
  requirePermission("users:deactivate"),
  validate(userIdParamSchema, "params"),
  validate(setActiveSchema),
  async (req, res) => {
    const { userId } = req.params;
    const { isActive } = req.body;
    const user = isActive
      ? await userService.reactivateUser(req.tenantId, userId, req.user.userId)
      : await userService.deactivateUser(req.tenantId, userId, req.user.userId);
    res.json({ user });
  },
);

module.exports = router;
