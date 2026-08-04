import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AxiosError } from "axios";

import { DataTable, type DataTableColumn } from "@/components/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { SearchInput } from "@/components/SearchInput";
import { CancelPaymentDialog } from "@/features/payments/CancelPaymentDialog";
import { useCancelPayment, usePayments } from "@/features/payments/payments.hooks";
import { useCustomers } from "@/features/customers/customers.hooks";
import { useInvoices } from "@/features/invoices/invoices.hooks";
import { formatPaiseAsRupees } from "@/lib/money";
import { cn } from "@/lib/utils";
import { PAYMENT_MODES, PAYMENT_MODE_LABELS, type Payment, type PaymentFilters, type PaymentMode } from "@/types/payment";
import type { ApiErrorResponse } from "@/types/api";

const STATUS_FILTERS: { label: string; value: string | undefined }[] = [
  { label: "Recorded", value: "RECORDED" },
  { label: "Cancelled", value: "CANCELLED" },
  { label: "All", value: "RECORDED,CANCELLED" },
];

function extractApiMessage(err: unknown): string {
  if (err instanceof AxiosError) {
    return (err.response?.data as ApiErrorResponse | undefined)?.error?.message || "Something went wrong.";
  }
  return "Cannot reach server. Try again.";
}

export function PaymentsListScreen() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<PaymentMode | undefined>(undefined);
  const [customerId, setCustomerId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>("RECORDED");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const filters: PaymentFilters = {
    payment_mode: mode,
    customer_id: customerId,
    status,
    from_date: dateFrom || undefined,
    to_date: dateTo || undefined,
    limit: 100,
    offset: 0,
  };
  const { data, isLoading } = usePayments(filters);
  const cancelPayment = useCancelPayment();

  // Payment rows only carry customer_id/invoice_id (raw `payments`
  // columns — no join). Neither GET /payments nor GET /credit-notes
  // enriches with display names server-side, so both are joined
  // client-side against a fetched id->label map, same pattern.
  const { data: customersData } = useCustomers({ limit: 100, offset: 0 });
  const { data: invoicesData } = useInvoices({ limit: 200, offset: 0 });
  const customerMap = new Map((customersData?.customers ?? []).map((c) => [c.id, c.customer_type === "B2B" ? c.company_name : c.name]));
  const invoiceMap = new Map((invoicesData?.invoices ?? []).map((i) => [i.id, i.invoice_number]));

  const rows = (data?.payments ?? []).filter((p) => {
    if (!search) return true;
    return p.reference_number?.toLowerCase().includes(search.toLowerCase());
  });

  async function handleCancel(reason: string) {
    if (!cancellingId) return;
    try {
      await cancelPayment.mutateAsync({ paymentId: cancellingId, reason });
      toast.success("Payment cancelled");
      setCancellingId(null);
    } catch (err) {
      toast.error(extractApiMessage(err));
    }
  }

  const columns: DataTableColumn<Payment>[] = [
    { key: "received_at", label: "Date", render: (p) => new Date(p.received_at).toLocaleDateString() },
    { key: "customer", label: "Customer", render: (p) => customerMap.get(p.customer_id) || "—" },
    {
      key: "invoice",
      label: "Invoice #",
      render: (p) => (p.invoice_id ? invoiceMap.get(p.invoice_id) || "—" : <span className="text-purple-600">Advance</span>),
    },
    { key: "payment_mode", label: "Mode", render: (p) => PAYMENT_MODE_LABELS[p.payment_mode] },
    { key: "reference_number", label: "Reference", render: (p) => p.reference_number || "—" },
    { key: "amount_paise", label: "Amount", render: (p) => formatPaiseAsRupees(p.amount_paise) },
    {
      key: "status",
      label: "Status",
      render: (p) => (
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-xs font-medium",
            p.status === "RECORDED" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700",
          )}
        >
          {p.status}
        </span>
      ),
    },
    {
      key: "actions",
      label: "",
      className: "w-20 text-right",
      render: (p) =>
        p.status === "RECORDED" ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setCancellingId(p.id);
            }}
            className="text-xs font-medium text-red-600 hover:underline"
          >
            Cancel
          </button>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader title="Payments" description="All payments and advances recorded across customers" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput placeholder="Search by reference..." onDebouncedChange={setSearch} className="w-64" />
        <div className="flex gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.label}
              type="button"
              onClick={() => setStatus(f.value)}
              className={cn(
                "rounded-full border px-3 py-1 text-sm font-medium transition-colors",
                status === f.value
                  ? "border-primary-500 bg-primary-50 text-primary-700"
                  : "border-gray-300 text-gray-600 hover:bg-gray-50",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={mode ?? ""}
          onChange={(e) => setMode((e.target.value || undefined) as PaymentMode | undefined)}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">All modes</option>
          {PAYMENT_MODES.map((m) => (
            <option key={m} value={m}>
              {PAYMENT_MODE_LABELS[m]}
            </option>
          ))}
        </select>
        <select
          value={customerId ?? ""}
          onChange={(e) => setCustomerId(e.target.value || undefined)}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">All customers</option>
          {customersData?.customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.customer_type === "B2B" ? c.company_name : c.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="From date"
        />
        <span className="text-sm text-gray-400">to</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="To date"
        />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(p) => p.id}
        loading={isLoading}
        onRowClick={(p) => p.invoice_id && navigate(`/invoices/${p.invoice_id}`)}
        emptyMessage="No payments yet"
        emptyDescription="Payments recorded against invoices will show up here."
      />

      <CancelPaymentDialog
        open={Boolean(cancellingId)}
        onOpenChange={(open) => !open && setCancellingId(null)}
        onConfirm={handleCancel}
        isLoading={cancelPayment.isPending}
      />
    </div>
  );
}
