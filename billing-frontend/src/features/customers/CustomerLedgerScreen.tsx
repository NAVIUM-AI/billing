import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { useLedger } from "@/features/payments/payments.hooks";
import { PAYMENT_MODE_LABELS } from "@/types/payment";
import { formatPaiseAsRupees } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { LedgerEntry } from "@/types/ledger";

function entryDate(entry: LedgerEntry): string {
  return entry.type === "INVOICE" ? entry.invoice_date : entry.received_at;
}

function TypeBadge({ entry }: { entry: LedgerEntry }) {
  if (entry.type === "INVOICE") {
    return (
      <span
        className={cn(
          "rounded px-1.5 py-0.5 text-xs font-medium",
          entry.status === "CANCELLED" ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-700",
        )}
      >
        Invoice
      </span>
    );
  }
  // A PAYMENT entry with no invoice_id is an unallocated advance —
  // payment.service.js's own convention (see types/ledger.ts's comment),
  // not a distinct wire type.
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-xs font-medium",
        entry.invoice_id ? "bg-green-100 text-green-700" : "bg-purple-100 text-purple-700",
      )}
    >
      {entry.invoice_id ? "Payment" : "Advance"}
    </span>
  );
}

export function CustomerLedgerScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = useLedger(id);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  // No date-range query params exist on GET /customers/:id/ledger
  // (Part A confirmed) — filtered client-side over the full,
  // already-fetched entry list.
  const entries = (data?.entries ?? []).filter((entry) => {
    const d = entryDate(entry);
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  });

  const customerLabel = data ? (data.customer.customer_type === "B2B" ? data.customer.company_name : data.customer.name) : "";

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={isLoading ? "Loading..." : `${customerLabel} — Ledger`}
        description="Chronological statement of invoices, payments, and advances"
        action={
          data && (
            <span
              className={cn(
                "rounded-full px-3 py-1.5 text-sm font-semibold",
                data.summary.outstanding_paise > 0 ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800",
              )}
            >
              {formatPaiseAsRupees(data.summary.outstanding_paise)} outstanding
            </span>
          )
        }
      />

      {data && (
        <div className="mb-4 grid grid-cols-4 gap-3">
          <SummaryStat label="Total Invoiced" value={data.summary.total_invoiced_paise} />
          <SummaryStat label="Total Paid" value={data.summary.total_paid_paise} />
          <SummaryStat label="Unallocated Advance" value={data.summary.unallocated_advance_paise} />
          <SummaryStat label="Outstanding" value={data.summary.outstanding_paise} highlight />
        </div>
      )}

      <div className="mb-4 flex items-center gap-3">
        <label className="text-sm text-gray-500">
          From{" "}
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="ml-1.5 h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </label>
        <label className="text-sm text-gray-500">
          To{" "}
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="ml-1.5 h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </label>
      </div>

      <div className="overflow-hidden rounded-md border bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left text-gray-500">
              <th className="px-4 py-2.5 font-medium">Date</th>
              <th className="px-4 py-2.5 font-medium">Type</th>
              <th className="px-4 py-2.5 font-medium">Reference</th>
              <th className="px-4 py-2.5 text-right font-medium">Debit</th>
              <th className="px-4 py-2.5 text-right font-medium">Credit</th>
              <th className="px-4 py-2.5 text-right font-medium">Balance</th>
            </tr>
          </thead>
          <tbody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td colSpan={6} className="px-4 py-3">
                    <div className="h-4 w-full animate-pulse rounded bg-gray-200" />
                  </td>
                </tr>
              ))}
            {!isLoading &&
              entries.map((entry, i) => {
                const isInvoice = entry.type === "INVOICE";
                const reference = isInvoice ? entry.invoice_number : entry.reference_number || PAYMENT_MODE_LABELS[entry.payment_mode];
                const targetInvoiceId = isInvoice ? entry.invoice_id : entry.invoice_id;
                return (
                  <tr key={`${entry.type}-${i}`} className="border-b last:border-0">
                    <td className="px-4 py-3 text-gray-600">{new Date(entryDate(entry)).toLocaleDateString()}</td>
                    <td className="px-4 py-3">
                      <TypeBadge entry={entry} />
                    </td>
                    <td className="px-4 py-3">
                      {targetInvoiceId ? (
                        <button
                          type="button"
                          onClick={() => navigate(`/invoices/${targetInvoiceId}`)}
                          className="font-medium text-gray-900 hover:text-primary-600 hover:underline"
                        >
                          {reference || "—"}
                        </button>
                      ) : (
                        <span className="text-gray-900">{reference || "—"}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-900">
                      {isInvoice && entry.debit_paise > 0 ? formatPaiseAsRupees(entry.debit_paise) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-900">
                      {!isInvoice ? formatPaiseAsRupees(entry.credit_paise) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      {formatPaiseAsRupees(entry.running_balance_paise)}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
        {!isLoading && entries.length === 0 && (
          <div className="border-t">
            <EmptyState title="No ledger entries" description="This customer has no invoices or payments yet." />
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryStat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</div>
      <div className={cn("mt-1 text-lg font-semibold", highlight ? "text-amber-700" : "text-gray-900")}>
        {formatPaiseAsRupees(value)}
      </div>
    </div>
  );
}
