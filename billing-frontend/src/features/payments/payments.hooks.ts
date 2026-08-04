import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import * as paymentsApi from "@/features/payments/payments.api";
import { queryKeys } from "@/lib/queryKeys";
import type { PaymentFormValues } from "@/lib/schemas/payment";
import type { PaymentFilters } from "@/types/payment";

export function usePayments(filters: PaymentFilters) {
  return useQuery({
    queryKey: queryKeys.payments.list(filters),
    queryFn: () => paymentsApi.listPayments(filters),
    placeholderData: (previous) => previous,
  });
}

export function usePaymentsForInvoice(invoiceId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.payments.forInvoice(invoiceId ?? ""),
    queryFn: () => paymentsApi.listPaymentsForInvoice(invoiceId as string),
    enabled: Boolean(invoiceId),
  });
}

export function useLedger(customerId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.ledger.detail(customerId ?? ""),
    queryFn: () => paymentsApi.getCustomerLedger(customerId as string),
    enabled: Boolean(customerId),
  });
}

// A payment changes: the invoice it applies to (status may flip
// ISSUED<->PAID), that invoice's own payment history, the owning
// customer's ledger, the tenant-wide payments list, and the aging
// report (an invoice's outstanding balance just moved). Every mutation
// below invalidates all five — cheaper to over-invalidate here than to
// leave a stale outstanding/PAID-status figure on screen.
function invalidatePaymentSideEffects(
  queryClient: ReturnType<typeof useQueryClient>,
  invoiceId: string | null,
  customerId: string,
) {
  if (invoiceId) {
    queryClient.invalidateQueries({ queryKey: queryKeys.invoices.detail(invoiceId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.payments.forInvoice(invoiceId) });
  }
  queryClient.invalidateQueries({ queryKey: queryKeys.invoices.lists() });
  queryClient.invalidateQueries({ queryKey: queryKeys.ledger.detail(customerId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.payments.lists() });
  queryClient.invalidateQueries({ queryKey: queryKeys.aging.all });
}

export function useRecordPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ invoiceId, values }: { invoiceId: string; values: PaymentFormValues }) =>
      paymentsApi.recordPayment(invoiceId, values),
    onSuccess: (data, variables) => {
      invalidatePaymentSideEffects(queryClient, variables.invoiceId, data.payment.customer_id);
    },
  });
}

export function useCancelPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentId, reason }: { paymentId: string; reason: string }) =>
      paymentsApi.cancelPayment(paymentId, reason),
    onSuccess: (data) => {
      invalidatePaymentSideEffects(queryClient, data.payment.invoice_id, data.payment.customer_id);
    },
  });
}
