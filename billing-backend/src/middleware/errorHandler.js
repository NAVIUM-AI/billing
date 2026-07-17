/**
 * Global error-handling middleware. Must be mounted LAST, after all
 * routes, and must take 4 args so Express recognizes it as an error
 * handler (as opposed to regular middleware).
 *
 * Every error response follows the same shape so the frontend can rely
 * on it: { error: { code, message, details? } }.
 */

const logger = require("../utils/logger");

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

  // A 5xx message is often an internal library/DB message we don't want
  // to expose to clients. 4xx messages are ours (from apiError) and are
  // written to be safe to show.
  const message = status >= 500 ? "Internal server error" : err.message;

  const body = { error: { code, message } };

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
