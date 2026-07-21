/**
 * Converts an integer paise amount to Indian-English words for invoice
 * printing, e.g. "Rupees Ninety Two Thousand One Hundred Ninety Only".
 * Uses Indian numbering (lakh, crore) — not international (million,
 * billion). Pure, zero framework imports (ADR-006).
 */

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigitToWords(n) {
  if (n === 0) return "";
  if (n < 20) return ONES[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return TENS[tens] + (ones ? " " + ONES[ones] : "");
}

function threeDigitToWords(n) {
  let out = "";
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) {
    out = ONES[hundreds] + " Hundred";
    if (rest) out += " " + twoDigitToWords(rest);
  } else if (rest) {
    out = twoDigitToWords(rest);
  }
  return out;
}

function integerToIndianWords(n) {
  if (n === 0) return "Zero";
  if (n < 0) return "Negative " + integerToIndianWords(-n);
  const parts = [];
  const crore = Math.floor(n / 10000000);
  n = n % 10000000;
  const lakh = Math.floor(n / 100000);
  n = n % 100000;
  const thousand = Math.floor(n / 1000);
  n = n % 1000;
  const rest = n;

  if (crore > 0) parts.push(integerToIndianWords(crore) + " Crore");
  if (lakh > 0) parts.push(twoDigitToWords(lakh) + " Lakh");
  if (thousand > 0) parts.push(twoDigitToWords(thousand) + " Thousand");
  if (rest > 0) parts.push(threeDigitToWords(rest));
  return parts.join(" ").trim();
}

/**
 * @param {number} paise - non-negative integer
 * @returns {string}
 */
function amountInWords(paise) {
  if (!Number.isInteger(paise) || paise < 0) {
    throw new TypeError("amountInWords: paise must be non-negative integer");
  }
  const rupees = Math.floor(paise / 100);
  const paisePart = paise % 100;
  let out = "Rupees " + integerToIndianWords(rupees);
  if (paisePart > 0) {
    out += " And " + twoDigitToWords(paisePart) + " Paise";
  }
  out += " Only";
  return out;
}

module.exports = { amountInWords };
