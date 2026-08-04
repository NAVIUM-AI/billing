import { z } from "zod";

import { PAYMENT_MODES } from "@/types/payment";

function numericStringField(min: number, label: string) {
  return z.string().refine((v) => {
    const n = Number(v);
    return v !== "" && Number.isFinite(n) && n > min;
  }, `${label} must be a number greater than ${min}`);
}

const today = () => new Date().toISOString().slice(0, 10);

// Mirrors payment.validator.js#recordPaymentSchema's shape (wire field
// names: amount_rupees/payment_mode/reference_number/received_at) —
// reference_number is FORBIDDEN for CASH (not just optional) and
// REQUIRED for every other mode, same conditional the backend's own
// Joi `.when()` encodes.
export const paymentFormSchema = z
  .object({
    payment_mode: z.enum(PAYMENT_MODES),
    amount_rupees: numericStringField(0, "Amount"),
    payment_date: z
      .string()
      .min(1, "Required")
      .refine((v) => v <= today(), "payment_date cannot be in the future"),
    reference_number: z.string().max(100).optional().or(z.literal("")),
    notes: z.string().max(500).optional().or(z.literal("")),
  })
  .superRefine((data, ctx) => {
    if (data.payment_mode !== "CASH" && !data.reference_number?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reference_number"],
        message: "Reference is required for this payment mode",
      });
    }
  });
export type PaymentFormValues = z.infer<typeof paymentFormSchema>;

export const paymentCancelSchema = z.object({
  reason: z.string().trim().min(3, "Reason must be at least 3 characters").max(500),
});
export type PaymentCancelValues = z.infer<typeof paymentCancelSchema>;

// ─── Wire response schemas (Rule 4) ───
const paymentResponseSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  invoice_id: z.string().uuid().nullable(),
  parent_payment_id: z.string().uuid().nullable(),
  amount_paise: z.number(),
  payment_mode: z.enum(PAYMENT_MODES),
  reference_number: z.string().nullable(),
  received_at: z.string(),
  status: z.enum(["RECORDED", "CANCELLED"]),
  notes: z.string().nullable(),
  recorded_by: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  cancelled_by: z.string().nullable(),
  cancellation_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const recordPaymentResultSchema = z.object({
  payment: paymentResponseSchema,
  spillover_advance: paymentResponseSchema.nullable(),
  invoice_transitioned_to_paid: z.boolean(),
});

export const cancelPaymentResultSchema = z.object({
  payment: paymentResponseSchema,
  invoice_reverted: z.boolean(),
});

export const paymentDetailResponseSchema = z.object({ payment: paymentResponseSchema });

export const paymentListResponseSchema = z.object({
  payments: z.array(paymentResponseSchema),
  pagination: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    has_more: z.boolean(),
  }),
});

// ─── Ledger wire response (Rule 4) ───
const invoiceLedgerEntrySchema = z.object({
  type: z.literal("INVOICE"),
  invoice_id: z.string().uuid(),
  invoice_number: z.string().nullable(),
  invoice_date: z.string(),
  due_date: z.string(),
  debit_paise: z.number(),
  status: z.enum(["DRAFT", "ISSUED", "PAID", "CANCELLED"]),
  running_balance_paise: z.number(),
});

const paymentLedgerEntrySchema = z.object({
  type: z.literal("PAYMENT"),
  payment_id: z.string().uuid(),
  invoice_id: z.string().uuid().nullable(),
  received_at: z.string(),
  credit_paise: z.number(),
  payment_mode: z.enum(PAYMENT_MODES),
  reference_number: z.string().nullable(),
  running_balance_paise: z.number(),
});

export const ledgerResponseSchema = z.object({
  customer: z.object({
    id: z.string().uuid(),
    customer_type: z.enum(["B2B", "B2C"]),
    name: z.string().nullable(),
    company_name: z.string().nullable(),
    gstin: z.string().nullable(),
    state_code: z.string().nullable(),
    credit_days: z.number(),
  }),
  summary: z.object({
    total_invoiced_paise: z.number(),
    total_paid_paise: z.number(),
    total_cancelled_paise: z.number(),
    unallocated_advance_paise: z.number(),
    outstanding_paise: z.number(),
  }),
  entries: z.array(z.discriminatedUnion("type", [invoiceLedgerEntrySchema, paymentLedgerEntrySchema])),
});
