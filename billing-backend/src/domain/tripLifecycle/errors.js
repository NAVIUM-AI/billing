/**
 * LifecycleError — thrown by the pure trip lifecycle state machine when
 * a requested status transition isn't allowed. Zero dependencies, same
 * pattern as src/domain/pricing/errors.js#DomainInputError — the
 * service layer translates this to apiError at its boundary (ADR-006's
 * pattern generalizes to any pure domain module, not just pricing).
 */
class LifecycleError extends Error {
  constructor(message, { from = null, to = null, reason = null } = {}) {
    super(message);
    this.name = "LifecycleError";
    this.from = from;
    this.to = to;
    this.reason = reason;
  }
}

module.exports = { LifecycleError };
