import type { CustomerFilters } from "@/types/customer";
import type { DriverFilters } from "@/types/driver";
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
};
