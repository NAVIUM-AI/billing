import { AxiosError } from "axios";
import { MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { DataTable, type DataTableColumn } from "@/components/DataTable";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { PageHeader } from "@/components/PageHeader";
import { SearchInput } from "@/components/SearchInput";
import { Button } from "@/components/ui/button";
import { CustomerFormDrawer } from "@/features/customers/CustomerFormDrawer";
import { useCustomers, useDeleteCustomer } from "@/features/customers/customers.hooks";
import { cn } from "@/lib/utils";
import type { ApiErrorResponse } from "@/types/api";
import type { Customer, CustomerFilters, CustomerType } from "@/types/customer";

const TYPE_FILTERS: { label: string; value: CustomerType | undefined }[] = [
  { label: "All", value: undefined },
  { label: "B2B", value: "B2B" },
  { label: "B2C", value: "B2C" },
];

function TypeBadge({ type }: { type: CustomerType }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-xs font-medium",
        type === "B2B" ? "bg-primary-100 text-primary-700" : "bg-blue-100 text-blue-700",
      )}
    >
      {type}
    </span>
  );
}

export function CustomersListScreen() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<CustomerType | undefined>(undefined);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [deletingCustomer, setDeletingCustomer] = useState<Customer | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);

  const filters: CustomerFilters = { search: search || undefined, customer_type: typeFilter, limit: 50, offset: 0 };
  const { data, isLoading } = useCustomers(filters);
  const deleteCustomer = useDeleteCustomer();

  function openCreate() {
    setEditingId(undefined);
    setDrawerOpen(true);
  }

  function openEdit(customer: Customer) {
    setEditingId(customer.id);
    setDrawerOpen(true);
    setMenuOpenFor(null);
  }

  async function confirmDelete() {
    if (!deletingCustomer) return;
    try {
      await deleteCustomer.mutateAsync(deletingCustomer.id);
      toast.success("Customer deleted");
      setDeletingCustomer(null);
    } catch (err) {
      const apiErr =
        err instanceof AxiosError ? (err.response?.data as ApiErrorResponse | undefined)?.error : undefined;
      toast.error(apiErr?.message || "Failed to delete customer");
    }
  }

  const columns: DataTableColumn<Customer>[] = [
    {
      key: "name",
      label: "Name",
      render: (c) => (
        <button
          type="button"
          onClick={() => openEdit(c)}
          className="font-medium text-gray-900 hover:text-primary-600 hover:underline"
        >
          {c.customer_type === "B2B" ? c.company_name : c.name}
        </button>
      ),
    },
    {
      key: "customer_type",
      label: "Type",
      render: (c) => <TypeBadge type={c.customer_type} />,
    },
    {
      key: "gstin",
      label: "GSTIN",
      render: (c) => <span className="font-mono text-xs">{c.gstin || "—"}</span>,
    },
    {
      key: "contact",
      label: "Contact",
      render: (c) => (
        <span className="text-gray-600">{[c.phone_display, c.email].filter(Boolean).join(" · ") || "—"}</span>
      ),
    },
    {
      key: "actions",
      label: "",
      className: "w-10 text-right",
      render: (c) => (
        <div className="relative flex justify-end">
          <button
            type="button"
            aria-label="Row actions"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpenFor(menuOpenFor === c.id ? null : c.id);
            }}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpenFor === c.id && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpenFor(null)} />
              <div className="absolute right-0 top-7 z-20 w-32 rounded-md border bg-white py-1 shadow-md">
                <button
                  type="button"
                  onClick={() => openEdit(c)}
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-gray-50"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => navigate(`/customers/${c.id}/ledger`)}
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-gray-50"
                >
                  View Ledger
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDeletingCustomer(c);
                    setMenuOpenFor(null);
                  }}
                  className="block w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50"
                >
                  Delete
                </button>
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
        title="Customers"
        description="Manage your billing customers"
        action={
          <Button onClick={openCreate} className="bg-primary-500 hover:bg-primary-600">
            <Plus className="h-4 w-4" />
            New Customer
          </Button>
        }
      />

      <div className="mb-4 flex items-center gap-3">
        <SearchInput placeholder="Search customers by name..." onDebouncedChange={setSearch} className="w-72" />
        <div className="flex gap-1.5">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.label}
              type="button"
              onClick={() => setTypeFilter(f.value)}
              className={cn(
                "rounded-full border px-3 py-1 text-sm font-medium transition-colors",
                typeFilter === f.value
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
        rows={data?.customers ?? []}
        rowKey={(c) => c.id}
        loading={isLoading}
        emptyMessage="No customers yet"
        emptyDescription="Create your first customer to start billing them."
        emptyAction={
          <Button onClick={openCreate} className="bg-primary-500 hover:bg-primary-600">
            <Plus className="h-4 w-4" />
            New Customer
          </Button>
        }
      />

      <CustomerFormDrawer open={drawerOpen} onOpenChange={setDrawerOpen} customerId={editingId} />

      <DeleteConfirmDialog
        open={Boolean(deletingCustomer)}
        onOpenChange={(open) => !open && setDeletingCustomer(null)}
        title={`Delete ${deletingCustomer?.company_name || deletingCustomer?.name || "this customer"}?`}
        description="This customer will be archived and hidden from the list. You can restore them later if needed."
        onConfirm={confirmDelete}
        isLoading={deleteCustomer.isPending}
      />
    </div>
  );
}
