/**
 * Optimized for Indian mobile numbers. Swap for libphonenumber-js later
 * if we need strict validation across regions.
 */

/**
 * Normalize a phone number to canonical form.
 * Optimized for Indian mobile numbers; loose fallback for other
 * formats.
 *
 *  "+91 98765 43210" -> "919876543210"
 *  "98765-43210"     -> "919876543210"
 *  "919876543210"    -> "919876543210"
 *  "09876543210"     -> "919876543210"
 *  "12345"           -> "12345"  (invalid; caller must validate)
 *
 * Returns null for non-string input.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function normalize(raw) {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  // Strip leading 0 from a possible "09876543210"
  let d = digits;
  if (d.length === 11 && d.startsWith("0")) {
    d = d.slice(1);
  }
  // 10-digit Indian mobile (starts with 6/7/8/9)
  if (d.length === 10 && /^[6-9]/.test(d)) {
    return "91" + d;
  }
  // 12-digit starting with 91 + Indian mobile
  if (d.length === 12 && d.startsWith("91") && /^[6-9]/.test(d[2])) {
    return d;
  }
  // Fallback: return digits-only. Validator decides.
  return d;
}

/**
 * Accept either:
 *   - Indian mobile: '91' + 10 digits starting 6-9
 *   - Loose international: 10-15 digits
 *
 * @param {string} canonical
 * @returns {boolean}
 */
function isValidCanonical(canonical) {
  if (!canonical) return false;
  if (/^91[6-9]\d{9}$/.test(canonical)) return true;
  return /^\d{10,15}$/.test(canonical);
}

module.exports = { normalize, isValidCanonical };
