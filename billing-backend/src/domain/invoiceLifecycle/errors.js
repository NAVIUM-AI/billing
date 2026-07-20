/**
 * InvoiceLifecycleError — thrown by the pure invoice state machine when
 * a requested status transition isn't allowed. Zero dependencies, same
 * pattern as src/domain/tripLifecycle/errors.js#LifecycleError — the
 * service layer translates this to apiError at its boundary.
 */
class InvoiceLifecycleError extends Error {
  constructor(message, { from = null, to = null, reason = null } = {}) {
    super(message);
    this.name = "InvoiceLifecycleError";
    this.from = from;
    this.to = to;
    this.reason = reason;
  }
}

module.exports = { InvoiceLifecycleError };
