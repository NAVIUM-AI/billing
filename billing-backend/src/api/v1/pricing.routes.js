/**
 * Pricing-rules routes, scoped to the current tenant. Thin by design —
 * validation lives in pricingRule.validator.js, business logic
 * (normalize/derive/validate/check/write, versioning via supersede,
 * calculation dispatch) in pricingRule.service.js.
 *
 * Route order matters here: GET /rules/applicable is a literal path
 * that must be registered BEFORE GET /rules/:ruleId. Express matches
 * routes in registration order, and :ruleId would otherwise "claim"
 * the literal segment "applicable" as if it were a rule id (failing
 * UUID validation with a confusing 400 instead of ever reaching the
 * applicable-rule handler).
 */

const express = require("express");

const authenticate = require("../../middleware/authenticate");
const tenantContext = require("../../middleware/tenantContext");
const requirePermission = require("../../middleware/requirePermission");
const validate = require("../../middleware/validate");
const {
  createRuleSchema,
  updateRuleSchema,
  supersedeSchema,
  listRulesQuerySchema,
  applicableRuleQuerySchema,
  previewSchema,
  ruleIdParamSchema,
} = require("../../validators/pricingRule.validator");
const pricingRuleService = require("../../services/pricingRule.service");

const router = express.Router();

router.use(authenticate, tenantContext);

router.get(
  "/rules",
  requirePermission("pricing:read"),
  validate(listRulesQuerySchema, "query"),
  async (req, res) => {
    const { rules, pagination } = await pricingRuleService.listRules(
      req.tenantId,
      req.query,
      req.db,
    );
    res.json({ rules, pagination });
  },
);

router.post(
  "/rules",
  requirePermission("pricing:write"),
  validate(createRuleSchema),
  async (req, res) => {
    const rule = await pricingRuleService.createRule(
      req.tenantId,
      req.body,
      req.user.userId,
      req.db,
    );
    res.status(201).json({ rule });
  },
);

// Must come before GET /rules/:ruleId — see the top-of-file comment.
router.get(
  "/rules/applicable",
  requirePermission("pricing:read"),
  validate(applicableRuleQuerySchema, "query"),
  async (req, res) => {
    const rule = await pricingRuleService.getApplicableRule(
      req.tenantId,
      {
        ruleType: req.query.rule_type,
        vehicleType: req.query.vehicle_type,
        onDate: req.query.on_date,
      },
      req.db,
    );
    res.json({ rule });
  },
);

router.get(
  "/rules/:ruleId",
  requirePermission("pricing:read"),
  validate(ruleIdParamSchema, "params"),
  async (req, res) => {
    const rule = await pricingRuleService.getRule(req.tenantId, req.params.ruleId, req.db);
    res.json({ rule });
  },
);

router.patch(
  "/rules/:ruleId",
  requirePermission("pricing:write"),
  validate(ruleIdParamSchema, "params"),
  validate(updateRuleSchema),
  async (req, res) => {
    const rule = await pricingRuleService.updateRule(
      req.tenantId,
      req.params.ruleId,
      req.body,
      req.user.userId,
      req.db,
    );
    res.json({ rule });
  },
);

router.post(
  "/rules/:ruleId/supersede",
  requirePermission("pricing:write"),
  validate(ruleIdParamSchema, "params"),
  validate(supersedeSchema),
  async (req, res) => {
    const { superseded, new_rule: newRule } = await pricingRuleService.supersedeRule(
      req.tenantId,
      req.params.ruleId,
      req.body,
      req.user.userId,
      req.db,
    );
    res.json({ superseded, new_rule: newRule });
  },
);

router.post(
  "/preview",
  requirePermission("pricing:read"),
  validate(previewSchema),
  async (req, res) => {
    const preview = await pricingRuleService.previewCalculation(
      req.tenantId,
      {
        ruleType: req.body.rule_type,
        vehicleType: req.body.vehicle_type,
        onDate: req.body.on_date,
        usage: req.body.usage,
      },
      req.db,
    );
    res.json(preview);
  },
);

module.exports = router;
