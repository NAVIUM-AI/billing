/**
 * Express application setup.
 *
 * This file only builds and configures the app (middleware, routes,
 * error handling) — it does NOT start listening on a port. That split
 * lets us import `app` in tests later without binding a real socket.
 *
 * Note on async errors: the task called for `express-async-errors`, but
 * this project is on Express 5 (installed in Task 1.1), which forwards
 * rejected promises from async route/middleware handlers to the error
 * handler natively. `express-async-errors` only patches Express 4's
 * router and declares a peer dependency on it, so installing it here
 * would conflict with Express 5 and add nothing — async throws already
 * reach errorHandler.js below without it.
 */

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");

const v1Router = require("./api/v1");
const errorHandler = require("./middleware/errorHandler");
const { apiError } = require("./utils/httpError");
const env = require("./config/env");

const app = express();

// helmet sets a bunch of security-related HTTP headers by default;
// cheap to add now and avoids having to remember it later.
app.use(helmet());
// The frontend sends credentialed requests (withCredentials: true) so
// the HttpOnly refresh_token cookie rides along with /auth/refresh —
// browsers reject that combination outright if Access-Control-Allow-
// Origin is the wildcard `*` (cors()'s default with no options), even
// though a same-origin curl/Postman request would never notice the
// gap. origin must reflect the actual configured frontend origin, and
// credentials must be explicitly true, for the cookie to flow at all.
app.use(cors({ origin: env.frontendUrl, credentials: true }));
app.use(express.json());
// Parses the refresh_token cookie into req.cookies for auth.routes.js —
// must run before the /api/v1 mount, since that's where it's read.
app.use(cookieParser());

// Simple liveness/readiness check — used by load balancers, uptime
// monitors, and by us to verify the server booted correctly.
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/v1", v1Router);

// 404 handler — anything that didn't match a route above. Throwing here
// (rather than writing the response directly) routes it through
// errorHandler.js so 404s get the same { error: { code, message } }
// shape as every other error.
app.use((req, res, next) => {
  next(apiError(404, "NOT_FOUND", "Resource not found"));
});

// Must be mounted LAST, after all routes, so it catches everything
// above — see errorHandler.js for the response shape and logging rules.
app.use(errorHandler);

module.exports = app;
