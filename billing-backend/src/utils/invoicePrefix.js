/**
 * Derives a tenant's default invoice/performance prefixes from its
 * business name at signup time (Task 4.1). Editable afterward in
 * settings — these are just sane defaults, not permanent identity.
 */

/**
 * First 3 alphabetic characters of the business name, uppercased.
 * Skips spaces, digits, and punctuation entirely rather than rejecting
 * them, so "3 Star Cabs" still yields a usable "STA" instead of an
 * error. Falls back to "INV" when there are no alphabetic characters
 * at all (or the input isn't a string).
 *
 * @param {string} businessName
 * @returns {string}
 */
function deriveInvoicePrefix(businessName) {
  if (typeof businessName !== "string") return "INV";
  const alphaOnly = businessName.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (alphaOnly.length === 0) return "INV";
  return alphaOnly.slice(0, 3);
}

/**
 * @param {string} basePrefix
 * @returns {string}
 */
function derivePerformancePrefix(basePrefix) {
  return `${basePrefix}-PS`;
}

module.exports = { deriveInvoicePrefix, derivePerformancePrefix };
