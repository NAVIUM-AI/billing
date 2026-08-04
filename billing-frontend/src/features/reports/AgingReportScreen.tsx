import { Download } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { aggregateAgingByCustomer } from "@/features/reports/reports.api";
import { useExportAgingCsv, useReceivablesAging } from "@/features/reports/reports.hooks";
import { formatPaiseAsRupees } from "@/lib/money";
import { cn } from "@/lib/utils";
import { AGING_BUCKET_LABELS, AGING_BUCKET_NAMES } from "@/types/aging";

// Green -> yellow -> orange -> red as invoices age; Current stays
// neutral (not yet overdue, nothing to flag).
const BUCKET_COLORS: Record<string, string> = {
  CURRENT: "text-gray-600",
  DAYS_1_30: "text-green-600",
  DAYS_31_60: "text-amber-600",
  DAYS_61_90: "text-orange-600",
  DAYS_90_PLUS: "text-red-600",
};

export function AgingReportScreen() {
  const navigate = useNavigate();
  const { data: report, isLoading } = useReceivablesAging();
  const exportCsv = useExportAgingCsv();

  const customerRows = report ? aggregateAgingByCustomer(report) : [];

  return (
    <div>
      <PageHeader
        title="Receivables Aging"
        description={report ? `As of ${report.as_of_date}` : undefined}
        action={
          <Button
            variant="secondary"
            disabled={customerRows.length === 0 || exportCsv.isPending}
            onClick={() => exportCsv.mutate(customerRows)}
          >
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        }
      />

      {isLoading && <p className="text-sm text-gray-500">Loading...</p>}

      {report && (
        <>
          <div className="mb-6 grid grid-cols-5 gap-3">
            {AGING_BUCKET_NAMES.map((bucket) => (
              <div key={bucket} className="rounded-lg border bg-white p-4 text-center">
                <div className="text-xs font-medium uppercase tracking-wide text-gray-400">
                  {AGING_BUCKET_LABELS[bucket]}
                </div>
                <div className={cn("mt-1 text-xl font-bold", BUCKET_COLORS[bucket])}>
                  {formatPaiseAsRupees(report.summary.buckets_summary[bucket]?.total_paise ?? 0)}
                </div>
                <div className="text-xs text-gray-400">{report.summary.buckets_summary[bucket]?.count ?? 0} invoices</div>
              </div>
            ))}
          </div>

          <div className="overflow-hidden rounded-md border bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50 text-left text-gray-500">
                  <th className="px-4 py-2.5 font-medium">Customer</th>
                  {AGING_BUCKET_NAMES.map((bucket) => (
                    <th key={bucket} className="px-4 py-2.5 text-right font-medium">
                      {AGING_BUCKET_LABELS[bucket]}
                    </th>
                  ))}
                  <th className="px-4 py-2.5 text-right font-medium">Total Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {customerRows.map((row) => (
                  <tr key={row.customer_id} className="border-b last:border-0">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => navigate(`/customers/${row.customer_id}/ledger`)}
                        className="font-medium text-gray-900 hover:text-primary-600 hover:underline"
                      >
                        {row.customer_name || "—"}
                      </button>
                    </td>
                    {AGING_BUCKET_NAMES.map((bucket) => (
                      <td key={bucket} className="px-4 py-3 text-right text-gray-700">
                        {row.byBucket[bucket] > 0 ? formatPaiseAsRupees(row.byBucket[bucket]) : "—"}
                      </td>
                    ))}
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">
                      {formatPaiseAsRupees(row.total_paise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {customerRows.length === 0 && (
              <div className="border-t">
                <EmptyState title="No outstanding invoices" description="Every issued invoice has been fully paid." />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
