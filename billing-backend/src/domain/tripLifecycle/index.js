/**
 * Trip status state machine. Pure module — no framework imports, same
 * pattern as src/domain/pricing/ (trivially unit-testable, portable,
 * and reusable outside an HTTP request). Module 4's invoice-issue flow
 * consumes this same validator when it transitions a trip to INVOICED.
 *
 * DRAFT can:
 *   → CANCELLED (via /cancel)
 *   → FINALIZED (via /finalize)
 *
 * FINALIZED can:
 *   → INVOICED   (via Module 4 invoice-issue flow)
 *   → CANCELLED  (via /cancel — reversal case)
 *
 * INVOICED is currently terminal from this module's perspective. A
 * cancellation after invoicing requires an invoice-level reversal
 * (credit note) that Module 4 will implement.
 *
 * CANCELLED is terminal. No un-cancel.
 */

const TRANSITIONS = Object.freeze({
  DRAFT: new Set(["FINALIZED", "CANCELLED"]),
  FINALIZED: new Set(["INVOICED", "CANCELLED"]),
  INVOICED: new Set([]), // terminal from module 3
  CANCELLED: new Set([]), // terminal
});

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function isValidTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return !!allowed && allowed.has(to);
}

/**
 * @param {string} from
 * @returns {string[]}
 */
function allowedTransitions(from) {
  return Array.from(TRANSITIONS[from] || []);
}

module.exports = {
  isValidTransition,
  allowedTransitions,
  TRANSITIONS,
};
