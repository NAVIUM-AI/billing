/**
 * Format and state-code validation only. Portal verification (checking
 * a GSTIN is actually registered/active with the GST department) is a
 * later integration.
 *
 * Format:
 *   Positions 1-2  : state code (numeric, "29"=KA)
 *   Positions 3-12 : PAN of the entity
 *   Position 13    : entity number in state
 *   Position 14    : always 'Z' (legacy default)
 *   Position 15    : check digit
 *
 * We validate structure + state code numeric -> 2-letter state map. We
 * do NOT verify with the GST portal.
 */

// Numeric GST state code -> 2-letter code used elsewhere in the app.
// Union territories included.
const GST_STATE_MAP = Object.freeze({
  "01": "JK",
  "02": "HP",
  "03": "PB",
  "04": "CH",
  "05": "UK",
  "06": "HR",
  "07": "DL",
  "08": "RJ",
  "09": "UP",
  "10": "BR",
  "11": "SK",
  "12": "AR",
  "13": "NL",
  "14": "MN",
  "15": "MZ",
  "16": "TR",
  "17": "ML",
  "18": "AS",
  "19": "WB",
  "20": "JH",
  "21": "OR",
  "22": "CG",
  "23": "MP",
  "24": "GJ",
  "25": "DD",
  "26": "DN",
  "27": "MH",
  "28": "AP",
  "29": "KA",
  "30": "GA",
  "31": "LD",
  "32": "KL",
  "33": "TN",
  "34": "PY",
  "35": "AN",
  "36": "TG",
  "37": "AD",
  "38": "LA",
});

/**
 * @param {string} raw
 * @returns {string|null}
 */
function normalize(raw) {
  if (typeof raw !== "string") return null;
  return raw.replace(/\s+/g, "").toUpperCase();
}

/**
 * @param {string} canonical
 * @returns {boolean}
 */
function isFormatValid(canonical) {
  return (
    typeof canonical === "string" &&
    /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(canonical)
  );
}

/**
 * @param {string} canonical
 * @returns {string|null}
 */
function stateFromGstin(canonical) {
  if (!isFormatValid(canonical)) return null;
  return GST_STATE_MAP[canonical.slice(0, 2)] || null;
}

module.exports = { normalize, isFormatValid, stateFromGstin, GST_STATE_MAP };
