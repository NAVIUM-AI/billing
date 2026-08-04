import { computeGST, computeRoundOff } from "@/features/invoices/gstCalc";
import { formatPaiseAsRupees } from "@/lib/money";
import type { InvoiceableTrip, InvoiceType } from "@/types/invoice";

interface InvoiceSummaryProps {
  selectedTrips: InvoiceableTrip[];
  invoiceType: InvoiceType;
  gstRate: number | undefined;
  sameState: boolean;
}

// Client-side preview only (Rule 10: backend recomputes on save and is
// the source of truth) — see gstCalc.ts's top comment.
export function InvoiceSummary({ selectedTrips, invoiceType, gstRate, sameState }: InvoiceSummaryProps) {
  const taxableAmountPaise = selectedTrips.reduce((sum, t) => sum + t.subtotal_paise, 0);
  const tollPaise = selectedTrips.reduce((sum, t) => sum + t.toll_paise, 0);
  const parkingPaise = selectedTrips.reduce((sum, t) => sum + t.parking_paise, 0);
  const permitPaise = selectedTrips.reduce((sum, t) => sum + t.permit_paise, 0);
  const fasttagPaise = selectedTrips.reduce((sum, t) => sum + t.fasttag_paise, 0);
  const reimbursementsPaise = tollPaise + parkingPaise + permitPaise + fasttagPaise;

  const gst =
    invoiceType === "TAX" && gstRate != null
      ? computeGST({ taxableAmountPaise, gstRate, sameState })
      : { cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalGstPaise: 0 };

  const grandTotalPaise = taxableAmountPaise + gst.totalGstPaise + reimbursementsPaise;
  const { roundOffPaise, netPayablePaise } = computeRoundOff(grandTotalPaise);

  return (
    <div className="sticky top-4 rounded-lg border bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold text-gray-700">Invoice Summary</h3>
      <div className="flex flex-col gap-2 text-sm">
        <Row label="Total Taxable" value={taxableAmountPaise} />
        {invoiceType === "TAX" && (
          <>
            {sameState ? (
              <>
                <Row label="CGST" value={gst.cgstPaise} muted />
                <Row label="SGST" value={gst.sgstPaise} muted />
              </>
            ) : (
              <Row label="IGST" value={gst.igstPaise} muted />
            )}
          </>
        )}
        {reimbursementsPaise > 0 && <Row label="Toll / Parking / Permit / Fasttag" value={reimbursementsPaise} muted />}
        <Row label="Round Off" value={roundOffPaise} muted />
        <div className="mt-2 flex justify-between border-t pt-2 text-base font-semibold">
          <span className="text-gray-900">Net Payable</span>
          <span className="text-primary-700">{formatPaiseAsRupees(netPayablePaise)}</span>
        </div>
      </div>
      {selectedTrips.length === 0 && (
        <p className="mt-3 text-xs text-gray-400">Select trips below to see live totals.</p>
      )}
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={muted ? "flex justify-between text-gray-500" : "flex justify-between text-gray-700"}>
      <span>{label}</span>
      <span>{formatPaiseAsRupees(value)}</span>
    </div>
  );
}
