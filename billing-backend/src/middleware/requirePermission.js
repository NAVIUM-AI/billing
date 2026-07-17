/**
 * Permission-check middleware, driven entirely by config/accessMatrix.js
 * — this is the preferred way to gate a route by role. requireRole.js
 * still exists for lower-level, ad-hoc checks, but new routes should use
 * this instead so the allowed-roles list lives in one place.
 *
 * Must run after authenticate() (needs req.user).
 *
 * Usage: router.get('/x', authenticate, requirePermission('settings:read'), handler)
 */

const matrix = require("../config/accessMatrix");
const { apiError } = require("../utils/httpError");

/**
 * @param {string} key - a key from config/accessMatrix.js
 * @returns {import('express').RequestHandler}
 */
function requirePermission(key) {
  const allowed = matrix[key];
  if (!allowed) {
    // Routes are require()'d at server boot, so a typo'd permission key
    // throws here immediately on startup instead of surfacing as a
    // silent 403 (or worse, a silent allow) the first time the route is
    // hit in production.
    throw new Error(
      `Unknown permission key: ${key}. Add it to src/config/accessMatrix.js.`,
    );
  }

  return function (req, res, next) {
    if (!req.user) {
      return next(apiError(401, "AUTH_REQUIRED", "Authentication required."));
    }
    if (!allowed.includes(req.user.role)) {
      return next(
        apiError(403, "FORBIDDEN", "Your role does not permit this action.", {
          required: key,
          role: req.user.role,
        }),
      );
    }
    next();
  };
}

module.exports = requirePermission;
