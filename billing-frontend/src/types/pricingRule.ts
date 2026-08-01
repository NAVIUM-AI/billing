import type { RuleType, VehicleType } from "@/lib/constants/enums";

// Field names match the real `pricing_rules` table exactly (Task 2.3
// migration, ADR-005). One flat table with per-rule-type columns —
// NOT a generic JSONB "rules" blob, and OUTSTATION_SLAB is a single
// slab_rate_paise/min_km_per_day/driver_batta_per_day_paise triple, not
// multiple from-km/to-km slab rows.
export interface PricingRule {
  id: string;
  tenant_id: string;
  rule_type: RuleType;
  vehicle_type: VehicleType;
  label: string;
  base_hours: number | null;
  base_km: number | null;
  base_price_paise: number | null;
  extra_km_rate_paise: number | null;
  extra_hr_rate_paise: number | null;
  slab_rate_paise: number | null;
  min_km_per_day: number | null;
  driver_batta_per_day_paise: number | null;
  per_km_rate_paise: number | null;
  performance_batta_paise: number | null;
  // Half-open range: effective_to = null means "still the current
  // version" (ADR-005).
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PricingRuleFilters {
  rule_type?: RuleType;
  vehicle_type?: VehicleType;
  on_date?: string;
  activeOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface PricingRuleListResponse {
  rules: PricingRule[];
  pagination: { total: number; limit: number; offset: number };
}
