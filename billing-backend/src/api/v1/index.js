/**
 * API v1 router.
 *
 * Versioning the API under /api/v1 from day one means we can introduce
 * a /api/v2 later without breaking existing integrations.
 */

const express = require("express");

const router = express.Router();

router.get("/", (req, res) => {
  res.json({ message: "Billing API v1" });
});

module.exports = router;
