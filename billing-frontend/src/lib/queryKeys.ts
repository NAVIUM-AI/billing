import type { CustomerFilters } from "@/types/customer";
import type { DriverFilters } from "@/types/driver";
import type { InvoiceFilters } from "@/types/invoice";
import type { PaymentFilters } from "@/types/payment";
import type { RuleType, VehicleType } from "@/lib/constants/enums";
import type { TripSheetFilters } from "@/types/tripSheet";
import type { VehicleFilters } from "@/types/vehicle";

// Standard TkDodo query-key-factory pattern. Invalidating
// queryKeys.customers.all invalidates every customer-related query at
// once; the more specific keys (lists/list/details/detail) let a
// mutation invalidate narrowly when that's cheaper (e.g. a contact
// mutation only needs to invalidate one customer's detail, not the
// whole list).
export const queryKeys = {
  customers: {
    all: ["customers"] as const,
    lists: () => [...queryKeys.customers.all, "list"] as const,
    list: (filters: CustomerFilters) => [...queryKeys.customers.lists(), filters] as const,
    details: () => [...queryKeys.customers.all, "detail"] as const,
    detail: (id: string) => [...queryKeys.customers.details(), id] as const,
  },
  vehicles: {
    all: ["vehicles"] as const,
    lists: () => [...queryKeys.vehicles.all, "list"] as const,
    list: (filters: VehicleFilters) => [...queryKeys.vehicles.lists(), filters] as const,
    details: () => [...queryKeys.vehicles.all, "detail"] as const,
    detail: (id: string) => [...queryKeys.vehicles.details(), id] as const,
  },
  drivers: {
    all: ["drivers"] as const,
    lists: () => [...queryKeys.drivers.all, "list"] as const,
    list: (filters: DriverFilters) => [...queryKeys.drivers.lists(), filters] as const,
    details: () => [...queryKeys.drivers.all, "detail"] as const,
    detail: (id: string) => [...queryKeys.drivers.details(), id] as const,
  },
  pricingRules: {
    all: ["pricingRules"] as const,
    lists: () => [...queryKeys.pricingRules.all, "list"] as const,
    // Phase 3's "list" IS effectively "current rules across combos"
    // (activeOnly=true, no rule_type/vehicle_type filter) — still goes
    // through the same list() key so a supersede mutation can
    // invalidate every list variant at once via lists().
    list: (activeOnly: boolean) => [...queryKeys.pricingRules.lists(), { activeOnly }] as const,
    // One combo's FULL version history (all rows, current + superseded).
    histories: () => [...queryKeys.pricingRules.all, "history"] as const,
    history: (ruleType: RuleType, vehicleType: VehicleType) =>
      [...queryKeys.pricingRules.histories(), ruleType, vehicleType] as const,
    details: () => [...queryKeys.pricingRules.all, "detail"] as const,
    detail: (id: string) => [...queryKeys.pricingRules.details(), id] as const,
  },
  tripSheets: {
    all: ["tripSheets"] as const,
    lists: () => [...queryKeys.tripSheets.all, "list"] as const,
    list: (filters: TripSheetFilters) => [...queryKeys.tripSheets.lists(), filters] as const,
    details: () => [...queryKeys.tripSheets.all, "detail"] as const,
    detail: (id: string) => [...queryKeys.tripSheets.details(), id] as const,
  },
  invoices: {
    all: ["invoices"] as const,
    lists: () => [...queryKeys.invoices.all, "list"] as const,
    list: (filters: InvoiceFilters) => [...queryKeys.invoices.lists(), filters] as const,
    details: () => [...queryKeys.invoices.all, "detail"] as const,
    detail: (id: string) => [...queryKeys.invoices.details(), id] as const,
    // Task 4.2's picker — keyed by customer + the edit-mode escape
    // hatch (invoiceId) since including THAT invoice's own held trips
    // changes the eligible set.
    invoiceableTrips: (customerId: string, invoiceId?: string) =>
      [...queryKeys.invoices.all, "invoiceableTrips", customerId, invoiceId ?? null] as const,
  },
  creditNotes: {
    all: ["creditNotes"] as const,
    lists: () => [...queryKeys.creditNotes.all, "list"] as const,
    list: (limit: number) => [...queryKeys.creditNotes.lists(), { limit }] as const,
    details: () => [...queryKeys.creditNotes.all, "detail"] as const,
    detail: (id: string) => [...queryKeys.creditNotes.details(), id] as const,
  },
  settings: {
    all: ["settings"] as const,
    businessProfile: () => [...queryKeys.settings.all, "businessProfile"] as const,
  },
  payments: {
    all: ["payments"] as const,
    lists: () => [...queryKeys.payments.all, "list"] as const,
    list: (filters: PaymentFilters) => [...queryKeys.payments.lists(), filters] as const,
    // Invoice-detail's own payment history — a distinct key from the
    // generic list() above since it always passes a fixed
    // status=RECORDED,CANCELLED filter (see payments.api.ts), not
    // whatever the top-level Payments screen's filters currently are.
    forInvoice: (invoiceId: string) => [...queryKeys.payments.all, "forInvoice", invoiceId] as const,
  },
  ledger: {
    all: ["ledger"] as const,
    detail: (customerId: string) => [...queryKeys.ledger.all, customerId] as const,
  },
  aging: {
    all: ["aging"] as const,
    report: (asOfDate?: string) => [...queryKeys.aging.all, asOfDate ?? null] as const,
  },
};
