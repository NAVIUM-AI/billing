import { useNavigate } from "react-router-dom";

import { aggregateAgingByCustomer } from "@/features/reports/reports.api";
import { useReceivablesAging } from "@/features/reports/reports.hooks";
import { formatPaiseAsRupees } from "@/lib/money";
import { cn } from "@/lib/utils";

export function TopCustomersByOutstandingWidget() {
  const navigate = useNavigate();
  // Same queryKey as ReceivablesAgingWidget's own useReceivablesAging()
  // call — TanStack Query dedupes this into a single network request
  // when both widgets are mounted together on the dashboard.
  const { data: report, isLoading } = useReceivablesAging();

  // aggregateAgingByCustomer's own sort (worst 90+ offenders first) is
  // right for the full aging report page, but this widget's own spec
  // asks for total-outstanding-desc — re-sorted here rather than
  // changing the shared helper's behavior for AgingReportScreen.
  const rows = report
    ? [...aggregateAgingByCustomer(report)].sort((a, b) => b.total_paise - a.total_paise).slice(0, 5)
    : [];

  return (
    <div className="rounded-lg border bg-white p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-gray-900">Top 5 outstanding</h2>
      <p className="mt-0.5 text-xs text-gray-500">Customers with highest amount owed</p>

      <div className="mt-4">
        {isLoading &&
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 border-b py-2.5 last:border-0">
              <div className="h-4 w-4 animate-pulse rounded bg-gray-200" />
              <div className="h-4 flex-1 animate-pulse rounded bg-gray-200" />
              <div className="h-4 w-16 animate-pulse rounded bg-gray-200" />
            </div>
          ))}

        {!isLoading && rows.length === 0 && (
          <p className="py-6 text-center text-sm text-gray-500">🎉 All customers paid up</p>
        )}

        {!isLoading &&
          rows.map((row, i) => (
            <div key={row.customer_id} className="flex items-center gap-3 border-b py-2.5 text-sm last:border-0">
              <span className="w-4 shrink-0 text-gray-400">{i + 1}</span>
              <button
                type="button"
                onClick={() => navigate(`/customers/${row.customer_id}/ledger`)}
                className="flex-1 truncate text-left font-bold text-gray-900 hover:text-primary-600 hover:underline"
              >
                {row.customer_name || "—"}
              </button>
              <span className={cn("font-medium", row.byBucket.DAYS_90_PLUS > 0 ? "text-red-600" : "text-gray-700")}>
                {formatPaiseAsRupees(row.total_paise)}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}
