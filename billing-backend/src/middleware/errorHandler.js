/**
 * Global error-handling middleware. Must be mounted LAST, after all
 * routes, and must take 4 args so Express recognizes it as an error
 * handler (as opposed to regular middleware).
 *
 * Every error response follows the same shape so the frontend can rely
 * on it: { error: { code, message, details? } }.
 *
 * Selective 5xx message masking per ADR-007. 500/502/503/504 mask the
 * message (defensive against exception message leakage — a 5xx message
 * is often an internal library/DB message we don't want to expose to
 * clients). 501 and other 5xx codes let their message through — 501 in
 * particular is a deliberate response ("this feature is not yet
 * implemented") whose message carries actionable information for
 * clients, not an accidental leak.
 */

const logger = require("../utils/logger");

const MASK_STATUSES = new Set([500, 502, 503, 504]);

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const code = err.code || "INTERNAL_ERROR";
  // Unexpected (5xx) errors are ours to fix — log as error. Client
  // mistakes (4xx) are expected traffic — log as warn so they don't
  // page anyone or drown out real failures.
  const logLevel = status >= 500 ? "error" : "warn";
  logger[logLevel]("Request failed", {
    status,
    code,
    message: err.message,
    path: req.originalUrl,
    method: req.method,
  });

  const shouldMaskMessage = MASK_STATUSES.has(status);
  const responseMessage = shouldMaskMessage ? "Internal server error" : err.message || "An error occurred";

  const body = { error: { code, message: responseMessage } };

  if (err.details) {
    body.error.details = err.details;
  }

  // Never leak stack traces in production — only useful for local
  // debugging and would otherwise expose internals to clients.
  if (process.env.NODE_ENV !== "production") {
    body.error.details = { ...body.error.details, stack: err.stack };
  }

  res.status(status).json(body);
}

module.exports = errorHandler;
