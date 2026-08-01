import { z } from "zod";

import { FUEL_TYPES, VEHICLE_TYPES } from "@/lib/constants/enums";

// Mirrors billing-backend/src/utils/vehicleNumber.js#isValidCanonical
// exactly: 2 letters (state) + 1-2 digits (RTO) + 1-3 letters (series)
// + 4 digits. Applied to the same canonical form the backend derives
// (uppercase, non-alphanumeric stripped) — a client-side fast-fail
// pre-check; the backend re-validates regardless.
const VEHICLE_NUMBER_REGEX = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$/;

function canonicalizeVehicleNumber(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function numericStringField(min: number, max: number, label: string) {
  return z
    .string()
    .optional()
    .or(z.literal(""))
    .refine((v) => {
      if (!v) return true;
      const n = Number(v);
      return Number.isInteger(n) && n >= min && n <= max;
    }, `${label} must be a whole number between ${min} and ${max}`);
}

const CURRENT_YEAR = new Date().getFullYear();

export const vehicleFormSchema = z.object({
  // Required at creation, immutable after (see vehicle.validator.js's
  // own comment) — the form disables this field entirely in edit mode
  // rather than omitting it from the schema, so the same schema works
  // for both modes.
  vehicle_number: z
    .string()
    .min(4, "Required")
    .max(30)
    .refine((v) => VEHICLE_NUMBER_REGEX.test(canonicalizeVehicleNumber(v)), "Invalid Indian vehicle registration format"),
  vehicle_type: z.enum(VEHICLE_TYPES),
  make_model: z.string().max(255).optional().or(z.literal("")),
  registration_state: z
    .string()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || /^[A-Za-z]{2}$/.test(v), "Must be a 2-letter state code"),
  seating_capacity: numericStringField(1, 60, "Seating capacity"),
  fuel_type: z.union([z.enum(FUEL_TYPES), z.literal("")]).optional(),
  year_of_manufacture: numericStringField(1990, CURRENT_YEAR + 1, "Year"),
  notes: z.string().max(2000).optional().or(z.literal("")),
});

export type VehicleFormValues = z.infer<typeof vehicleFormSchema>;

// ─── Wire response schema (Rule 4) ───
export const vehicleResponseSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  vehicle_number: z.string(),
  vehicle_number_display: z.string().nullable(),
  vehicle_type: z.enum(VEHICLE_TYPES),
  make_model: z.string().nullable(),
  registration_state: z.string().nullable(),
  seating_capacity: z.number().nullable(),
  fuel_type: z.union([z.enum(FUEL_TYPES), z.string()]).nullable(),
  year_of_manufacture: z.number().nullable(),
  notes: z.string().nullable(),
  is_active: z.boolean(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const listVehiclesResponseSchema = z.object({
  vehicles: z.array(vehicleResponseSchema),
  pagination: z.object({ total: z.number(), limit: z.number(), offset: z.number() }),
});

export const vehicleDetailResponseSchema = z.object({ vehicle: vehicleResponseSchema });
