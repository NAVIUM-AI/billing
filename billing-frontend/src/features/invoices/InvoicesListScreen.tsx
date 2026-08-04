import { Plus } from "lucide-react";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { DataTable, type DataTableColumn } from "@/components/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { SearchInput } from "@/components/SearchInput";
import { Button } from "@/components/ui/button";
import { useCustomers } from "@/features/customers/customers.hooks";
import { InvoiceStatusBadge } from "@/features/invoices/components/InvoiceStatusBadge";
import { useInvoices } from "@/features/invoices/invoices.hooks";
import { TRIP_SERVICE_TYPES, TRIP_SERVICE_TYPE_LABELS } from "@/lib/constants/enums";
import { formatPaiseAsRupees } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { TripServiceType } from "@/lib/constants/enums";
import type { InvoiceFilters, InvoiceListRow, InvoiceStatus, InvoiceType } from "@/types/invoice";

const STATUS_FILTERS: { label: string; value: InvoiceStatus | undefined }[] = [
  { label: "All", value: undefined },
  { label: "Draft", value: "DRAFT" },
  { label: "Issued", value: "ISSUED" },
  { label: "Paid", value: "PAID" },
  { label: "Cancelled", value: "CANCELLED" },
];

const TYPE_FILTERS: { label: string; value: InvoiceType | undefined }[] = [
  { label: "All", value: undefined },
  { label: "GST", value: "TAX" },
  { label: "Proforma", value: "PERFORMANCE" },
];

const SERVICE_TYPE_FILTERS: { label: string; value: TripServiceType | undefined }[] = [
  { label: "All", value: undefined },
  ...TRIP_SERVICE_TYPES.map((t) => ({ label: TRIP_SERVICE_TYPE_LABELS[t], value: t })),
];

function ChipGroup<T extends string | undefined>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex gap-1.5">
      {options.map((opt) => (
        <button
          key={opt.label}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "rounded-full border px-3 py-1 text-sm font-medium transition-colors",
            value === opt.value
              ? "border-primary-500 bg-primary-50 text-primary-700"
              : "border-gray-300 text-gray-600 hover:bg-gray-50",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function InvoiceTypeBadge({ type }: { type: InvoiceType }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-xs font-medium",
        type === "TAX" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700",
      )}
    >
      {type === "TAX" ? "GST" : "Proforma"}
    </span>
  );
}

// Shape of the location.state the dashboard's RevenueThisMonthWidget
// navigates here with — a plain object, not a route/query param, per
// this task's own "pick what fits your existing pattern" allowance.
interface InvoicesNavFilters {
  date_from?: string;
  date_to?: string;
}

export function InvoicesListScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const navFilters = (location.state as InvoicesNavFilters | null) ?? null;

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<InvoiceStatus | undefined>(undefined);
  const [invoiceType, setInvoiceType] = useState<InvoiceType | undefined>(undefined);
  const [serviceType, setServiceType] = useState<TripServiceType | undefined>(undefined);
  const [customerId, setCustomerId] = useState<string | undefined>(undefined);
  const [dateFrom, setDateFrom] = useState(navFilters?.date_from ?? "");
  const [dateTo, setDateTo] = useState(navFilters?.date_to ?? "");

  const filters: InvoiceFilters = {
    search: search || undefined,
    status,
    invoice_type: invoiceType,
    service_type: serviceType,
    customer_id: customerId,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    limit: 50,
    offset: 0,
  };
  const { data, isLoading } = useInvoices(filters);
  // Backend caps GET /customers at 100 (customer.validator.js) — 200
  // here was a real bug (400 VALIDATION_ERROR on every list-page load,
  // silently breaking the customer filter dropdown), caught only by
  // actually running the smoke test, not by inspection.
  const { data: customersData } = useCustomers({ limit: 100, offset: 0 });

  const columns: DataTableColumn<InvoiceListRow>[] = [
    {
      key: "invoice_number",
      label: "Invoice #",
      render: (i) => (
        <button
          type="button"
          onClick={() => navigate(`/invoices/${i.id}`)}
          className="font-medium text-gray-900 hover:text-primary-600 hover:underline"
        >
          {i.invoice_number || "Draft"}
        </button>
      ),
    },
    { key: "invoice_date", label: "Date" },
    { key: "customer_name", label: "Customer", render: (i) => i.customer_name || "—" },
    { key: "invoice_type", label: "Type", render: (i) => <InvoiceTypeBadge type={i.invoice_type} /> },
    {
      key: "service_type",
      label: "Service Type",
      render: (i) => (i.service_type ? TRIP_SERVICE_TYPE_LABELS[i.service_type] : "—"),
    },
    { key: "gross_amount_paise", label: "Amount", render: (i) => formatPaiseAsRupees(i.gross_amount_paise) },
    { key: "status", label: "Status", render: (i) => <InvoiceStatusBadge status={i.status} /> },
  ];

  return (
    <div>
      <PageHeader
        title="Invoices"
        description="Manage GST and proforma invoices"
        action={
          <Button onClick={() => navigate("/invoices/new")} className="bg-primary-500 hover:bg-primary-600">
            <Plus className="h-4 w-4" />
            New Invoice
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput placeholder="Search by invoice number..." onDebouncedChange={setSearch} className="w-64" />
        <ChipGroup options={STATUS_FILTERS} value={status} onChange={setStatus} />
        <ChipGroup options={TYPE_FILTERS} value={invoiceType} onChange={setInvoiceType} />
        <ChipGroup options={SERVICE_TYPE_FILTERS} value={serviceType} onChange={setServiceType} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
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
        rows={data?.invoices ?? []}
        rowKey={(i) => i.id}
        loading={isLoading}
        onRowClick={(i) => navigate(`/invoices/${i.id}`)}
        emptyMessage="No invoices yet"
        emptyDescription="Create your first invoice from a customer's finalized trips."
        emptyAction={
          <Button onClick={() => navigate("/invoices/new")} className="bg-primary-500 hover:bg-primary-600">
            <Plus className="h-4 w-4" />
            New Invoice
          </Button>
        }
      />
    </div>
  );
}
