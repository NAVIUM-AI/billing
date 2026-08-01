import { Download, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { DataTable, type DataTableColumn } from "@/components/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { SearchInput } from "@/components/SearchInput";
import { Button } from "@/components/ui/button";
import { useCustomers } from "@/features/customers/customers.hooks";
import { useTripSheets, useExportTripSheetsCsv } from "@/features/tripSheets/tripSheets.hooks";
import { useVehicles } from "@/features/vehicles/vehicles.hooks";
import {
  TRIP_BILLING_MODE_LABELS,
  TRIP_BILLING_MODES,
  TRIP_SERVICE_TYPE_LABELS,
  TRIP_SERVICE_TYPES,
  TRIP_STATUS_LABELS,
  TRIP_STATUSES,
  type TripBillingMode,
  type TripServiceType,
  type TripStatus,
} from "@/lib/constants/enums";
import { formatPaiseAsRupees } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { TripSheetFilters, TripSheetListRow } from "@/types/tripSheet";

type StatusFilter = "ALL" | TripStatus;
const STATUS_FILTERS: { label: string; value: StatusFilter }[] = [
  { label: "All", value: "ALL" },
  ...TRIP_STATUSES.map((s) => ({ label: TRIP_STATUS_LABELS[s], value: s })),
];

function ServiceTypeBadge({ type }: { type: TripServiceType }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-xs font-medium",
        type === "LOCAL" ? "bg-yellow-100 text-yellow-800" : "bg-blue-100 text-blue-700",
      )}
    >
      {TRIP_SERVICE_TYPE_LABELS[type]}
    </span>
  );
}

function BillingModeBadge({ mode }: { mode: TripBillingMode }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-xs font-medium",
        mode === "GST" ? "bg-primary-100 text-primary-700" : "bg-indigo-100 text-indigo-700",
      )}
    >
      {TRIP_BILLING_MODE_LABELS[mode]}
    </span>
  );
}

function StatusBadge({ status }: { status: TripStatus }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-xs font-medium",
        status === "DRAFT" && "bg-gray-200 text-gray-700",
        status === "FINALIZED" && "bg-green-100 text-green-700",
        status === "INVOICED" && "bg-blue-100 text-blue-700",
        status === "CANCELLED" && "bg-red-100 text-red-700",
      )}
    >
      {TRIP_STATUS_LABELS[status]}
    </span>
  );
}

export function TripSheetsListScreen() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [serviceType, setServiceType] = useState<TripServiceType | "ALL">("ALL");
  const [billingMode, setBillingMode] = useState<TripBillingMode | "ALL">("ALL");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [vehicleId, setVehicleId] = useState("");

  const { data: customersData } = useCustomers({ limit: 100 });
  const { data: vehiclesData } = useVehicles({ limit: 100 });

  const filters: TripSheetFilters = {
    search: search || undefined,
    status: status === "ALL" ? undefined : [status],
    includeCancelled: status === "ALL",
    service_type: serviceType === "ALL" ? undefined : serviceType,
    billing_mode: billingMode === "ALL" ? undefined : billingMode,
    from_date: fromDate || undefined,
    to_date: toDate || undefined,
    customer_id: customerId || undefined,
    vehicle_id: vehicleId || undefined,
    limit: 50,
    offset: 0,
  };
  const { data, isLoading } = useTripSheets(filters);
  const exportCsv = useExportTripSheetsCsv();

  async function handleExport() {
    try {
      await exportCsv.mutateAsync(filters);
    } catch {
      toast.error("Failed to export CSV");
    }
  }

  const columns: DataTableColumn<TripSheetListRow>[] = [
    {
      key: "trip_sheet_number",
      label: "Trip #",
      render: (t) => (
        <button
          type="button"
          onClick={() => navigate(`/trips/${t.id}`)}
          className="font-mono font-medium text-gray-900 hover:text-primary-600 hover:underline"
        >
          {t.trip_sheet_number}
        </button>
      ),
    },
    { key: "trip_date", label: "Date" },
    { key: "service_type", label: "Service Type", render: (t) => <ServiceTypeBadge type={t.service_type} /> },
    { key: "billing_mode", label: "Billing Mode", render: (t) => <BillingModeBadge mode={t.billing_mode} /> },
    { key: "customer", label: "Customer", render: (t) => t.snapshot_customer_name || "—" },
    { key: "vehicle", label: "Vehicle", render: (t) => t.snapshot_vehicle_number },
    { key: "amount", label: "Amount", render: (t) => formatPaiseAsRupees(t.net_payable_paise) },
    { key: "status", label: "Status", render: (t) => <StatusBadge status={t.status} /> },
  ];

  return (
    <div>
      <PageHeader
        title="Trip Sheets"
        description="Every trip your fleet has run, from draft to invoiced"
        action={
          <Button onClick={() => navigate("/trips/new")} className="bg-primary-500 hover:bg-primary-600">
            <Plus className="h-4 w-4" />
            New Trip Sheet
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput placeholder="Search by trip number or customer..." onDebouncedChange={setSearch} className="w-64" />

        <div className="flex gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
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

        <div className="flex gap-1.5">
          {(["ALL", ...TRIP_SERVICE_TYPES] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setServiceType(v)}
              className={cn(
                "rounded-full border px-3 py-1 text-sm font-medium transition-colors",
                serviceType === v
                  ? "border-primary-500 bg-primary-50 text-primary-700"
                  : "border-gray-300 text-gray-600 hover:bg-gray-50",
              )}
            >
              {v === "ALL" ? "All Types" : TRIP_SERVICE_TYPE_LABELS[v]}
            </button>
          ))}
        </div>

        <div className="flex gap-1.5">
          {(["ALL", ...TRIP_BILLING_MODES] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setBillingMode(v)}
              className={cn(
                "rounded-full border px-3 py-1 text-sm font-medium transition-colors",
                billingMode === v
                  ? "border-primary-500 bg-primary-50 text-primary-700"
                  : "border-gray-300 text-gray-600 hover:bg-gray-50",
              )}
            >
              {v === "ALL" ? "All Billing" : TRIP_BILLING_MODE_LABELS[v]}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5 text-sm text-gray-600">
          <span>Trip Date</span>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <span>to</span>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">All customers</option>
          {customersData?.customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.customer_type === "B2B" ? c.company_name : c.name}
            </option>
          ))}
        </select>

        <select
          value={vehicleId}
          onChange={(e) => setVehicleId(e.target.value)}
          className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">All vehicles</option>
          {vehiclesData?.vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.vehicle_number_display || v.vehicle_number}
            </option>
          ))}
        </select>

        <Button
          type="button"
          variant="secondary"
          onClick={handleExport}
          disabled={exportCsv.isPending}
          className="ml-auto"
        >
          <Download className="h-4 w-4" />
          {exportCsv.isPending ? "Exporting..." : "Export CSV"}
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={data?.trips ?? []}
        rowKey={(t) => t.id}
        loading={isLoading}
        onRowClick={(t) => navigate(`/trips/${t.id}`)}
        emptyMessage="No trip sheets yet"
        emptyDescription="Create your first trip sheet to start tracking billable trips."
        emptyAction={
          <Button onClick={() => navigate("/trips/new")} className="bg-primary-500 hover:bg-primary-600">
            <Plus className="h-4 w-4" />
            New Trip Sheet
          </Button>
        }
      />
    </div>
  );
}
