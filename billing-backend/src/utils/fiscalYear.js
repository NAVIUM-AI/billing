/**
 * Indian fiscal year: April 1 to March 31.
 * Format returned: '26-27' for FY 2026-27.
 *
 *  Date 2026-04-01 → '26-27'
 *  Date 2027-03-31 → '26-27'
 *  Date 2027-04-01 → '27-28'
 *  Date 2026-03-31 → '25-26'
 */
function toIndianFY(date) {
  if (!(date instanceof Date)) {
    throw new TypeError("toIndianFY expects a Date");
  }
  const y = date.getFullYear();
  const m = date.getMonth() + 1; // 1-12
  const startYear = m >= 4 ? y : y - 1;
  const endYear = startYear + 1;
  const ss = String(startYear).slice(-2);
  const ee = String(endYear).slice(-2);
  return `${ss}-${ee}`;
}

module.exports = { toIndianFY };
