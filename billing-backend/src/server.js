/**
 * Server entry point.
 *
 * Loads environment variables and starts the HTTP server. Kept separate
 * from app.js so app.js can be imported without side effects (e.g. in
 * future tests).
 */

const env = require("./config/env");
const app = require("./app");
const logger = require("./utils/logger");

app.listen(env.port, () => {
  logger.info(`Server listening on port ${env.port}`);
});
