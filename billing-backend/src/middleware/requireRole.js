/**
 * Role-check primitive. This is NOT the full RBAC matrix — just "is the
 * caller's role in this allow-list" — the richer permission model comes
 * in Task 1.5. Not consumed anywhere yet in this task; defined now so
 * 1.5 can build on it.
 *
 * Usage: router.get('/admin-only', authenticate, requireRole('owner', 'admin'), handler)
 */

const { apiError } = require("../utils/httpError");

/**
 * @param {...string} allowed - roles permitted to proceed
 * @returns {import('express').RequestHandler}
 */
function requireRole(...allowed) {
  return function (req, res, next) {
    if (!req.user) {
      return next(apiError(401, "AUTH_REQUIRED", "Authentication required."));
    }
    if (!allowed.includes(req.user.role)) {
      return next(apiError(403, "FORBIDDEN", "Insufficient role."));
    }
    next();
  };
}

module.exports = requireRole;
