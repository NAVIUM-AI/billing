import { differenceInCalendarDays, parseISO } from "date-fns";
import { MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type DataTableColumn } from "@/components/DataTable";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { PageHeader } from "@/components/PageHeader";
import { SearchInput } from "@/components/SearchInput";
import { Button } from "@/components/ui/button";
import { DriverFormModal } from "@/features/drivers/DriverFormModal";
import { useArchiveDriver, useDrivers, useUnarchiveDriver } from "@/features/drivers/drivers.hooks";
import { cn } from "@/lib/utils";
import type { Driver, DriverFilters } from "@/types/driver";

type StatusFilter = "active" | "archived" | "all";
const STATUS_FILTERS: { label: string; value: StatusFilter }[] = [
  { label: "Active", value: "active" },
  { label: "Archived", value: "archived" },
  { label: "All", value: "all" },
];

const EXPIRY_WARNING_DAYS = 30;

function licenseExpiryStatus(expiryDate: string | null): "expired" | "expiring" | "ok" | "none" {
  if (!expiryDate) return "none";
  const days = differenceInCalendarDays(parseISO(expiryDate), new Date());
  if (days < 0) return "expired";
  if (days <= EXPIRY_WARNING_DAYS) return "expiring";
  return "ok";
}

export function DriversListScreen() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [archivingDriver, setArchivingDriver] = useState<Driver | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);

  // Same "no server-side archived-only filter" reality as vehicles —
  // see VehiclesListScreen's identical comment.
  const filters: DriverFilters = {
    search: search || undefined,
    limit: 50,
    offset: 0,
    includeArchived: status !== "active",
  };
  const { data, isLoading } = useDrivers(filters);
  const archiveDriver = useArchiveDriver();
  const unarchiveDriver = useUnarchiveDriver();

  const rows = (data?.drivers ?? []).filter((d) => {
    if (status === "archived") return !d.is_active;
    return true;
  });

  function openCreate() {
    setEditingId(undefined);
    setModalOpen(true);
  }

  function openEdit(driver: Driver) {
    setEditingId(driver.id);
    setModalOpen(true);
    setMenuOpenFor(null);
  }

  async function confirmArchive() {
    if (!archivingDriver) return;
    await archiveDriver.mutateAsync(archivingDriver.id);
    toast.success("Driver archived");
    setArchivingDriver(null);
  }

  async function handleUnarchive(driver: Driver) {
    await unarchiveDriver.mutateAsync(driver.id);
    toast.success("Driver restored");
    setMenuOpenFor(null);
  }

  const columns: DataTableColumn<Driver>[] = [
    {
      key: "full_name",
      label: "Name",
      render: (d) => (
        <button
          type="button"
          onClick={() => openEdit(d)}
          className="font-medium text-gray-900 hover:text-primary-600 hover:underline"
        >
          {d.full_name}
        </button>
      ),
    },
    { key: "phone", label: "Phone", render: (d) => d.phone_display || d.phone || "—" },
    { key: "license_number", label: "License Number", render: (d) => d.license_number || "—" },
    {
      key: "license_expiry_date",
      label: "License Expiry",
      render: (d) => {
        const expiryStatus = licenseExpiryStatus(d.license_expiry_date);
        if (expiryStatus === "none") return <span className="text-gray-400">—</span>;
        return (
          <span
            className={cn(
              "font-medium",
              expiryStatus === "expired" && "text-red-600",
              expiryStatus === "expiring" && "text-orange-600",
              expiryStatus === "ok" && "text-gray-700",
            )}
          >
            {d.license_expiry_date}
            {expiryStatus === "expired" && " (expired)"}
            {expiryStatus === "expiring" && " (expiring soon)"}
          </span>
        );
      },
    },
    {
      key: "status",
      label: "Status",
      render: (d) => (
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-xs font-medium",
            d.is_active ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-600",
          )}
        >
          {d.is_active ? "Active" : "Archived"}
        </span>
      ),
    },
    {
      key: "actions",
      label: "",
      className: "w-10 text-right",
      render: (d) => (
        <div className="relative flex justify-end">
          <button
            type="button"
            aria-label="Row actions"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpenFor(menuOpenFor === d.id ? null : d.id);
            }}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpenFor === d.id && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpenFor(null)} />
              <div className="absolute right-0 top-7 z-20 w-32 rounded-md border bg-white py-1 shadow-md">
                <button
                  type="button"
                  onClick={() => openEdit(d)}
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-gray-50"
                >
                  Edit
                </button>
                {d.is_active ? (
                  <button
                    type="button"
                    onClick={() => {
                      setArchivingDriver(d);
                      setMenuOpenFor(null);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50"
                  >
                    Archive
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleUnarchive(d)}
                    className="block w-full px-3 py-1.5 text-left text-sm hover:bg-gray-50"
                  >
                    Restore
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Drivers"
        description="Manage your drivers"
        action={
          <Button onClick={openCreate} className="bg-primary-500 hover:bg-primary-600">
            <Plus className="h-4 w-4" />
            New Driver
          </Button>
        }
      />

      <div className="mb-4 flex items-center gap-3">
        <SearchInput placeholder="Search by name or phone..." onDebouncedChange={setSearch} className="w-72" />
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
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(d) => d.id}
        loading={isLoading}
        emptyMessage="No drivers yet"
        emptyDescription="Add your first driver to start assigning trips."
        emptyAction={
          <Button onClick={openCreate} className="bg-primary-500 hover:bg-primary-600">
            <Plus className="h-4 w-4" />
            New Driver
          </Button>
        }
      />

      <DriverFormModal open={modalOpen} onOpenChange={setModalOpen} driverId={editingId} />

      <DeleteConfirmDialog
        open={Boolean(archivingDriver)}
        onOpenChange={(open) => !open && setArchivingDriver(null)}
        title={`Archive ${archivingDriver?.full_name || "this driver"}?`}
        description="This driver will be hidden from active lists. You can restore them later from the Archived filter."
        confirmLabel="Archive"
        onConfirm={confirmArchive}
        isLoading={archiveDriver.isPending}
      />
    </div>
  );
}
