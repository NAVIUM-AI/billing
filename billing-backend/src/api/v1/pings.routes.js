/**
 * Throwaway demo routes proving tenant isolation (Task 1.4). Delete once
 * Module 2's real business tables exist and RLS is proven in production
 * the same way.
 *
 * Every route here is scoped to the caller's tenant via req.db
 * (see middleware/tenantContext.js) — no route ever passes tenantId by
 * hand, which is exactly the class of mistake row-level security exists
 * to catch even if application code forgets.
 */

const express = require("express");

const authenticate = require("../../middleware/authenticate");
const tenantContext = require("../../middleware/tenantContext");
const { apiError } = require("../../utils/httpError");

const router = express.Router();

// All routes below require both a verified identity (authenticate) and
// an established tenant context (tenantContext) — tenantContext reads
// req.user, so it must run second.
router.use(authenticate, tenantContext);

// POST /pings — create a ping for the current tenant.
router.post("/", async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== "string") {
    throw apiError(400, "VALIDATION_ERROR", "message is required");
  }

  const { rows } = await req.db.queryAsTenant(
    `INSERT INTO tenant_pings (tenant_id, message)
     VALUES ($1, $2)
     RETURNING id, tenant_id, message, created_at`,
    [req.tenantId, message],
  );
  res.status(201).json({ ping: rows[0] });
});

// GET /pings — list pings visible to current tenant.
router.get("/", async (req, res) => {
  const { rows } = await req.db.queryAsTenant(
    `SELECT id, tenant_id, message, created_at
     FROM tenant_pings
     ORDER BY created_at DESC
     LIMIT 100`,
    [],
  );
  res.json({ pings: rows });
});

// GET /pings/leak-test — INTENTIONALLY leaky query: no WHERE clause at
// all. If RLS is working, this still returns only the current tenant's
// rows. If this ever returns another tenant's rows, RLS is broken (or
// misconfigured, e.g. missing FORCE ROW LEVEL SECURITY) — a serious bug.
router.get("/leak-test", async (req, res) => {
  const { rows } = await req.db.queryAsTenant(
    "SELECT id, tenant_id, message FROM tenant_pings",
    [],
  );
  res.json({
    warning: "This endpoint deliberately omits WHERE.",
    pings: rows,
  });
});

module.exports = router;
