import { z } from "zod";

import { TRIP_BILLING_MODES, TRIP_SERVICE_TYPES, TRIP_STATUSES, VEHICLE_TYPES } from "@/lib/constants/enums";
import { deriveRuleType } from "@/lib/tripPricingCalc";

// Mirrors tripSheet.validator.js#MANUAL_RATE_FIELDS_BY_FORMULA exactly
// — which manual rate fields are required for a given formula. Keyed
// by RuleType (LOCAL_PACKAGE/OUTSTATION_SLAB/PERFORMANCE), same as the
// backend.
const MANUAL_RATE_FIELDS_BY_FORMULA = {
  LOCAL_PACKAGE: ["base_price_rupees", "base_hours", "base_km", "extra_km_rate_rupees", "extra_hr_rate_rupees"],
  OUTSTATION_SLAB: ["slab_rate_rupees", "min_km_per_day", "driver_batta_per_day_rupees"],
  // performance_batta_rupees is a FLAT one-time amount, not "per day"
  // — see tripSheet.validator.js's own comment (Part A finding: the
  // real calculator never multiplies it by total_days).
  PERFORMANCE: ["per_km_rate_rupees", "performance_batta_rupees"],
} as const;

function numericStringField(min: number, label: string, opts: { required?: boolean } = {}) {
  const base = z.string().refine((v) => {
    if (!v) return !opts.required;
    const n = Number(v);
    return Number.isFinite(n) && n >= min;
  }, `${label} must be a number >= ${min}`);
  return opts.required ? base : base.optional().or(z.literal(""));
}

const today = () => new Date().toISOString().slice(0, 10);

// Mirrors tripSheet.validator.js#tollReceiptSchema exactly — plaza_name
// (not "description"), optional toll_id/crossed_at/vehicle_number/
// closing_balance/notes. No update lifecycle (see types/tripSheet.ts's
// TripToll comment) — this schema only ever backs a form row that gets
// fully resubmitted, never patched by id.
export const tripTollFormSchema = z.object({
  plaza_name: z.string().min(2, "Required").max(255),
  toll_id: z.string().max(50).optional().or(z.literal("")),
  amount_rupees: numericStringField(0.01, "Amount", { required: true }),
  crossed_at: z.string().optional().or(z.literal("")),
  vehicle_number: z.string().max(30).optional().or(z.literal("")),
  closing_balance_rupees: numericStringField(0, "Closing balance"),
  notes: z.string().max(500).optional().or(z.literal("")),
});
export type TripTollFormValues = z.infer<typeof tripTollFormSchema>;

// Mirrors tripSheet.validator.js#createTripSheetSchema exactly. ONE
// unified schema, not 3 separate discriminated-union schemas — Rule 10:
// the backend itself has exactly one createTripSheetSchema whose field
// set is IDENTICAL across every (service_type, billing_mode)
// combination (total_km/total_hours/total_days/toll fields/tolls[] are
// all present regardless of type — the backend's pricing engine, not
// Joi, is what makes only some of them relevant to a given type's
// calculation). A discriminated union would be modeling a distinction
// the wire contract doesn't actually have.
export const tripSheetFormSchema = z
  .object({
    service_type: z.enum(TRIP_SERVICE_TYPES),
    billing_mode: z.enum(TRIP_BILLING_MODES),

    customer_id: z.string().min(1, "Customer is required"),

    // Manual mode only (trip-sheets-manual-mode) — this form no longer
    // offers a registered-fleet vehicle picker at all (see
    // TripSheetFormPage.tsx's own top comment). driver_id stays in the
    // schema — optional, submits null — even though no input renders
    // for it; the backend keeps full support for it.
    manual_vehicle_number: z.string().trim().min(3, "Required (min 3 characters)").max(20),
    manual_vehicle_type: z.enum(VEHICLE_TYPES, { message: "Vehicle type is required" }),
    driver_id: z.string().optional().or(z.literal("")),

    // Formula A (LOCAL_PACKAGE) fields.
    base_price_rupees: numericStringField(0.01, "Base price"),
    base_hours: numericStringField(0, "Base hours"),
    base_km: numericStringField(0, "Base km"),
    extra_km_rate_rupees: numericStringField(0, "Extra km rate"),
    extra_hr_rate_rupees: numericStringField(0, "Extra hour rate"),
    // Formula B (OUTSTATION_SLAB) fields.
    slab_rate_rupees: numericStringField(0.01, "Slab rate"),
    min_km_per_day: numericStringField(0, "Min km per day"),
    driver_batta_per_day_rupees: numericStringField(0, "Driver batta"),
    // Formula C (PERFORMANCE) fields — performance_batta_rupees is a
    // FLAT one-time amount, not "per day" (see MANUAL_RATE_FIELDS_BY_
    // FORMULA's own comment above).
    per_km_rate_rupees: numericStringField(0.01, "Per km rate"),
    performance_batta_rupees: numericStringField(0, "Performance batta"),

    trip_date: z
      .string()
      .min(1, "Required")
      .refine((v) => v <= today(), "trip_date cannot be in the future"),
    start_datetime: z.string().optional().or(z.literal("")),
    end_datetime: z.string().optional().or(z.literal("")),

    opening_km: numericStringField(0, "Opening KM"),
    closing_km: numericStringField(0, "Closing KM"),
    total_km: numericStringField(0, "Total KM", { required: true }),
    total_hours: numericStringField(0, "Total hours", { required: true }),
    total_days: numericStringField(1, "Total days", { required: true }),

    toll_rupees: numericStringField(0, "Toll"),
    parking_rupees: numericStringField(0, "Parking"),
    permit_rupees: numericStringField(0, "Permit"),
    fasttag_rupees: numericStringField(0, "Fasttag"),
    advance_rupees: numericStringField(0, "Advance"),

    tolls: z.array(tripTollFormSchema),

    booked_by: z.string().max(255).optional().or(z.literal("")),
    pax_note: z.string().max(255).optional().or(z.literal("")),
    remarks: z.string().max(2000).optional().or(z.literal("")),
  })
  .superRefine((data, ctx) => {
    // Required manual rate fields for the active formula — mirrors
    // tripSheet.validator.js's cross-field check exactly (same field
    // list, same service_type+billing_mode -> formula mapping).
    const formula = deriveRuleType(data.service_type, data.billing_mode);
    for (const field of MANUAL_RATE_FIELDS_BY_FORMULA[formula]) {
      if (!data[field]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Required for this trip type" });
      }
    }

    if (data.opening_km && data.closing_km && Number(data.closing_km) < Number(data.opening_km)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closing_km"],
        message: "closing_km must be >= opening_km",
      });
    }
    // Mirrors tripSheet.service.js's TOLL_INPUT_CONFLICT check
    // (OUTSTATION only — see that function's own comment on why LOCAL/
    // PERFORMANCE aren't included).
    if (data.service_type === "OUTSTATION" && data.tolls.length > 0 && Number(data.toll_rupees || 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toll_rupees"],
        message: "Provide either a lump-sum toll OR itemized tolls, not both",
      });
    }
  });
export type TripSheetFormValues = z.infer<typeof tripSheetFormSchema>;

// ─── Wire response schemas (Rule 4) ───
const tripTollResponseSchema = z.object({
  id: z.string().uuid(),
  trip_sheet_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  plaza_name: z.string(),
  toll_id: z.string().nullable(),
  amount_paise: z.number(),
  crossed_at: z.string().nullable(),
  vehicle_number: z.string().nullable(),
  closing_balance_paise: z.number().nullable(),
  notes: z.string().nullable(),
  line_number: z.number(),
  created_at: z.string(),
});

const breakdownItemSchema = z.object({
  label: z.string(),
  value_paise: z.number(),
  detail: z.string().optional(),
});

export const tripSheetResponseSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  trip_sheet_number: z.string(),
  service_type: z.enum(TRIP_SERVICE_TYPES),
  billing_mode: z.enum(TRIP_BILLING_MODES),
  status: z.enum(TRIP_STATUSES),
  customer_id: z.string().uuid(),
  vehicle_id: z.string().uuid().nullable(),
  driver_id: z.string().uuid().nullable(),
  pricing_rule_id: z.string().uuid().nullable(),
  pricing_source: z.enum(["FLEET", "MANUAL"]),

  snapshot_vehicle_number: z.string(),
  snapshot_vehicle_type: z.enum(VEHICLE_TYPES),
  snapshot_customer_name: z.string(),
  snapshot_customer_gstin: z.string().nullable(),

  snap_base_hours: z.number().nullable(),
  snap_base_km: z.number().nullable(),
  snap_base_price_paise: z.number().nullable(),
  snap_extra_km_rate_paise: z.number().nullable(),
  snap_extra_hr_rate_paise: z.number().nullable(),
  snap_slab_rate_paise: z.number().nullable(),
  snap_min_km_per_day: z.number().nullable(),
  snap_driver_batta_per_day_paise: z.number().nullable(),
  snap_per_km_rate_paise: z.number().nullable(),
  snap_performance_batta_paise: z.number().nullable(),

  trip_date: z.string(),
  start_datetime: z.string().nullable(),
  end_datetime: z.string().nullable(),
  opening_km: z.number().nullable(),
  closing_km: z.number().nullable(),
  total_km: z.number(),
  total_hours: z.number(),
  total_days: z.number(),

  toll_paise: z.number(),
  parking_paise: z.number(),
  permit_paise: z.number(),
  fasttag_paise: z.number(),
  advance_paise: z.number(),

  base_amount_paise: z.number(),
  extras_amount_paise: z.number(),
  driver_batta_paise: z.number(),
  subtotal_paise: z.number(),
  gross_paise: z.number(),
  net_payable_paise: z.number(),
  breakdown: z.array(breakdownItemSchema),

  booked_by: z.string().nullable(),
  pax_note: z.string().nullable(),
  remarks: z.string().nullable(),

  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  finalized_at: z.string().nullable(),
  finalized_by: z.string().nullable(),
  invoiced_at: z.string().nullable(),
  invoice_id: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  cancelled_by: z.string().nullable(),
  cancellation_reason: z.string().nullable(),

  tolls: z.array(tripTollResponseSchema),
});

export const tripSheetDetailResponseSchema = z.object({ trip: tripSheetResponseSchema });

const tripSheetListRowSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  trip_sheet_number: z.string(),
  service_type: z.enum(TRIP_SERVICE_TYPES),
  billing_mode: z.enum(TRIP_BILLING_MODES),
  status: z.enum(TRIP_STATUSES),
  customer_id: z.string().uuid(),
  vehicle_id: z.string().uuid().nullable(),
  driver_id: z.string().uuid().nullable(),
  pricing_source: z.enum(["FLEET", "MANUAL"]),
  snapshot_vehicle_number: z.string(),
  snapshot_vehicle_type: z.enum(VEHICLE_TYPES),
  snapshot_customer_name: z.string(),
  snapshot_customer_gstin: z.string().nullable(),
  trip_date: z.string(),
  total_km: z.number(),
  total_hours: z.number(),
  total_days: z.number(),
  subtotal_paise: z.number(),
  gross_paise: z.number(),
  net_payable_paise: z.number(),
  advance_paise: z.number(),
  finalized_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  invoice_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const tripSheetListResponseSchema = z.object({
  trips: z.array(tripSheetListRowSchema),
  pagination: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    has_more: z.boolean(),
  }),
  aggregates: z.object({
    sum_net_payable_paise: z.number(),
    sum_gross_paise: z.number(),
    count_by_status: z.record(z.string(), z.number()),
    sum_net_payable_rupees: z.string(),
    sum_gross_rupees: z.string(),
  }),
});
