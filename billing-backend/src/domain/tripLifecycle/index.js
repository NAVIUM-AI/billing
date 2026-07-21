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
 * INVOICED can:
 *   → FINALIZED  (Task 4.3: Module 4's invoice-cancel flow reverses
 *                 this when an ISSUED/PAID invoice is cancelled via
 *                 credit note — the trip becomes re-invoiceable. This
 *                 module originally shipped (Task 3.3) treating
 *                 INVOICED as terminal, on the assumption that the
 *                 reversal would be "an invoice-level concern Module 4
 *                 will implement" — it turned out to belong here
 *                 instead, since the trip's OWN state machine is what
 *                 decides which transitions are legal, invoice-level
 *                 or not.)
 *
 * CANCELLED is terminal. No un-cancel.
 */

const TRANSITIONS = Object.freeze({
  DRAFT: new Set(["FINALIZED", "CANCELLED"]),
  FINALIZED: new Set(["INVOICED", "CANCELLED"]),
  INVOICED: new Set(["FINALIZED"]),
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
