import { Building2, Plus, User } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { CustomerFormDrawer } from "@/features/customers/CustomerFormDrawer";
import { useCustomers } from "@/features/customers/customers.hooks";
import { cn } from "@/lib/utils";
import type { Customer, CustomerType } from "@/types/customer";

interface BillingTypeStepProps {
  customerType: CustomerType | null;
  customerId: string | null;
  onCustomerTypeChange: (type: CustomerType) => void;
  onCustomerIdChange: (id: string) => void;
  onNext: () => void;
}

const TYPE_CARDS: { type: CustomerType; icon: typeof Building2; label: string; description: string }[] = [
  { type: "B2B", icon: Building2, label: "B2B", description: "Corporate client with GSTIN" },
  { type: "B2C", icon: User, label: "B2C", description: "Individual customer" },
];

export function BillingTypeStep({
  customerType,
  customerId,
  onCustomerTypeChange,
  onCustomerIdChange,
  onNext,
}: BillingTypeStepProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { data } = useCustomers({ customer_type: customerType ?? undefined, limit: 100, offset: 0 });
  const customers = data?.customers ?? [];
  const selectedCustomer = customers.find((c) => c.id === customerId);

  function handleTypeSelect(type: CustomerType) {
    onCustomerTypeChange(type);
    if (customerType !== type) onCustomerIdChange("");
  }

  function handleCreated(customer: Customer) {
    onCustomerIdChange(customer.id);
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-4">
        {TYPE_CARDS.map(({ type, icon: Icon, label, description }) => (
          <button
            key={type}
            type="button"
            onClick={() => handleTypeSelect(type)}
            className={cn(
              "flex flex-col items-center gap-2 rounded-lg border-2 p-6 text-center transition-colors",
              customerType === type
                ? "border-primary-500 bg-primary-50"
                : "border-gray-200 hover:border-gray-300 hover:bg-gray-50",
            )}
          >
            <Icon className={cn("h-8 w-8", customerType === type ? "text-primary-600" : "text-gray-400")} />
            <span className="text-base font-semibold text-gray-900">{label}</span>
            <span className="text-sm text-gray-500">{description}</span>
          </button>
        ))}
      </div>

      {customerType && (
        <div className="mt-6">
          <label className="mb-1.5 block text-sm font-medium text-gray-700">
            Select {customerType === "B2B" ? "Company" : "Customer"}
          </label>
          <div className="flex gap-2">
            <select
              value={customerId ?? ""}
              onChange={(e) => onCustomerIdChange(e.target.value)}
              className="h-9 flex-1 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">Select {customerType === "B2B" ? "a company" : "a customer"}...</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.customer_type === "B2B" ? c.company_name : c.name}
                </option>
              ))}
            </select>
            <Button type="button" variant="secondary" onClick={() => setDrawerOpen(true)}>
              <Plus className="h-4 w-4" />
              Add New
            </Button>
          </div>

          {selectedCustomer && (
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border bg-gray-50 p-4 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-400">Name</div>
                <div className="text-gray-900">
                  {selectedCustomer.customer_type === "B2B" ? selectedCustomer.company_name : selectedCustomer.name}
                </div>
              </div>
              {selectedCustomer.customer_type === "B2B" && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-gray-400">GSTIN</div>
                  <div className="font-mono text-gray-900">{selectedCustomer.gstin || "—"}</div>
                </div>
              )}
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-400">Address</div>
                <div className="text-gray-900">
                  {[selectedCustomer.address?.city, selectedCustomer.address?.state].filter(Boolean).join(", ") || "—"}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-400">Contact</div>
                <div className="text-gray-900">
                  {[selectedCustomer.phone_display, selectedCustomer.email].filter(Boolean).join(" · ") || "—"}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-8 flex justify-end">
        <Button
          type="button"
          onClick={onNext}
          disabled={!customerId}
          className="bg-primary-500 hover:bg-primary-600"
        >
          Next
        </Button>
      </div>

      <CustomerFormDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        defaultCustomerType={customerType ?? undefined}
        onCreated={handleCreated}
      />
    </div>
  );
}
