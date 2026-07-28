/**
 * Single source of truth for env config. Fail fast at boot if required
 * vars missing.
 *
 * Every other file should import config from here instead of reading
 * `process.env` directly — that way a missing/misspelled var breaks
 * loudly at startup instead of silently producing `undefined` deep in
 * some request handler.
 */

const path = require("path");

require("dotenv").config();

const REQUIRED_VARS = ["DATABASE_URL", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"];

const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(", ")}`,
  );
}

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT) || 8000,
  databaseUrl: process.env.DATABASE_URL,
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessTtl: process.env.JWT_ACCESS_TTL || "15m",
    refreshTtl: process.env.JWT_REFRESH_TTL || "30d",
  },
  cookie: {
    secure: process.env.COOKIE_SECURE === "true",
    domain: process.env.COOKIE_DOMAIN || "localhost",
  },
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
  pdfStorageRoot: process.env.PDF_STORAGE_ROOT
    ? path.resolve(process.env.PDF_STORAGE_ROOT)
    : path.join(process.cwd(), "pdf-storage"),
};

module.exports = Object.freeze(env);
