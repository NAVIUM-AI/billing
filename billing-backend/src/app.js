/**
 * Express application setup.
 *
 * This file only builds and configures the app (middleware, routes,
 * error handling) — it does NOT start listening on a port. That split
 * lets us import `app` in tests later without binding a real socket.
 */

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const v1Router = require("./api/v1");
const logger = require("./utils/logger");

const app = express();

// helmet sets a bunch of security-related HTTP headers by default;
// cheap to add now and avoids having to remember it later.
app.use(helmet());
app.use(cors());
app.use(express.json());

// Simple liveness/readiness check — used by load balancers, uptime
// monitors, and by us to verify the server booted correctly.
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/v1", v1Router);

// 404 handler — anything that didn't match a route above.
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler. Must be defined with 4 args (err, req, res, next)
// so Express recognizes it as an error-handling middleware.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error("Unhandled error", { message: err.message, stack: err.stack });
  res.status(err.status || 500).json({ error: "Internal server error" });
});

module.exports = app;
