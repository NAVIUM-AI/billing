/**
 * Payment + ledger API layer. All responses parse through Zod at the
 * boundary (Rule 4).
 *
 * ─── Contract notes (Part A findings) ───
 * - Recording a payment is POST /invoices/:invoiceId/payments (lives on
 *   the invoices router, not /payments — that router is list/read/cancel
 *   only). Wire fields: amount_rupees, payment_mode, reference_number
 *   (forbidden for CASH, required otherwise), received_at (optional ISO
 *   datetime — omitted here means "now" per the backend's own default).
 * - Cancel is POST /payments/:id/cancel, not an "actions" sub-path.
 * - GET /payments defaults to RECORDED-only when `status` is omitted
 *   (payment.service.js#listPayments) — the invoice-detail payments
 *   card explicitly passes status=RECORDED,CANCELLED so a cancelled
 *   payment still shows (crossed out) in that history, not just the
 *   top-level Payments screen's own default view.
 */
import { apiClient } from "@/lib/api";
import {
  cancelPaymentResultSchema,
  ledgerResponseSchema,
  paymentListResponseSchema,
  recordPaymentResultSchema,
  type PaymentFormValues,
} from "@/lib/schemas/payment";
import type { LedgerResponse } from "@/types/ledger";
import type { CancelPaymentResult, PaymentFilters, PaymentListResponse, RecordPaymentResult } from "@/types/payment";

// A plain YYYY-MM-DD date UI field coerced into the timestamptz
// received_at column. payment.validator.js#receivedAtField rejects any
// instant strictly after Date.now() — a naive fixed "noon" for TODAY'S
// date is only safe if it's already past noon locally; recording a
// payment before noon would send an instant that's technically still
// in the future and 400 (caught only by actually running the smoke
// test at a time of day before noon, not by inspection). Fix: when the
// picked date IS today, omit received_at entirely and let the backend
// default to its own `new Date()` (always valid by construction); a
// genuinely past date still uses noon, which is safe on any prior
// calendar day regardless of time-of-day.
function dateToReceivedAt(dateStr: string): string | undefined {
  const today = new Date().toISOString().slice(0, 10);
  if (dateStr === today) return undefined;
  return new Date(`${dateStr}T12:00:00`).toISOString();
}

function toRecordPaymentPayload(values: PaymentFormValues) {
  return {
    amount_rupees: Number(values.amount_rupees),
    payment_mode: values.payment_mode,
    reference_number: values.payment_mode === "CASH" ? undefined : values.reference_number?.trim() || undefined,
    received_at: dateToReceivedAt(values.payment_date),
    notes: values.notes?.trim() || undefined,
  };
}

export async function recordPayment(invoiceId: string, values: PaymentFormValues): Promise<RecordPaymentResult> {
  const res = await apiClient.post(`/invoices/${invoiceId}/payments`, toRecordPaymentPayload(values));
  return recordPaymentResultSchema.parse(res.data) as RecordPaymentResult;
}

export async function cancelPayment(paymentId: string, reason: string): Promise<CancelPaymentResult> {
  const res = await apiClient.post(`/payments/${paymentId}/cancel`, { reason });
  return cancelPaymentResultSchema.parse(res.data) as CancelPaymentResult;
}

function filtersToParams(filters: PaymentFilters) {
  return {
    customer_id: filters.customer_id || undefined,
    invoice_id: filters.invoice_id || undefined,
    payment_mode: filters.payment_mode || undefined,
    status: filters.status || undefined,
    from_date: filters.from_date || undefined,
    to_date: filters.to_date || undefined,
    limit: filters.limit,
    offset: filters.offset,
  };
}

export async function listPayments(filters: PaymentFilters): Promise<PaymentListResponse> {
  const res = await apiClient.get("/payments", { params: filtersToParams(filters) });
  return paymentListResponseSchema.parse(res.data) as PaymentListResponse;
}

// Invoice detail's payments card wants the FULL history (RECORDED and
// CANCELLED both shown, cancelled ones struck through) — see this
// file's top comment on why `status` is explicit here.
export async function listPaymentsForInvoice(invoiceId: string): Promise<PaymentListResponse> {
  return listPayments({ invoice_id: invoiceId, status: "RECORDED,CANCELLED", limit: 100, offset: 0 });
}

export async function getCustomerLedger(customerId: string): Promise<LedgerResponse> {
  const res = await apiClient.get(`/customers/${customerId}/ledger`);
  return ledgerResponseSchema.parse(res.data) as LedgerResponse;
}
