import { z } from "zod";

import { RULE_TYPES, VEHICLE_TYPES } from "@/lib/constants/enums";

function numericStringField(min: number, label: string) {
  return z
    .string()
    .optional()
    .or(z.literal(""))
    .refine((v) => {
      if (!v) return true;
      const n = Number(v);
      return Number.isFinite(n) && n >= min;
    }, `${label} must be a number >= ${min}`);
}

// Mirrors pricingRule.service.js#REQUIRED_FIELDS_BY_TYPE exactly (in
// *_rupees/count form, not *_paise — this is the form's own field
// naming). A client-side fast-fail pre-check; the backend enforces the
// same requirement via DB CHECK constraints regardless.
const REQUIRED_FIELDS_BY_TYPE: Record<string, { key: string; label: string }[]> = {
  LOCAL_PACKAGE: [
    { key: "base_hours", label: "Base hours" },
    { key: "base_km", label: "Base km" },
    { key: "base_price_rupees", label: "Base price" },
    { key: "extra_km_rate_rupees", label: "Extra km rate" },
    { key: "extra_hr_rate_rupees", label: "Extra hour rate" },
  ],
  OUTSTATION_SLAB: [
    { key: "slab_rate_rupees", label: "Slab rate" },
    { key: "min_km_per_day", label: "Min km/day" },
    { key: "driver_batta_per_day_rupees", label: "Driver batta/day" },
  ],
  PERFORMANCE: [
    { key: "per_km_rate_rupees", label: "Per-km rate" },
    { key: "performance_batta_rupees", label: "Batta" },
  ],
};

export const pricingRuleFormSchema = z
  .object({
    rule_type: z.enum(RULE_TYPES),
    vehicle_type: z.enum(VEHICLE_TYPES),
    label: z.string().min(2, "Required").max(255),
    notes: z.string().max(2000).optional().or(z.literal("")),
    effective_from: z.string().min(1, "Required"),

    base_hours: numericStringField(0, "Base hours"),
    base_km: numericStringField(0, "Base km"),
    base_price_rupees: numericStringField(0, "Base price"),
    extra_km_rate_rupees: numericStringField(0, "Extra km rate"),
    extra_hr_rate_rupees: numericStringField(0, "Extra hour rate"),

    slab_rate_rupees: numericStringField(0, "Slab rate"),
    min_km_per_day: numericStringField(0, "Min km/day"),
    driver_batta_per_day_rupees: numericStringField(0, "Driver batta/day"),

    per_km_rate_rupees: numericStringField(0, "Per-km rate"),
    performance_batta_rupees: numericStringField(0, "Batta"),
  })
  .superRefine((data, ctx) => {
    const required = REQUIRED_FIELDS_BY_TYPE[data.rule_type] || [];
    for (const field of required) {
      const value = (data as Record<string, unknown>)[field.key];
      if (!value && value !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field.key],
          message: `${field.label} is required for this rule type`,
        });
      }
    }
  });

export type PricingRuleFormValues = z.infer<typeof pricingRuleFormSchema>;

// ─── Wire response schema (Rule 4) ───
export const pricingRuleResponseSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  rule_type: z.enum(RULE_TYPES),
  vehicle_type: z.enum(VEHICLE_TYPES),
  label: z.string(),
  base_hours: z.number().nullable(),
  base_km: z.number().nullable(),
  base_price_paise: z.number().nullable(),
  extra_km_rate_paise: z.number().nullable(),
  extra_hr_rate_paise: z.number().nullable(),
  slab_rate_paise: z.number().nullable(),
  min_km_per_day: z.number().nullable(),
  driver_batta_per_day_paise: z.number().nullable(),
  per_km_rate_paise: z.number().nullable(),
  performance_batta_paise: z.number().nullable(),
  effective_from: z.string(),
  effective_to: z.string().nullable(),
  notes: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const listPricingRulesResponseSchema = z.object({
  rules: z.array(pricingRuleResponseSchema),
  pagination: z.object({ total: z.number(), limit: z.number(), offset: z.number() }),
});

export const pricingRuleDetailResponseSchema = z.object({ rule: pricingRuleResponseSchema });

export const supersedeResponseSchema = z.object({
  superseded: pricingRuleResponseSchema,
  new_rule: pricingRuleResponseSchema,
});
