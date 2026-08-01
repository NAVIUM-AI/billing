/**
 * Pricing-rule API layer. All responses parse through Zod at the
 * boundary (Rule 4).
 *
 * ─── ADR-005 (versioned pricing, rate-immutable) shapes this whole
 * file ───
 * - POST /pricing/rules creates the FIRST version of a (rule_type,
 *   vehicle_type) combo.
 * - PATCH /pricing/rules/:id only ever accepts label/notes/effective_to
 *   — every rate field, rule_type, vehicle_type, and effective_from are
 *   Joi `.forbidden()` there. There is deliberately NO updatePricingRule
 *   export here that touches rates — rate correction goes through
 *   supersede, never PATCH.
 * - POST /pricing/rules/:id/supersede atomically closes the target
 *   rule's effective_to and inserts a new open-ended version. It does
 *   NOT accept rule_type/vehicle_type/effective_to in the body (they're
 *   inherited/fixed) — toSupersedePayload strips them even though
 *   Joi would just silently drop them anyway (stripUnknown: true),
 *   for clarity at the call site.
 */
import { apiClient } from "@/lib/api";
import {
  listPricingRulesResponseSchema,
  pricingRuleDetailResponseSchema,
  supersedeResponseSchema,
  type PricingRuleFormValues,
} from "@/lib/schemas/pricingRule";
import type { PricingRule, PricingRuleFilters, PricingRuleListResponse } from "@/types/pricingRule";

const NUMERIC_KEYS = [
  "base_hours",
  "base_km",
  "base_price_rupees",
  "extra_km_rate_rupees",
  "extra_hr_rate_rupees",
  "slab_rate_rupees",
  "min_km_per_day",
  "driver_batta_per_day_rupees",
  "per_km_rate_rupees",
  "performance_batta_rupees",
] as const;

function omitEmptyStrings<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === "" || value === undefined) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function toWirePayload(values: Record<string, unknown>) {
  const payload = omitEmptyStrings(values);
  for (const key of NUMERIC_KEYS) {
    if (payload[key] !== undefined) payload[key] = Number(payload[key]);
  }
  return payload;
}

export async function listPricingRules(filters: PricingRuleFilters): Promise<PricingRuleListResponse> {
  const res = await apiClient.get("/pricing/rules", {
    params: {
      rule_type: filters.rule_type || undefined,
      vehicle_type: filters.vehicle_type || undefined,
      on_date: filters.on_date || undefined,
      activeOnly: filters.activeOnly,
      limit: filters.limit,
      offset: filters.offset,
    },
  });
  return listPricingRulesResponseSchema.parse(res.data) as PricingRuleListResponse;
}

export async function getPricingRule(id: string): Promise<PricingRule> {
  const res = await apiClient.get(`/pricing/rules/${id}`);
  return pricingRuleDetailResponseSchema.parse(res.data).rule as PricingRule;
}

export async function createPricingRule(values: PricingRuleFormValues): Promise<PricingRule> {
  const res = await apiClient.post("/pricing/rules", toWirePayload(values));
  return pricingRuleDetailResponseSchema.parse(res.data).rule as PricingRule;
}

export async function supersedePricingRule(
  id: string,
  values: PricingRuleFormValues,
): Promise<{ superseded: PricingRule; newRule: PricingRule }> {
  const payload = toWirePayload(values) as Record<string, unknown>;
  delete payload.rule_type;
  delete payload.vehicle_type;
  delete payload.effective_to;
  const res = await apiClient.post(`/pricing/rules/${id}/supersede`, payload);
  const parsed = supersedeResponseSchema.parse(res.data);
  return { superseded: parsed.superseded as PricingRule, newRule: parsed.new_rule as PricingRule };
}
