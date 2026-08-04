/**
 * Reporting API layer. Aging is invoice-level on the wire
 * (payment.service.js#getReceivablesAging) — see types/aging.ts's top
 * comment for why the per-customer table this screen shows is an
 * aggregation built here, not a shape the backend returns directly.
 */
import { apiClient } from "@/lib/api";
import { agingReportResponseSchema } from "@/lib/schemas/aging";
import { AGING_BUCKET_NAMES, type AgingBucketName, type AgingReport, type CustomerAgingRow } from "@/types/aging";

export async function getReceivablesAging(asOfDate?: string): Promise<AgingReport> {
  const res = await apiClient.get("/reports/receivables-aging", { params: { as_of_date: asOfDate || undefined } });
  return agingReportResponseSchema.parse(res.data) as AgingReport;
}

export function aggregateAgingByCustomer(report: AgingReport): CustomerAgingRow[] {
  const rowsByCustomer = new Map<string, CustomerAgingRow>();

  for (const bucketName of AGING_BUCKET_NAMES) {
    for (const entry of report.buckets[bucketName].entries) {
      let row = rowsByCustomer.get(entry.customer_id);
      if (!row) {
        row = {
          customer_id: entry.customer_id,
          customer_name: entry.customer_name,
          byBucket: { CURRENT: 0, DAYS_1_30: 0, DAYS_31_60: 0, DAYS_61_90: 0, DAYS_90_PLUS: 0 },
          total_paise: 0,
        };
        rowsByCustomer.set(entry.customer_id, row);
      }
      row.byBucket[bucketName as AgingBucketName] += entry.outstanding_paise;
      row.total_paise += entry.outstanding_paise;
    }
  }

  // Worst offenders on top — sorted by the 90+ column desc, per spec.
  return [...rowsByCustomer.values()].sort((a, b) => b.byBucket.DAYS_90_PLUS - a.byBucket.DAYS_90_PLUS);
}

function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

// No backend CSV export endpoint (Part A confirmation, same as F3's
// tripSheets export) — built client-side from the already-fetched
// per-customer aggregation.
export function agingRowsToCsv(rows: CustomerAgingRow[]): { blob: Blob; filename: string } {
  const header = ["Customer", "Current", "1-30 Days", "31-60 Days", "61-90 Days", "90+ Days", "Total Outstanding"];
  const lines = [
    header.map(csvEscape).join(","),
    ...rows.map((r) =>
      [
        r.customer_name,
        (r.byBucket.CURRENT / 100).toFixed(2),
        (r.byBucket.DAYS_1_30 / 100).toFixed(2),
        (r.byBucket.DAYS_31_60 / 100).toFixed(2),
        (r.byBucket.DAYS_61_90 / 100).toFixed(2),
        (r.byBucket.DAYS_90_PLUS / 100).toFixed(2),
        (r.total_paise / 100).toFixed(2),
      ]
        .map(csvEscape)
        .join(","),
    ),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const dateStr = new Date().toISOString().slice(0, 10);
  return { blob, filename: `receivables-aging-${dateStr}.csv` };
}
