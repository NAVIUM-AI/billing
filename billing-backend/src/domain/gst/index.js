/**
 * Pure GST domain module (Task 4.1). Zero framework imports — mirrors
 * src/domain/pricing/ (ADR-006): the service layer is responsible for
 * translating a DomainInputError into an HTTP 400 apiError.
 */

const { DomainInputError } = require("./errors");

/**
 * Computes the CGST/SGST/IGST breakdown for a taxable amount.
 *
 * Intra-state (sameState=true):  CGST = totalGST/2, SGST = totalGST/2, IGST = 0
 * Inter-state (sameState=false): CGST = 0, SGST = 0, IGST = totalGST
 *
 * totalGstPaise is rounded to the nearest paise, then split; on an odd
 * total, SGST absorbs the extra paise (arbitrary but deterministic —
 * never a phantom fractional paise).
 *
 * @param {{ taxableAmountPaise: number, gstRate: number, sameState: boolean }} params
 * @returns {{ cgstPaise: number, sgstPaise: number, igstPaise: number, totalGstPaise: number }}
 */
function computeGST({ taxableAmountPaise, gstRate, sameState }) {
  if (!Number.isInteger(taxableAmountPaise) || taxableAmountPaise < 0) {
    throw new DomainInputError("taxableAmountPaise must be a non-negative integer", {
      field: "taxableAmountPaise",
    });
  }
  if (typeof gstRate !== "number" || gstRate < 0 || gstRate > 28) {
    throw new DomainInputError("gstRate must be a number between 0 and 28", { field: "gstRate" });
  }
  if (typeof sameState !== "boolean") {
    throw new DomainInputError("sameState must be a boolean", { field: "sameState" });
  }

  const totalGstPaise = Math.round((taxableAmountPaise * gstRate) / 100);

  if (sameState) {
    const half = Math.floor(totalGstPaise / 2);
    const remainder = totalGstPaise - half;
    return { cgstPaise: half, sgstPaise: remainder, igstPaise: 0, totalGstPaise };
  }
  return { cgstPaise: 0, sgstPaise: 0, igstPaise: totalGstPaise, totalGstPaise };
}

/**
 * Rounds a grand total to the nearest whole rupee (Indian invoice
 * standard — 0.50 rounds up).
 *
 * @param {number} grandTotalPaise
 * @returns {{ roundOffPaise: number, netPayablePaise: number }}
 */
function computeRoundOff(grandTotalPaise) {
  if (!Number.isInteger(grandTotalPaise)) {
    throw new DomainInputError("grandTotalPaise must be integer", { field: "grandTotalPaise" });
  }
  const netPayableRupees = Math.round(grandTotalPaise / 100);
  const netPayablePaise = netPayableRupees * 100;
  const roundOffPaise = netPayablePaise - grandTotalPaise;
  return { roundOffPaise, netPayablePaise };
}

/**
 * Whether GST is intra-state (same) or inter-state (different) between
 * a customer and the tenant. Missing state codes default to intra-state
 * — safer for tax compliance than silently assuming inter-state when we
 * genuinely don't know.
 *
 * @param {?string} customerStateCode
 * @param {?string} tenantStateCode
 * @returns {boolean}
 */
function isSameState(customerStateCode, tenantStateCode) {
  if (!customerStateCode || !tenantStateCode) return true;
  return customerStateCode.toUpperCase() === tenantStateCode.toUpperCase();
}

module.exports = { computeGST, computeRoundOff, isSameState, DomainInputError };
