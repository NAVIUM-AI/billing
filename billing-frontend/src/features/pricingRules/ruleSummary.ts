import { formatPaiseAsRupees } from "@/lib/money";
import type { PricingRule } from "@/types/pricingRule";

// Compact, rule-type-aware one-line rate summary — used on the list
// page and on each version-history card. Mirrors the same fields
// pricingRule.service.js#REQUIRED_FIELDS_BY_TYPE treats as that rule
// type's real rate fields, nothing invented.
export function formatRuleSummary(rule: PricingRule): string {
  switch (rule.rule_type) {
    case "LOCAL_PACKAGE":
      return `${formatPaiseAsRupees(rule.base_price_paise)} / ${rule.base_hours}h, ${rule.base_km}km + ${formatPaiseAsRupees(rule.extra_km_rate_paise)}/km, ${formatPaiseAsRupees(rule.extra_hr_rate_paise)}/hr extra`;
    case "OUTSTATION_SLAB":
      return `${formatPaiseAsRupees(rule.slab_rate_paise)}/km (min ${rule.min_km_per_day}km/day) + ${formatPaiseAsRupees(rule.driver_batta_per_day_paise)}/day batta`;
    case "PERFORMANCE":
      return `${formatPaiseAsRupees(rule.per_km_rate_paise)}/km + ${formatPaiseAsRupees(rule.performance_batta_paise)} batta`;
    default:
      return "—";
  }
}
