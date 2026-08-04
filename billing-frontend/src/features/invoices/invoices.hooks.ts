import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import * as invoicesApi from "@/features/invoices/invoices.api";
import { queryKeys } from "@/lib/queryKeys";
import type { InvoiceCancelValues, InvoiceEditValues, InvoiceWizardValues } from "@/lib/schemas/invoice";
import type { InvoiceFilters } from "@/types/invoice";

export function useInvoices(filters: InvoiceFilters) {
  return useQuery({
    queryKey: queryKeys.invoices.list(filters),
    queryFn: () => invoicesApi.listInvoices(filters),
    placeholderData: (previous) => previous,
  });
}

export function useInvoice(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.invoices.detail(id ?? ""),
    queryFn: () => invoicesApi.getInvoice(id as string),
    enabled: Boolean(id),
  });
}

export function useCreditNote(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.creditNotes.detail(id ?? ""),
    queryFn: () => invoicesApi.getCreditNote(id as string),
    enabled: Boolean(id),
  });
}

export function useInvoiceableTrips(customerId: string | undefined, invoiceId?: string) {
  return useQuery({
    queryKey: queryKeys.invoices.invoiceableTrips(customerId ?? "", invoiceId),
    queryFn: () => invoicesApi.getInvoiceableTrips(customerId as string, invoiceId),
    enabled: Boolean(customerId),
  });
}

export function useCreateInvoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: InvoiceWizardValues) => invoicesApi.createInvoice(values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.lists() });
    },
  });
}

export function useUpdateInvoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: InvoiceEditValues }) => invoicesApi.updateInvoice(id, values),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.lists() });
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.detail(variables.id) });
    },
  });
}

export function useDeleteInvoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoicesApi.deleteInvoice(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.lists() });
    },
  });
}

// Issuing an invoice moves every one of its trips FINALIZED -> INVOICED
// server-side (invoice.service.js#issueInvoice) — invalidate the trips
// list too, or a trip picker/trip list open in another tab would keep
// showing them as still-invoiceable.
export function useIssueInvoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoicesApi.issueInvoice(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.lists() });
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.detail(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tripSheets.all });
    },
  });
}

// Cancelling reverses every trip back to FINALIZED (re-invoiceable) —
// same invalidation reasoning as issue, above.
export function useCancelInvoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: InvoiceCancelValues }) => invoicesApi.cancelInvoice(id, values),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.lists() });
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.detail(variables.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tripSheets.all });
    },
  });
}

export function useGenerateInvoicePdf() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoicesApi.generateInvoicePdf(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.detail(id) });
    },
  });
}

export function useDownloadInvoicePdf() {
  return useMutation({
    mutationFn: (id: string) => invoicesApi.downloadInvoicePdf(id),
    onSuccess: ({ blob, filename }) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
  });
}

// Composed action behind the wizard/edit page's single "Save & Issue"
// button (Rule 10 correction #5 — PDF generation is a separate POST
// step, not automatic at issue). Fires issue -> generate-pdf
// sequentially under one loading state so the UI never exposes the
// two-step nature of the underlying API.
export function useIssueAndGeneratePdf() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const invoice = await invoicesApi.issueInvoice(id);
      await invoicesApi.generateInvoicePdf(id);
      return invoice;
    },
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.lists() });
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.detail(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tripSheets.all });
    },
  });
}
