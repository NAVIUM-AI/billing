import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import * as pricingRulesApi from "@/features/pricingRules/pricingRules.api";
import type { RuleType, VehicleType } from "@/lib/constants/enums";
import { queryKeys } from "@/lib/queryKeys";
import type { PricingRuleFormValues } from "@/lib/schemas/pricingRule";

// The list page shows one row per (rule_type, vehicle_type) combo — the
// CURRENTLY active rules across every combo, no combo filter.
export function useCurrentPricingRules() {
  return useQuery({
    queryKey: queryKeys.pricingRules.list(true),
    queryFn: () => pricingRulesApi.listPricingRules({ activeOnly: true, limit: 100 }),
  });
}

// Full version history for ONE combo (current + every superseded
// version), ordered effective_from DESC by the backend already.
export function usePricingRuleHistory(ruleType: RuleType | undefined, vehicleType: VehicleType | undefined) {
  return useQuery({
    queryKey: queryKeys.pricingRules.history(ruleType ?? "LOCAL_PACKAGE", vehicleType ?? "SEDAN"),
    queryFn: () => pricingRulesApi.listPricingRules({ rule_type: ruleType, vehicle_type: vehicleType, limit: 100 }),
    enabled: Boolean(ruleType && vehicleType),
  });
}

export function usePricingRule(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.pricingRules.detail(id ?? ""),
    queryFn: () => pricingRulesApi.getPricingRule(id as string),
    enabled: Boolean(id),
  });
}

export function useCreatePricingRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: PricingRuleFormValues) => pricingRulesApi.createPricingRule(values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pricingRules.lists() });
      queryClient.invalidateQueries({ queryKey: queryKeys.pricingRules.histories() });
    },
  });
}

export function useSupersedePricingRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: PricingRuleFormValues }) =>
      pricingRulesApi.supersedePricingRule(id, values),
    onSuccess: () => {
      // A supersede changes both "what's current" (the list page) and
      // the full history for that combo — invalidate both broadly
      // rather than trying to compute the exact combo key here.
      queryClient.invalidateQueries({ queryKey: queryKeys.pricingRules.lists() });
      queryClient.invalidateQueries({ queryKey: queryKeys.pricingRules.histories() });
    },
  });
}
