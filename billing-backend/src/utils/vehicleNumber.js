/**
 * Vehicle registration numbers are entered by hand (staff typing plate
 * numbers from a photo, a paper trip sheet, etc.), so the same physical
 * vehicle can show up as "KA 51 AK 1031", "KA-51-AK-1031", or
 * "ka51ak1031" across different bookings. We store BOTH forms:
 *
 *   - canonical (vehicle_number): uppercase, no separators. Used for
 *     every lookup, the uniqueness constraint, and duplicate detection
 *     — so formatting differences can never create two rows for one
 *     real vehicle.
 *   - display (vehicle_number_display): exactly what the user typed.
 *     Shown back in the UI/invoices because "KA 51 AK 1031" reads
 *     better to a human than "KA51AK1031". Never used for lookups.
 *
 * Note: this only validates the standard civilian format. The newer
 * "Bharat series" format (e.g. "22BH1234A") and defence/military
 * plates use different patterns and are NOT supported yet — future
 * work if/when a customer needs it.
 */

/**
 * Normalize a vehicle number to canonical form.
 * "ka 51 ak 1031"    -> "KA51AK1031"
 * "KA-51-AK-1031"    -> "KA51AK1031"
 * " ka51ak1031 "     -> "KA51AK1031"
 *
 * @param {string} raw
 * @returns {string|null}
 */
function normalize(raw) {
  if (typeof raw !== "string") return null;
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Validate the CANONICAL form matches the Indian civilian registration
 * pattern: 2 letters (state code) + 1-2 digits (RTO code) + 1-3 letters
 * (series) + 4 digits (unique number).
 * Examples: KA51AK1031, MH12AB1234, DL8CAF5678
 *
 * @param {string} canonical
 * @returns {boolean}
 */
function isValidCanonical(canonical) {
  return /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$/.test(canonical);
}

module.exports = { normalize, isValidCanonical };
