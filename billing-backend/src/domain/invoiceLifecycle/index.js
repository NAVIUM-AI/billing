/**
 * Invoice status state machine. Pure module — no framework imports,
 * same pattern as src/domain/tripLifecycle/ (Task 3.3).
 *
 * DRAFT can:
 *   → ISSUED    (via POST /invoices/:id/issue)
 *   → CANCELLED (via POST /invoices/:id/cancel — no credit note, the
 *                invoice was never legally issued)
 *
 * ISSUED can:
 *   → PAID      (derived from payments — Task 4.4 wires the trigger;
 *                no code path exercises this transition yet)
 *   → CANCELLED (via POST /invoices/:id/cancel — issues a credit note)
 *
 * PAID can:
 *   → CANCELLED (via POST /invoices/:id/cancel — issues a credit note;
 *                the refund itself is handled outside this system)
 *
 * CANCELLED is terminal.
 */

const TRANSITIONS = Object.freeze({
  DRAFT: new Set(["ISSUED", "CANCELLED"]),
  ISSUED: new Set(["PAID", "CANCELLED"]),
  PAID: new Set(["CANCELLED"]),
  CANCELLED: new Set([]),
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
