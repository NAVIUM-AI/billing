/**
 * State names for the 2-LETTER codes this app actually stores in
 * `tenants.state_code` / `customers.state_code` — e.g. "KA", "MH",
 * "TN" (see src/utils/gstin.js#GST_STATE_MAP, which derives these same
 * 2-letter codes from a GSTIN's leading 2 numeric digits, and
 * src/domain/gst/index.js#isSameState, which compares state_code
 * values directly as strings).
 *
 * An earlier version of this file was keyed by the official numeric
 * CBIC GST state code ("29" for Karnataka) instead — those numbers
 * never appear anywhere in this schema, so "Place of Supply" silently
 * never rendered on any PDF. Caught by actually looking at a rendered
 * PDF (Rule 11's "verify the component does what it claims", applied
 * to my own output, not just the spec's).
 */

const STATE_NAMES = Object.freeze({
  JK: "Jammu and Kashmir",
  HP: "Himachal Pradesh",
  PB: "Punjab",
  CH: "Chandigarh",
  UK: "Uttarakhand",
  HR: "Haryana",
  DL: "Delhi",
  RJ: "Rajasthan",
  UP: "Uttar Pradesh",
  BR: "Bihar",
  SK: "Sikkim",
  AR: "Arunachal Pradesh",
  NL: "Nagaland",
  MN: "Manipur",
  MZ: "Mizoram",
  TR: "Tripura",
  ML: "Meghalaya",
  AS: "Assam",
  WB: "West Bengal",
  JH: "Jharkhand",
  OR: "Odisha",
  CG: "Chhattisgarh",
  MP: "Madhya Pradesh",
  GJ: "Gujarat",
  DD: "Daman and Diu",
  DN: "Dadra and Nagar Haveli",
  MH: "Maharashtra",
  AP: "Andhra Pradesh",
  KA: "Karnataka",
  GA: "Goa",
  LD: "Lakshadweep",
  KL: "Kerala",
  TN: "Tamil Nadu",
  PY: "Puducherry",
  AN: "Andaman and Nicobar Islands",
  TG: "Telangana",
  AD: "Andhra Pradesh (New)",
  LA: "Ladakh",
});

/**
 * @param {?string} stateCode - 2-letter code, e.g. "KA"
 * @returns {?string}
 */
function stateNameForCode(stateCode) {
  if (!stateCode) return null;
  return STATE_NAMES[stateCode.toUpperCase()] || null;
}

module.exports = { STATE_NAMES, stateNameForCode };
