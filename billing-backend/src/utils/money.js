/**
 * All money in the system is stored and computed in PAISE (integer).
 * 1 rupee = 100 paise.
 *
 * ₹2,200.00 = 220000 paise
 * ₹0.50     = 50 paise
 * ₹14       = 1400 paise
 *
 * Never use JavaScript number arithmetic for money without paise.
 * 0.1 + 0.2 = 0.30000000000000004 — that's a real invoice discrepancy.
 */

/**
 * @param {number|string} rupees
 * @returns {number} integer paise
 */
function rupeesToPaise(rupees) {
  // Accept number or numeric string.
  if (typeof rupees === "string") {
    rupees = Number(rupees);
  }
  if (!Number.isFinite(rupees)) {
    throw new TypeError("rupeesToPaise: expected finite number");
  }
  // Round to nearest paise to guard against float input like
  // 14.999999999.
  return Math.round(rupees * 100);
}

/**
 * @param {number} paise
 * @returns {number} rupees (may be fractional, e.g. 2200.5)
 */
function paiseToRupees(paise) {
  if (!Number.isInteger(paise)) {
    throw new TypeError("paiseToRupees: expected integer paise");
  }
  return paise / 100;
}

/**
 * @param {number} paise
 * @returns {string} "₹92,190.00" style. Not used in calc; useful for
 *   tests and logs.
 */
function formatINR(paise) {
  return (
    "₹" +
    paiseToRupees(paise).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

module.exports = { rupeesToPaise, paiseToRupees, formatINR };
