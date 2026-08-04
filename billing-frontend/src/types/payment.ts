// Mirrors billing-backend/src/validators/payment.validator.js#PAYMENT_MODES
// exactly — 8 modes, not the 4 an earlier draft of this task assumed.
export const PAYMENT_MODES = ["CASH", "UPI", "NEFT", "RTGS", "IMPS", "CHEQUE", "CARD", "BANK_TRANSFER"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  CASH: "Cash",
  UPI: "UPI",
  NEFT: "NEFT",
  RTGS: "RTGS",
  IMPS: "IMPS",
  CHEQUE: "Cheque",
  CARD: "Card",
  BANK_TRANSFER: "Bank Transfer",
};

export const PAYMENT_STATUSES = ["RECORDED", "CANCELLED"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

// Matches the `payments` table exactly (raw SELECT * row —
// payment.repository.js never narrows the column set). invoice_id null
// means this row is an unallocated advance (payment.service.js's own
// convention, not a separate DB concept).
export interface Payment {
  id: string;
  tenant_id: string;
  customer_id: string;
  invoice_id: string | null;
  parent_payment_id: string | null;
  amount_paise: number;
  payment_mode: PaymentMode;
  reference_number: string | null;
  received_at: string;
  status: PaymentStatus;
  notes: string | null;
  recorded_by: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentFilters {
  search?: string;
  customer_id?: string;
  invoice_id?: string;
  payment_mode?: PaymentMode;
  status?: string;
  from_date?: string;
  to_date?: string;
  limit?: number;
  offset?: number;
}

export interface PaymentListResponse {
  payments: Payment[];
  pagination: { total: number; limit: number; offset: number; has_more: boolean };
}

// POST /invoices/:id/payments response (payment.service.js#recordPaymentOnInvoice).
export interface RecordPaymentResult {
  payment: Payment;
  spillover_advance: Payment | null;
  invoice_transitioned_to_paid: boolean;
}

// POST /payments/:id/cancel response.
export interface CancelPaymentResult {
  payment: Payment;
  invoice_reverted: boolean;
}
