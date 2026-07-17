/**
 * Verifies the access token on protected routes and attaches the caller's
 * identity to `req.user`.
 *
 * This middleware only VERIFIES the token. It does NOT set Postgres
 * session context — that's the tenant-isolation middleware in task 1.4.
 */

const jwt = require("jsonwebtoken");

const { verifyAccessToken } = require("../utils/tokens");
const { apiError } = require("../utils/httpError");

const BEARER_PREFIX = "Bearer ";

function authenticate(req, res, next) {
  const header = req.get("authorization");
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    throw apiError(401, "AUTH_REQUIRED", "Authentication required.");
  }

  const token = header.slice(BEARER_PREFIX.length);

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw apiError(401, "ACCESS_TOKEN_EXPIRED", "Access token expired.");
    }
    throw apiError(401, "AUTH_INVALID", "Invalid token.");
  }

  req.user = {
    userId: payload.sub,
    tenantId: payload.tenant_id,
    role: payload.role,
  };

  next();
}

module.exports = authenticate;
