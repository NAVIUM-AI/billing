/**
 * Builds errors carrying a stable, machine-readable `code` alongside the
 * HTTP status and a human message. The frontend should switch on `code`
 * (e.g. "EMAIL_ALREADY_EXISTS"), not `message` — message text can change
 * without breaking client logic.
 *
 * Built on top of `http-errors` so `err.status`/`err.statusCode` are set
 * the same way the rest of the Express ecosystem expects.
 */

const createError = require("http-errors");

/**
 * @param {number} status - HTTP status code, e.g. 400, 409
 * @param {string} code - stable machine-readable code, e.g. "VALIDATION_ERROR"
 * @param {string} message - human-readable message, safe to show to users
 * @param {Record<string, unknown>} [details] - optional extra context
 * @returns {import('http-errors').HttpError}
 */
function apiError(status, code, message, details) {
  const err = createError(status, message);
  err.code = code;
  if (details !== undefined) {
    err.details = details;
  }
  return err;
}

module.exports = { apiError };
