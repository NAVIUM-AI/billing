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
 *   → PAID      (derived, Task 4.4: automatic when cumulative RECORDED
 *                payments reach net_payable_paise)
 *   → CANCELLED (via POST /invoices/:id/cancel — issues a credit note)
 *
 * PAID can:
 *   → CANCELLED (via POST /invoices/:id/cancel — issues a credit note;
 *                the refund itself is handled outside this system)
 *   → ISSUED    (derived, Task 4.4: automatic when a payment
 *                cancellation drops cumulative RECORDED payments back
 *                below net_payable_paise — the mirror image of the
 *                ISSUED → PAID trigger, so it belongs in the same
 *                state machine as a first-class transition rather than
 *                as a special case bolted onto payment.service.js)
 *
 * CANCELLED is terminal.
 */

const TRANSITIONS = Object.freeze({
  DRAFT: new Set(["ISSUED", "CANCELLED"]),
  ISSUED: new Set(["PAID", "CANCELLED"]),
  PAID: new Set(["CANCELLED", "ISSUED"]),
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
