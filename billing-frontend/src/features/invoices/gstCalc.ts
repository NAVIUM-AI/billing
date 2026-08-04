/**
 * Client-side mirror of billing-backend/src/domain/gst/index.js, used
 * ONLY for the wizard's live summary preview — the backend recomputes
 * everything from scratch on create/issue and is the source of truth
 * (same "manual mirror, no shared package" convention as
 * lib/constants/enums.ts). Do not reuse this for anything that gets
 * persisted.
 */

export function computeGST({
  taxableAmountPaise,
  gstRate,
  sameState,
}: {
  taxableAmountPaise: number;
  gstRate: number;
  sameState: boolean;
}) {
  const totalGstPaise = Math.round((taxableAmountPaise * gstRate) / 100);
  if (sameState) {
    const half = Math.floor(totalGstPaise / 2);
    const remainder = totalGstPaise - half;
    return { cgstPaise: half, sgstPaise: remainder, igstPaise: 0, totalGstPaise };
  }
  return { cgstPaise: 0, sgstPaise: 0, igstPaise: totalGstPaise, totalGstPaise };
}

export function computeRoundOff(grandTotalPaise: number) {
  const netPayableRupees = Math.round(grandTotalPaise / 100);
  const netPayablePaise = netPayableRupees * 100;
  const roundOffPaise = netPayablePaise - grandTotalPaise;
  return { roundOffPaise, netPayablePaise };
}

export function isSameState(customerStateCode?: string | null, tenantStateCode?: string | null): boolean {
  if (!customerStateCode || !tenantStateCode) return true;
  return customerStateCode.toUpperCase() === tenantStateCode.toUpperCase();
}
