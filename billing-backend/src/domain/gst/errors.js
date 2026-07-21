/**
 * DomainInputError — thrown by the pure GST domain functions when input
 * is malformed. Mirrors src/domain/pricing/errors.js exactly (ADR-006):
 * zero external dependencies, translated to an apiError at the service
 * boundary, never here.
 */
class DomainInputError extends Error {
  constructor(message, { field = null, reason = null } = {}) {
    super(message);
    this.name = "DomainInputError";
    this.field = field;
    this.reason = reason;
  }
}

module.exports = { DomainInputError };
