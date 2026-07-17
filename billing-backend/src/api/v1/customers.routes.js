/**
 * Customer master routes, scoped to the current tenant. Thin by design
 * — validation lives in customer.validator.js, business logic (B2B/B2C
 * rules, GSTIN/state cross-check, duplicate detection, contact
 * primary-flag handling) in customer.service.js. Mirrors
 * vehicles.routes.js / drivers.routes.js (Tasks 2.1/2.2).
 */

const express = require("express");

const authenticate = require("../../middleware/authenticate");
const tenantContext = require("../../middleware/tenantContext");
const requirePermission = require("../../middleware/requirePermission");
const validate = require("../../middleware/validate");
const {
  createCustomerSchema,
  updateCustomerSchema,
  listCustomersQuerySchema,
  getCustomerQuerySchema,
  createContactSchema,
  customerIdParamSchema,
  customerContactParamSchema,
} = require("../../validators/customer.validator");
const customerService = require("../../services/customer.service");

const router = express.Router();

router.use(authenticate, tenantContext);

router.get(
  "/",
  requirePermission("customers:read"),
  validate(listCustomersQuerySchema, "query"),
  async (req, res) => {
    const { customers, pagination } = await customerService.listCustomers(
      req.tenantId,
      req.query,
      req.db,
    );
    res.json({ customers, pagination });
  },
);

router.post(
  "/",
  requirePermission("customers:write"),
  validate(createCustomerSchema),
  async (req, res) => {
    const customer = await customerService.createCustomer(
      req.tenantId,
      req.body,
      req.user.userId,
      req.db,
    );
    res.status(201).json({ customer });
  },
);

router.get(
  "/:customerId",
  requirePermission("customers:read"),
  validate(customerIdParamSchema, "params"),
  validate(getCustomerQuerySchema, "query"),
  async (req, res) => {
    const customer = await customerService.getCustomer(
      req.tenantId,
      req.params.customerId,
      req.db,
      { includeContacts: req.query.withContacts },
    );
    res.json({ customer });
  },
);

router.patch(
  "/:customerId",
  requirePermission("customers:write"),
  validate(customerIdParamSchema, "params"),
  validate(updateCustomerSchema),
  async (req, res) => {
    const customer = await customerService.updateCustomer(
      req.tenantId,
      req.params.customerId,
      req.body,
      req.user.userId,
      req.db,
    );
    res.json({ customer });
  },
);

router.post(
  "/:customerId/archive",
  requirePermission("customers:write"),
  validate(customerIdParamSchema, "params"),
  async (req, res) => {
    const customer = await customerService.archiveCustomer(
      req.tenantId,
      req.params.customerId,
      req.user.userId,
      req.db,
    );
    res.json({ customer });
  },
);

router.post(
  "/:customerId/unarchive",
  requirePermission("customers:write"),
  validate(customerIdParamSchema, "params"),
  async (req, res) => {
    const customer = await customerService.unarchiveCustomer(
      req.tenantId,
      req.params.customerId,
      req.user.userId,
      req.db,
    );
    res.json({ customer });
  },
);

router.get(
  "/:customerId/contacts",
  requirePermission("customers:read"),
  validate(customerIdParamSchema, "params"),
  async (req, res) => {
    const contacts = await customerService.listCustomerContacts(
      req.tenantId,
      req.params.customerId,
      req.db,
    );
    res.json({ contacts });
  },
);

router.post(
  "/:customerId/contacts",
  requirePermission("customers:write"),
  validate(customerIdParamSchema, "params"),
  validate(createContactSchema),
  async (req, res) => {
    const contact = await customerService.addContact(
      req.tenantId,
      req.params.customerId,
      req.body,
      req.db,
    );
    res.status(201).json({ contact });
  },
);

router.delete(
  "/:customerId/contacts/:contactId",
  requirePermission("customers:write"),
  validate(customerContactParamSchema, "params"),
  async (req, res) => {
    await customerService.removeContact(
      req.tenantId,
      req.params.customerId,
      req.params.contactId,
      req.db,
    );
    res.status(204).end();
  },
);

module.exports = router;
