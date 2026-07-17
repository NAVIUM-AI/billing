/**
 * Depends on authenticate() running first. Always mount as:
 *   router.use(authenticate, tenantContext)
 *
 * Two jobs:
 *   (a) Copy req.user.tenantId to req.tenantId — downstream code that
 *       just needs "which tenant" shouldn't have to know the shape of
 *       the auth payload.
 *   (b) Attach req.db, a tenant-bound version of the queryAsTenant /
 *       withTenantContext helpers from config/db.js, so route handlers
 *       never have to remember to pass tenantId themselves. Forgetting
 *       to scope a query is exactly the kind of mistake row-level
 *       security (see the enable_rls_and_ping migration) exists to
 *       catch, but req.db removes the chance to forget in the first
 *       place.
 */

const { queryAsTenant, withTenantContext } = require("../config/db");
const { apiError } = require("../utils/httpError");

function tenantContext(req, res, next) {
  if (!req.user || !req.user.tenantId) {
    return next(
      apiError(401, "TENANT_CONTEXT_MISSING", "Tenant context not established."),
    );
  }

  const tenantId = req.user.tenantId;
  req.tenantId = tenantId;
  req.db = {
    queryAsTenant: (text, params) => queryAsTenant(tenantId, text, params),
    withTenantContext: (fn) => withTenantContext(tenantId, fn),
  };

  next();
}

module.exports = tenantContext;
