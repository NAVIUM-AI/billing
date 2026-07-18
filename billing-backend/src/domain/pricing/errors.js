/**
 * DomainInputError — thrown by pure pricing calculators when the input
 * is malformed or incomplete.
 *
 * Pure domain code must NEVER import apiError or anything from the
 * framework layer. This class has zero external dependencies. The
 * service layer is responsible for translating a DomainInputError into
 * an HTTP 400 apiError with an appropriate code.
 *
 * `field`  — optional. Which input field was bad.
 * `reason` — machine-readable string identifying the specific failure.
 *            Enum-ish; keep values stable so the service can switch on
 *            them if needed.
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
