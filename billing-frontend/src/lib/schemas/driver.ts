import { z } from "zod";

export const driverFormSchema = z.object({
  full_name: z.string().min(2, "Required").max(255),
  phone: z.string().max(20).optional().or(z.literal("")),
  license_number: z.string().max(30).optional().or(z.literal("")),
  // Native <input type="date"> already only emits "" or a valid
  // YYYY-MM-DD string — no extra format validation needed here.
  license_expiry_date: z.string().optional().or(z.literal("")),
  address_line: z.string().max(500).optional().or(z.literal("")),
  emergency_contact: z.string().max(20).optional().or(z.literal("")),
  notes: z.string().max(2000).optional().or(z.literal("")),
});

export type DriverFormValues = z.infer<typeof driverFormSchema>;

// ─── Wire response schema (Rule 4) ───
export const driverResponseSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  full_name: z.string(),
  phone: z.string().nullable(),
  phone_display: z.string().nullable(),
  license_number: z.string().nullable(),
  license_expiry_date: z.string().nullable(),
  address_line: z.string().nullable(),
  emergency_contact: z.string().nullable(),
  notes: z.string().nullable(),
  is_active: z.boolean(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const listDriversResponseSchema = z.object({
  drivers: z.array(driverResponseSchema),
  pagination: z.object({ total: z.number(), limit: z.number(), offset: z.number() }),
});

export const driverDetailResponseSchema = z.object({ driver: driverResponseSchema });
