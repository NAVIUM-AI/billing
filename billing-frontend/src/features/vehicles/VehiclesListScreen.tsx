import { MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, type DataTableColumn } from "@/components/DataTable";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { PageHeader } from "@/components/PageHeader";
import { SearchInput } from "@/components/SearchInput";
import { Button } from "@/components/ui/button";
import { VehicleFormModal } from "@/features/vehicles/VehicleFormModal";
import { useArchiveVehicle, useUnarchiveVehicle, useVehicles } from "@/features/vehicles/vehicles.hooks";
import { VEHICLE_TYPE_LABELS } from "@/lib/constants/enums";
import { cn } from "@/lib/utils";
import type { Vehicle, VehicleFilters } from "@/types/vehicle";

type StatusFilter = "active" | "archived" | "all";
const STATUS_FILTERS: { label: string; value: StatusFilter }[] = [
  { label: "Active", value: "active" },
  { label: "Archived", value: "archived" },
  { label: "All", value: "all" },
];

export function VehiclesListScreen() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [archivingVehicle, setArchivingVehicle] = useState<Vehicle | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);

  // The backend has no "archived only" filter — includeArchived just
  // widens the result set to include BOTH active and archived rows
  // (vehicle.repository.js#list: `$2::bool OR is_active = true`).
  // "Archived" is therefore a client-side filter on top of the widened
  // fetch, not a server-side query param.
  const filters: VehicleFilters = {
    search: search || undefined,
    limit: 50,
    offset: 0,
    includeArchived: status !== "active",
  };
  const { data, isLoading } = useVehicles(filters);
  const archiveVehicle = useArchiveVehicle();
  const unarchiveVehicle = useUnarchiveVehicle();

  const rows = (data?.vehicles ?? []).filter((v) => {
    if (status === "archived") return !v.is_active;
    return true;
  });

  function openCreate() {
    setEditingId(undefined);
    setModalOpen(true);
  }

  function openEdit(vehicle: Vehicle) {
    setEditingId(vehicle.id);
    setModalOpen(true);
    setMenuOpenFor(null);
  }

  async function confirmArchive() {
    if (!archivingVehicle) return;
    await archiveVehicle.mutateAsync(archivingVehicle.id);
    toast.success("Vehicle archived");
    setArchivingVehicle(null);
  }

  async function handleUnarchive(vehicle: Vehicle) {
    await unarchiveVehicle.mutateAsync(vehicle.id);
    toast.success("Vehicle restored");
    setMenuOpenFor(null);
  }

  const columns: DataTableColumn<Vehicle>[] = [
    {
      key: "vehicle_number",
      label: "Registration Number",
      render: (v) => (
        <button
          type="button"
          onClick={() => openEdit(v)}
          className="font-mono font-medium text-gray-900 hover:text-primary-600 hover:underline"
        >
          {v.vehicle_number_display || v.vehicle_number}
        </button>
      ),
    },
    { key: "vehicle_type", label: "Vehicle Type", render: (v) => VEHICLE_TYPE_LABELS[v.vehicle_type] },
    { key: "make_model", label: "Make / Model", render: (v) => v.make_model || "—" },
    { key: "seating_capacity", label: "Capacity", render: (v) => (v.seating_capacity != null ? v.seating_capacity : "—") },
    {
      key: "status",
      label: "Status",
      render: (v) => (
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-xs font-medium",
            v.is_active ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-600",
          )}
        >
          {v.is_active ? "Active" : "Archived"}
        </span>
      ),
    },
    {
      key: "actions",
      label: "",
      className: "w-10 text-right",
      render: (v) => (
        <div className="relative flex justify-end">
          <button
            type="button"
            aria-label="Row actions"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpenFor(menuOpenFor === v.id ? null : v.id);
            }}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpenFor === v.id && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpenFor(null)} />
              <div className="absolute right-0 top-7 z-20 w-32 rounded-md border bg-white py-1 shadow-md">
                <button
                  type="button"
                  onClick={() => openEdit(v)}
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-gray-50"
                >
                  Edit
                </button>
                {v.is_active ? (
                  <button
                    type="button"
                    onClick={() => {
                      setArchivingVehicle(v);
                      setMenuOpenFor(null);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50"
                  >
                    Archive
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleUnarchive(v)}
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
        title="Vehicles"
        description="Manage your fleet"
        action={
          <Button onClick={openCreate} className="bg-primary-500 hover:bg-primary-600">
            <Plus className="h-4 w-4" />
            New Vehicle
          </Button>
        }
      />

      <div className="mb-4 flex items-center gap-3">
        <SearchInput placeholder="Search by registration number..." onDebouncedChange={setSearch} className="w-72" />
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
        rowKey={(v) => v.id}
        loading={isLoading}
        emptyMessage="No vehicles yet"
        emptyDescription="Add your first vehicle to start assigning trips."
        emptyAction={
          <Button onClick={openCreate} className="bg-primary-500 hover:bg-primary-600">
            <Plus className="h-4 w-4" />
            New Vehicle
          </Button>
        }
      />

      <VehicleFormModal open={modalOpen} onOpenChange={setModalOpen} vehicleId={editingId} />

      <DeleteConfirmDialog
        open={Boolean(archivingVehicle)}
        onOpenChange={(open) => !open && setArchivingVehicle(null)}
        title={`Archive ${archivingVehicle?.vehicle_number_display || archivingVehicle?.vehicle_number || "this vehicle"}?`}
        description="This vehicle will be hidden from active lists. You can restore it later from the Archived filter."
        confirmLabel="Archive"
        onConfirm={confirmArchive}
        isLoading={archiveVehicle.isPending}
      />
    </div>
  );
}
