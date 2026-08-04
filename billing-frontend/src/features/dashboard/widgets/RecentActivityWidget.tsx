import { formatDistanceToNow } from "date-fns";
import { FileText, Receipt } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useInvoices } from "@/features/invoices/invoices.hooks";
import { useTripSheets } from "@/features/tripSheets/tripSheets.hooks";
import { formatPaiseAsRupees } from "@/lib/money";

type ActivityEvent =
  | { type: "invoice"; id: string; timestamp: string; invoiceNumber: string | null; customerName: string | null; amountPaise: number }
  | { type: "trip"; id: string; timestamp: string; tripNumber: string; vehicleNumber: string };

// tripSheet.repository.js#list has no `finalized_at` entry in its own
// SORT_WHITELIST (only trip_date/created_at/total_km/net_payable_paise
// — Part A finding), so "recent trips" is the default trip_date-desc
// order rather than a true finalized_at sort; invoices similarly have
// no `sort` param at all (fixed invoice_date DESC, created_at DESC).
// Both are close enough proxies for "just happened" since finalize/
// issue happen same-day as trip_date/invoice_date in normal use.
export function RecentActivityWidget() {
  const navigate = useNavigate();
  const invoices = useInvoices({ status: "ISSUED", limit: 5, offset: 0 });
  const trips = useTripSheets({ status: ["FINALIZED"], limit: 5, offset: 0 });

  const isLoading = invoices.isLoading || trips.isLoading;

  const events: ActivityEvent[] = [
    ...(invoices.data?.invoices ?? []).map(
      (i): ActivityEvent => ({
        type: "invoice",
        id: i.id,
        timestamp: i.issued_at ?? i.invoice_date,
        invoiceNumber: i.invoice_number,
        customerName: i.customer_name,
        amountPaise: i.gross_amount_paise,
      }),
    ),
    ...(trips.data?.trips ?? []).map(
      (t): ActivityEvent => ({
        type: "trip",
        id: t.id,
        timestamp: t.finalized_at ?? t.trip_date,
        tripNumber: t.trip_sheet_number,
        vehicleNumber: t.snapshot_vehicle_number,
      }),
    ),
  ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return (
    <div className="rounded-lg border bg-white p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-gray-900">Recent activity</h2>

      <div className="mt-4">
        {isLoading &&
          Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 border-b py-2.5 last:border-0">
              <div className="h-4 w-4 animate-pulse rounded bg-gray-200" />
              <div className="h-4 flex-1 animate-pulse rounded bg-gray-200" />
              <div className="h-4 w-16 animate-pulse rounded bg-gray-200" />
            </div>
          ))}

        {!isLoading && events.length === 0 && (
          <p className="py-6 text-center text-sm text-gray-500">No recent activity</p>
        )}

        {!isLoading &&
          events.map((event) => (
            <button
              key={`${event.type}-${event.id}`}
              type="button"
              onClick={() => navigate(event.type === "invoice" ? `/invoices/${event.id}` : `/trips/${event.id}`)}
              className="flex w-full items-center gap-3 border-b py-2.5 text-left text-sm last:border-0 hover:bg-accent-50"
            >
              {event.type === "invoice" ? (
                <Receipt className="h-4 w-4 shrink-0 text-primary-500" />
              ) : (
                <FileText className="h-4 w-4 shrink-0 text-gray-400" />
              )}

              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-gray-900">
                  {event.type === "invoice"
                    ? `${event.invoiceNumber || "Invoice"} issued to ${event.customerName || "customer"}`
                    : `${event.tripNumber} finalized`}
                </div>
                <div className="text-xs text-gray-400">
                  {formatDistanceToNow(new Date(event.timestamp), { addSuffix: true })}
                </div>
              </div>

              <span className="shrink-0 text-right text-gray-600">
                {event.type === "invoice" ? formatPaiseAsRupees(event.amountPaise) : event.vehicleNumber}
              </span>
            </button>
          ))}
      </div>
    </div>
  );
}
