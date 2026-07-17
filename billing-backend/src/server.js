/**
 * Server entry point.
 *
 * Loads environment variables and starts the HTTP server. Kept separate
 * from app.js so app.js can be imported without side effects (e.g. in
 * future tests).
 */

require("dotenv").config();

const app = require("./app");
const logger = require("./utils/logger");

const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
});
