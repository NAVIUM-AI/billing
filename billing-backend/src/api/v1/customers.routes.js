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
  quickCreateCustomerSchema,
  listCustomersQuerySchema,
  getCustomerQuerySchema,
  createContactSchema,
  customerIdParamSchema,
  customerContactParamSchema,
} = require("../../validators/customer.validator");
const { invoiceableTripsQuerySchema } = require("../../validators/invoice.validator");
const { recordPaymentSchema } = require("../../validators/payment.validator");
const customerService = require("../../services/customer.service");
const invoiceService = require("../../services/invoice.service");
const paymentService = require("../../services/payment.service");

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

// Task 4.6: minimal-field variant of POST / for an inline "new
// customer" modal during trip/invoice creation. Registered ahead of
// GET /:customerId so the literal path reads clearly next to the
// parameterized one — same convention as pricing.routes.js's
// /rules/applicable — though POST has no actual collision risk here
// since the only other POST route at this level is the exact path "/".
router.post(
  "/quick-create",
  requirePermission("customers:write"),
  validate(quickCreateCustomerSchema),
  async (req, res) => {
    const customer = await customerService.quickCreateCustomer(
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

// Task 4.2: the invoice-drafting checkbox picker — "which of this
// customer's trips can I put on an invoice right now." Gated on
// invoices:draft (not customers:read) since it's preparatory for
// building an invoice, not a customer-record view.
router.get(
  "/:customerId/invoiceable-trips",
  requirePermission("invoices:draft"),
  validate(customerIdParamSchema, "params"),
  validate(invoiceableTripsQuerySchema, "query"),
  async (req, res) => {
    const data = await invoiceService.getInvoiceableTripsForCustomer(
      req.tenantId,
      req.params.customerId,
      req.query,
      req.db,
    );
    res.json(data);
  },
);

// Task 4.4: standalone customer advance (not tied to any invoice yet).
router.post(
  "/:customerId/advances",
  requirePermission("payments:record"),
  validate(customerIdParamSchema, "params"),
  validate(recordPaymentSchema, "body"),
  async (req, res) => {
    const payment = await paymentService.recordAdvanceForCustomer(
      req.tenantId,
      req.params.customerId,
      req.body,
      req.user.userId,
      req.db,
    );
    res.status(201).json({ payment });
  },
);

// Task 4.4: full statement — every non-DRAFT invoice and every
// RECORDED payment for this customer, merged into one running-balance
// timeline.
router.get(
  "/:customerId/ledger",
  requirePermission("payments:read"),
  validate(customerIdParamSchema, "params"),
  async (req, res) => {
    const result = await paymentService.getCustomerLedger(req.tenantId, req.params.customerId, req.db);
    res.json(result);
  },
);

module.exports = router;
