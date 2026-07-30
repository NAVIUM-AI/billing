import { z } from "zod";

import { stateFromGstin } from "@/lib/constants/gstin";

// GSTIN format mirrors billing-backend/src/utils/gstin.js#isFormatValid
// EXACTLY (position 13 is [0-9A-Z], not the [1-9A-Z] an earlier draft
// of this schema assumed — Rule 10, the backend's actual regex wins).
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const PINCODE_REGEX = /^[0-9]{6}$/;

export const customerAddressSchema = z.object({
  line1: z.string().max(255).optional().or(z.literal("")),
  line2: z.string().max(255).optional().or(z.literal("")),
  city: z.string().max(100).optional().or(z.literal("")),
  district: z.string().max(100).optional().or(z.literal("")),
  state: z.string().max(100).optional().or(z.literal("")),
  pincode: z
    .string()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || PINCODE_REGEX.test(v), "Pincode must be 6 digits"),
  country: z.string().max(100).optional().or(z.literal("")),
});

// Mirrors customer.validator.js's shape rules, PLUS the B2B/state cross
// check customer.service.js does server-side (GSTIN_STATE_MISMATCH) —
// duplicated here as a fast client-side pre-check only; the backend
// re-validates on save regardless (see customers.api.ts's error
// mapping for when this check and the server disagree, e.g. a state
// code this frontend's map doesn't recognize).
export const customerFormSchema = z
  .object({
    customer_type: z.enum(["B2B", "B2C"]),
    name: z.string().max(255).optional().or(z.literal("")),
    company_name: z.string().max(255).optional().or(z.literal("")),
    gstin: z
      .string()
      .optional()
      .or(z.literal(""))
      .refine((v) => !v || GSTIN_REGEX.test(v.toUpperCase()), "Invalid GSTIN format"),
    pan: z
      .string()
      .optional()
      .or(z.literal(""))
      .refine((v) => !v || PAN_REGEX.test(v.toUpperCase()), "Invalid PAN format"),
    state_code: z.string().optional().or(z.literal("")),
    phone: z.string().max(20).optional().or(z.literal("")),
    email: z.string().email("Invalid email").optional().or(z.literal("")),
    address: customerAddressSchema,
    credit_days: z.coerce.number().int().min(0).max(365),
    notes: z.string().max(2000).optional().or(z.literal("")),
  })
  .superRefine((data, ctx) => {
    if (data.customer_type === "B2C") {
      if (!data.name?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["name"],
          message: "Name is required for B2C customers",
        });
      }
      if (data.company_name?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["company_name"],
          message: "B2C customers cannot have a company name",
        });
      }
      return;
    }

    // B2B: company_name, gstin, state_code all required
    // (customers_b2b_required_fields CHECK constraint, Task 2.3).
    if (!data.company_name?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["company_name"],
        message: "Company name is required for B2B customers",
      });
    }
    if (!data.gstin?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gstin"],
        message: "GSTIN is required for B2B customers",
      });
    }
    if (!data.state_code?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state_code"],
        message: "State is required for B2B customers",
      });
    }

    if (data.gstin?.trim() && data.state_code?.trim() && GSTIN_REGEX.test(data.gstin.toUpperCase())) {
      const derived = stateFromGstin(data.gstin.toUpperCase());
      if (derived && derived !== data.state_code) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["state_code"],
          message: `GSTIN belongs to a different state (expected ${derived})`,
        });
      }
    }
  });

export type CustomerFormValues = z.infer<typeof customerFormSchema>;

// Contacts have no update endpoint (see customers.api.ts's top
// comment) — this schema only ever backs a NEW contact row.
export const contactFormSchema = z
  .object({
    name: z.string().min(2, "Name is required").max(255),
    role: z.string().max(100).optional().or(z.literal("")),
    phone: z.string().max(20).optional().or(z.literal("")),
    email: z.string().email("Invalid email").optional().or(z.literal("")),
    is_primary: z.boolean().default(false),
  })
  .refine((data) => Boolean(data.phone?.trim() || data.email?.trim()), {
    message: "Provide a phone or email",
    path: ["phone"],
  });

export type ContactFormValues = z.infer<typeof contactFormSchema>;

// ─── Wire response schemas (Rule 4: parse at the API boundary) ───
// Match the real `customers` / `customer_contacts` row shapes exactly
// (customer.repository.js — snake_case, nullable columns as written in
// the Task 2.3 migration), not the flattened shape an earlier draft of
// this file assumed.

export const customerContactResponseSchema = z.object({
  id: z.string().uuid(),
  customer_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  name: z.string(),
  role: z.string().nullable(),
  phone: z.string().nullable(),
  phone_display: z.string().nullable(),
  email: z.string().nullable(),
  is_primary: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

const customerAddressResponseSchema = z.object({
  line1: z.string().nullable().optional(),
  line2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  district: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  pincode: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
});

export const customerResponseSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  customer_type: z.enum(["B2B", "B2C"]),
  name: z.string().nullable(),
  company_name: z.string().nullable(),
  gstin: z.string().nullable(),
  pan: z.string().nullable(),
  state_code: z.string().nullable(),
  phone: z.string().nullable(),
  phone_display: z.string().nullable(),
  email: z.string().nullable(),
  address: customerAddressResponseSchema.default({}),
  credit_days: z.number(),
  notes: z.string().nullable(),
  is_active: z.boolean(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  contacts: z.array(customerContactResponseSchema).optional(),
});

export const listCustomersResponseSchema = z.object({
  customers: z.array(customerResponseSchema),
  pagination: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  }),
});

export const customerDetailResponseSchema = z.object({
  customer: customerResponseSchema,
});

export const contactListResponseSchema = z.object({
  contacts: z.array(customerContactResponseSchema),
});

export const contactDetailResponseSchema = z.object({
  contact: customerContactResponseSchema,
});
