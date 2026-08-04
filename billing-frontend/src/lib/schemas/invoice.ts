import { z } from "zod";

import { TRIP_SERVICE_TYPES, VEHICLE_TYPES } from "@/lib/constants/enums";

const INVOICE_TYPES = ["TAX", "PERFORMANCE"] as const;
const INVOICE_STATUSES = ["DRAFT", "ISSUED", "PAID", "CANCELLED"] as const;

// ─── Wizard form (Rule 4 — collected client-side, shaped to the wire
// payload by invoices.api.ts's toCreatePayload) ───
// Mirrors invoice.validator.js#createInvoiceSchema's real field set —
// no discount/toll/permit/fasttag overrides in the wizard (out of
// scope for F4a; the backend auto-sums those from the selected trips
// regardless, per computeEffectiveReimbursements).
export const invoiceWizardSchema = z.object({
  customer_id: z.string().min(1, "Customer is required"),
  invoice_type: z.enum(INVOICE_TYPES),
  service_type: z.enum(TRIP_SERVICE_TYPES),
  trip_sheet_ids: z.array(z.string()).min(1, "Select at least one trip"),
  invoice_date: z.string().min(1, "Required"),
  due_date: z.string().optional().or(z.literal("")),
  notes: z.string().max(2000).optional().or(z.literal("")),
  reverse_charge: z.boolean(),
});
export type InvoiceWizardValues = z.infer<typeof invoiceWizardSchema>;

// PATCH /invoices/:id — DRAFT-only edit. customer_id/invoice_type/
// service_type are immutable post-create (service_type is literally
// Joi.any().forbidden() server-side — Task 4.9), so this form never
// collects them; the edit page shows them read-only instead.
export const invoiceEditSchema = z.object({
  trip_sheet_ids: z.array(z.string()).min(1, "Select at least one trip"),
  invoice_date: z.string().min(1, "Required"),
  notes: z.string().max(2000).optional().or(z.literal("")),
  reverse_charge: z.boolean(),
});
export type InvoiceEditValues = z.infer<typeof invoiceEditSchema>;

export const invoiceCancelSchema = z.object({
  reason: z.string().trim().min(3, "Reason must be at least 3 characters").max(500),
});
export type InvoiceCancelValues = z.infer<typeof invoiceCancelSchema>;

// ─── Wire response schemas (Rule 4) ───
const invoiceLineResponseSchema = z.object({
  id: z.string().uuid(),
  invoice_id: z.string().uuid(),
  trip_sheet_id: z.string().uuid(),
  line_number: z.number(),
  service_type: z.enum(TRIP_SERVICE_TYPES),
  trip_date: z.string(),
  vehicle_number: z.string(),
  vehicle_type: z.enum(VEHICLE_TYPES),
  total_km: z.number(),
  total_hours: z.number().nullable(),
  total_days: z.number().nullable(),
  base_amount_paise: z.number(),
  extras_amount_paise: z.number(),
  driver_batta_paise: z.number(),
  line_amount_paise: z.number(),
  hsn_sac_code: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
});

const snapshotSchema = z.record(z.string(), z.unknown()).nullable();

export const invoiceResponseSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  invoice_number: z.string().nullable(),
  invoice_type: z.enum(INVOICE_TYPES),
  service_type: z.enum(TRIP_SERVICE_TYPES).nullable(),
  status: z.enum(INVOICE_STATUSES),
  customer_id: z.string().uuid(),

  invoice_date: z.string(),
  due_date: z.string(),
  notes: z.string().nullable(),
  terms: z.string().nullable(),

  subtotal_paise: z.number(),
  gst_rate_snapshot: z.number().nullable(),
  cgst_paise: z.number(),
  sgst_paise: z.number(),
  igst_paise: z.number(),
  total_gst_paise: z.number(),

  toll_paise: z.number(),
  parking_paise: z.number(),
  permit_paise: z.number(),
  fasttag_paise: z.number(),
  toll_manual_override: z.boolean(),
  parking_manual_override: z.boolean(),
  permit_manual_override: z.boolean(),
  fasttag_manual_override: z.boolean(),

  discount_paise: z.number(),
  discount_reason: z.string().nullable(),

  round_off_paise: z.number(),
  grand_total_paise: z.number(),
  net_payable_paise: z.number(),
  amount_in_words: z.string().nullable(),

  reverse_charge: z.boolean().nullable(),

  tenant_snapshot: snapshotSchema,
  customer_snapshot: snapshotSchema,

  pdf_url: z.string().nullable(),
  pdf_generated_at: z.string().nullable(),
  pdf_template_version: z.string().nullable(),

  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  issued_at: z.string().nullable(),
  issued_by: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  cancelled_by: z.string().nullable(),
  cancellation_reason: z.string().nullable(),
  credit_note_id: z.string().nullable(),

  // Optional with a default, not required: invoice.service.js#cancelInvoice
  // is the one mutating endpoint that returns the raw invoices row
  // WITHOUT ever attaching a lines array (every other endpoint —
  // create/update/issue/getInvoice — explicitly spreads `{ ...invoice,
  // lines }`). Confirmed by curling POST /invoices/:id/cancel directly.
  // Harmless to default to [] here: the detail page's own subsequent
  // getInvoice() refetch (triggered by useCancelInvoice's query
  // invalidation) is what actually supplies the real lines for display.
  lines: z.array(invoiceLineResponseSchema).optional().default([]),
  customer: z
    .object({
      id: z.string().uuid(),
      customer_type: z.enum(["B2B", "B2C"]),
      name: z.string().nullable(),
      company_name: z.string().nullable(),
      gstin: z.string().nullable(),
      state_code: z.string().nullable(),
    })
    .nullable()
    .optional(),
  tenant: z
    .object({ id: z.string().uuid(), name: z.string(), gstin: z.string().nullable(), state_code: z.string().nullable() })
    .nullable()
    .optional(),
});

export const invoiceDetailResponseSchema = z.object({ invoice: invoiceResponseSchema });

const invoiceListRowSchema = z.object({
  id: z.string().uuid(),
  invoice_number: z.string().nullable(),
  invoice_type: z.enum(INVOICE_TYPES),
  service_type: z.enum(TRIP_SERVICE_TYPES).nullable(),
  status: z.enum(INVOICE_STATUSES),
  customer_id: z.string().uuid(),
  customer_name: z.string().nullable(),
  invoice_date: z.string(),
  gross_amount_paise: z.number(),
  issued_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const invoiceListResponseSchema = z.object({
  invoices: z.array(invoiceListRowSchema),
  pagination: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    has_more: z.boolean(),
  }),
});

const invoiceableTripSchema = z.object({
  id: z.string().uuid(),
  trip_sheet_number: z.string(),
  trip_date: z.string(),
  service_type: z.enum(TRIP_SERVICE_TYPES),
  billing_mode: z.enum(["GST", "PERFORMANCE"]),
  snapshot_vehicle_number: z.string(),
  total_km: z.number(),
  toll_paise: z.number(),
  parking_paise: z.number(),
  permit_paise: z.number(),
  fasttag_paise: z.number(),
  subtotal_paise: z.number(),
  gross_paise: z.number(),
  net_payable_paise: z.number(),
});

const invoiceableTripsGroupSchema = z.object({
  trips: z.array(invoiceableTripSchema),
  summary: z.object({
    count: z.number(),
    total_km: z.number(),
    total_subtotal_paise: z.number(),
    total_gross_paise: z.number(),
    total_net_payable_paise: z.number(),
  }),
});

export const invoiceableTripsResponseSchema = z.object({
  customer: z.object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    company_name: z.string().nullable(),
    customer_type: z.enum(["B2B", "B2C"]),
    gstin: z.string().nullable(),
    state_code: z.string().nullable(),
    credit_days: z.number(),
  }),
  groups: z.object({
    LOCAL: invoiceableTripsGroupSchema,
    OUTSTATION: invoiceableTripsGroupSchema,
  }),
  total_summary: invoiceableTripsGroupSchema.shape.summary,
});

export const creditNoteResponseSchema = z.object({
  credit_note: z.object({
    id: z.string().uuid(),
    credit_note_number: z.string(),
    original_invoice_id: z.string().uuid(),
    net_payable_paise: z.number(),
    reason: z.string(),
    created_at: z.string(),
  }),
});
