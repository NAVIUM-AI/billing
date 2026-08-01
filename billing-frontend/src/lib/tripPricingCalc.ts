// Mirrors billing-backend/src/domain/pricing/{local,outstation,performance,dispatch}.js
// and tripSheet.service.js#deriveRuleType EXACTLY — same arithmetic,
// same field names, same rounding (none needed; everything is already
// integer paise). This is a client-side PREVIEW ONLY (Rule 14 /
// task's own instruction): the backend recomputes on save and is the
// source of truth. If backend logic ever changes, this file needs the
// identical edit — there's no shared package between the two apps.
import type { RuleType, TripBillingMode, TripServiceType } from "@/lib/constants/enums";

export function deriveRuleType(serviceType: TripServiceType, billingMode: TripBillingMode): RuleType {
  if (serviceType === "LOCAL" && billingMode === "GST") return "LOCAL_PACKAGE";
  if (serviceType === "LOCAL" && billingMode === "PERFORMANCE") return "PERFORMANCE";
  if (serviceType === "OUTSTATION" && billingMode === "GST") return "OUTSTATION_SLAB";
  return "PERFORMANCE"; // OUTSTATION + PERFORMANCE
}

export interface BreakdownItem {
  label: string;
  value_paise: number;
  detail?: string;
}

export interface RuleForCalc {
  base_hours?: number | null;
  base_km?: number | null;
  base_price_paise?: number | null;
  extra_km_rate_paise?: number | null;
  extra_hr_rate_paise?: number | null;
  slab_rate_paise?: number | null;
  min_km_per_day?: number | null;
  driver_batta_per_day_paise?: number | null;
  per_km_rate_paise?: number | null;
  performance_batta_paise?: number | null;
}

export interface TripPreviewResult {
  base_amount_paise: number;
  extras_amount_paise: number;
  driver_batta_paise: number;
  subtotal_paise: number;
  gross_paise: number;
  net_payable_paise: number;
  breakdown: BreakdownItem[];
}

// Mirrors local.js#calculateLocal.
function calculateLocalPreview(
  rule: RuleForCalc,
  usage: { total_km: number; total_hours: number; toll_paise: number },
): TripPreviewResult {
  const baseKm = rule.base_km ?? 0;
  const baseHours = rule.base_hours ?? 0;
  const extraKmRate = rule.extra_km_rate_paise ?? 0;
  const extraHrRate = rule.extra_hr_rate_paise ?? 0;
  const basePaise = rule.base_price_paise ?? 0;

  const extraKm = Math.max(0, usage.total_km - baseKm);
  const extraHours = Math.max(0, usage.total_hours - baseHours);
  const extraKmPaise = extraKm * extraKmRate;
  const extraHoursPaise = extraHours * extraHrRate;
  const subtotalPaise = basePaise + extraKmPaise + extraHoursPaise + usage.toll_paise;

  return {
    base_amount_paise: basePaise,
    extras_amount_paise: extraKmPaise + extraHoursPaise,
    driver_batta_paise: 0,
    subtotal_paise: subtotalPaise,
    gross_paise: subtotalPaise,
    net_payable_paise: subtotalPaise,
    breakdown: [
      { label: "Base package", value_paise: basePaise },
      { label: "Extra KM", value_paise: extraKmPaise, detail: `${extraKm} × ₹${extraKmRate / 100}` },
      { label: "Extra Hours", value_paise: extraHoursPaise, detail: `${extraHours} × ₹${extraHrRate / 100}` },
      { label: "Toll", value_paise: usage.toll_paise },
    ],
  };
}

// Mirrors outstation.js#calculateOutstation.
function calculateOutstationPreview(
  rule: RuleForCalc,
  usage: {
    total_km: number;
    total_days: number;
    toll_paise: number;
    parking_paise: number;
    permit_paise: number;
    fasttag_paise: number;
    advance_paise: number;
  },
): TripPreviewResult {
  const minKmPerDay = rule.min_km_per_day ?? 0;
  const slabRate = rule.slab_rate_paise ?? 0;
  const battaPerDay = rule.driver_batta_per_day_paise ?? 0;

  const minKmTotal = minKmPerDay * usage.total_days;
  const billableKm = Math.max(usage.total_km, minKmTotal);
  const slabPaise = billableKm * slabRate;
  const battaPaise = usage.total_days * battaPerDay;
  const grossPaise =
    slabPaise + battaPaise + usage.toll_paise + usage.parking_paise + usage.permit_paise + usage.fasttag_paise;
  const netPayablePaise = grossPaise - usage.advance_paise;

  return {
    base_amount_paise: slabPaise,
    extras_amount_paise: usage.parking_paise + usage.permit_paise + usage.fasttag_paise,
    driver_batta_paise: battaPaise,
    subtotal_paise: grossPaise,
    gross_paise: grossPaise,
    net_payable_paise: netPayablePaise,
    breakdown: [
      { label: "Slab", value_paise: slabPaise, detail: `${billableKm} km × ₹${slabRate / 100}` },
      { label: "Batta", value_paise: battaPaise, detail: `${usage.total_days} days × ₹${battaPerDay / 100}` },
      { label: "Toll", value_paise: usage.toll_paise },
      { label: "Parking", value_paise: usage.parking_paise },
      { label: "Permit", value_paise: usage.permit_paise },
      { label: "Fasttag", value_paise: usage.fasttag_paise },
      { label: "Advance", value_paise: -usage.advance_paise },
    ],
  };
}

// Mirrors performance.js#calculatePerformance.
function calculatePerformancePreview(
  rule: RuleForCalc,
  usage: { running_km: number; toll_paise: number },
): TripPreviewResult {
  const perKmRate = rule.per_km_rate_paise ?? 0;
  const batta = rule.performance_batta_paise ?? 0;

  const kmPaise = usage.running_km * perKmRate;
  const totalPaise = kmPaise + batta + usage.toll_paise;

  return {
    base_amount_paise: kmPaise,
    extras_amount_paise: 0,
    driver_batta_paise: batta,
    subtotal_paise: totalPaise,
    gross_paise: totalPaise,
    net_payable_paise: totalPaise,
    breakdown: [
      { label: "Running", value_paise: kmPaise, detail: `${usage.running_km} km × ₹${perKmRate / 100}` },
      { label: "Batta", value_paise: batta },
      { label: "Toll", value_paise: usage.toll_paise },
    ],
  };
}

// Mirrors tripSheet.service.js#computeTripTotals's usage-shape dispatch
// (billing_mode === 'PERFORMANCE' wins over service_type, exactly as
// the backend checks it).
export function calculateTripPreview(
  serviceType: TripServiceType,
  billingMode: TripBillingMode,
  rule: RuleForCalc,
  usage: {
    totalKm: number;
    totalHours: number;
    totalDays: number;
    tollPaise: number;
    parkingPaise: number;
    permitPaise: number;
    fasttagPaise: number;
    advancePaise: number;
  },
): TripPreviewResult {
  if (billingMode === "PERFORMANCE") {
    return calculatePerformancePreview(rule, { running_km: usage.totalKm, toll_paise: usage.tollPaise });
  }
  if (serviceType === "OUTSTATION") {
    return calculateOutstationPreview(rule, {
      total_km: usage.totalKm,
      total_days: usage.totalDays,
      toll_paise: usage.tollPaise,
      parking_paise: usage.parkingPaise,
      permit_paise: usage.permitPaise,
      fasttag_paise: usage.fasttagPaise,
      advance_paise: usage.advancePaise,
    });
  }
  return calculateLocalPreview(rule, { total_km: usage.totalKm, total_hours: usage.totalHours, toll_paise: usage.tollPaise });
}
