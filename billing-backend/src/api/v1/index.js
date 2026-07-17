/**
 * API v1 router.
 *
 * Versioning the API under /api/v1 from day one means we can introduce
 * a /api/v2 later without breaking existing integrations.
 */

const express = require("express");

const authRoutes = require("./auth.routes");
const pingsRoutes = require("./pings.routes");
const settingsRoutes = require("./settings.routes");
const usersRoutes = require("./users.routes");
const vehiclesRoutes = require("./vehicles.routes");

const router = express.Router();

router.get("/", (req, res) => {
  res.json({ message: "Billing API v1" });
});

router.use("/auth", authRoutes);
router.use("/settings", settingsRoutes);
router.use("/users", usersRoutes);
router.use("/vehicles", vehiclesRoutes);

// Ping routes are a throwaway demo of tenant isolation. Delete once
// Module 2 tables exist and RLS is proven in production.
router.use("/pings", pingsRoutes);

module.exports = router;
