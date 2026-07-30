import type { CustomerFilters } from "@/types/customer";

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
    // Phase 3
  },
  drivers: {
    all: ["drivers"] as const,
    // Phase 3
  },
  pricingRules: {
    all: ["pricingRules"] as const,
    // Phase 3
  },
};
