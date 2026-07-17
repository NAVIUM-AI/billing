/**
 * Minimal structured logger.
 *
 * We log JSON (not free-text strings) so that in production these lines
 * can be shipped to a log aggregator and filtered/searched by field
 * (level, timestamp, etc.) without needing an external logging library
 * for this early stage of the project.
 */

/**
 * @param {"info"|"warn"|"error"} level
 * @param {string} message
 * @param {Record<string, unknown>} [meta] - extra structured fields
 */
function log(level, message, meta = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

module.exports = {
  info: (message, meta) => log("info", message, meta),
  warn: (message, meta) => log("warn", message, meta),
  error: (message, meta) => log("error", message, meta),
};
