const { toIndianFY } = require("./fiscalYear");

/**
 * Format a trip sheet number.
 *   prefix='TS', seq=1586, tripDate=Date(2026-07-08)
 *   → 'TS-1586/26-27'
 *
 * @param {string} prefix
 * @param {number} seq
 * @param {Date} tripDate
 * @returns {string}
 */
function format(prefix, seq, tripDate) {
  const fy = toIndianFY(tripDate);
  return `${prefix}-${seq}/${fy}`;
}

module.exports = { format };
