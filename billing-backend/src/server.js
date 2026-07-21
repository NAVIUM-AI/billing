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
const pdfEngine = require("./services/pdfEngine.service");

app.listen(env.port, () => {
  logger.info(`Server listening on port ${env.port}`);
});

// Puppeteer keeps a Chromium process alive for the app's lifetime
// (pdfEngine.service.js). Without this, SIGTERM/SIGINT would leave
// that child process orphaned instead of shutting down with us.
async function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);
  await pdfEngine.shutdown();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
