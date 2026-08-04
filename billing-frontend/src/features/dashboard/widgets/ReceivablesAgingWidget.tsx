import { useNavigate } from "react-router-dom";

import { useReceivablesAging } from "@/features/reports/reports.hooks";
import { formatPaiseAsRupees } from "@/lib/money";
import { cn } from "@/lib/utils";
import { AGING_BUCKET_LABELS, AGING_BUCKET_NAMES } from "@/types/aging";

// Tint per bucket per Part D's spec — background + a matching border,
// severity increasing left to right.
const BUCKET_STYLES: Record<string, string> = {
  CURRENT: "bg-green-50 border-green-200",
  DAYS_1_30: "bg-yellow-50 border-yellow-200",
  DAYS_31_60: "bg-orange-50 border-orange-200",
  DAYS_61_90: "bg-orange-100 border-orange-300",
  DAYS_90_PLUS: "bg-red-50 border-red-200",
};

export function ReceivablesAgingWidget() {
  const navigate = useNavigate();
  const { data: report, isLoading } = useReceivablesAging();

  const totalOutstanding = report?.summary.total_outstanding_paise ?? 0;

  return (
    <div className="rounded-lg border bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Receivables</h2>
        <button
          type="button"
          onClick={() => navigate("/reports/aging")}
          className="text-sm font-medium text-primary-600 hover:underline"
        >
          View full report →
        </button>
      </div>

      {isLoading && (
        <div className="grid grid-cols-5 gap-3">
          {AGING_BUCKET_NAMES.map((bucket) => (
            <div key={bucket} className="h-20 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      )}

      {!isLoading && report && totalOutstanding === 0 && (
        <p className="py-6 text-center text-sm text-gray-500">🎉 No outstanding invoices</p>
      )}

      {!isLoading && report && totalOutstanding > 0 && (
        <>
          <div className="grid grid-cols-5 gap-3">
            {AGING_BUCKET_NAMES.map((bucket) => (
              <div key={bucket} className={cn("rounded-lg border p-3 text-center", BUCKET_STYLES[bucket])}>
                <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
                  {AGING_BUCKET_LABELS[bucket]}
                </div>
                <div className="mt-1 text-base font-bold text-gray-900">
                  {formatPaiseAsRupees(report.summary.buckets_summary[bucket]?.total_paise ?? 0)}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 border-t pt-3 text-sm text-gray-700">
            Total outstanding: <span className="font-bold text-gray-900">{formatPaiseAsRupees(totalOutstanding)}</span>
          </div>
        </>
      )}
    </div>
  );
}
