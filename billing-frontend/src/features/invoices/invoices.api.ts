/**
 * Invoice API layer. All responses parse through Zod at the boundary
 * (Rule 4).
 *
 * ─── Contract notes (Task 4.9 + Part A findings) ───
 * - GET /invoices (tenant-wide list) is gated on reports:read, not
 *   invoices:read — everything else here stays on invoices:*.
 * - service_type is immutable after create (Joi.any().forbidden() on
 *   PATCH) — toUpdatePayload() never sends it.
 * - PDF generation is a SEPARATE POST step from issue, not automatic.
 *   useIssueAndGeneratePdf (in invoices.hooks.ts) composes both.
 * - The list row's money field is `gross_amount_paise`, a SQL alias for
 *   the real `net_payable_paise` column — see types/invoice.ts's
 *   comment. The detail response has the real column name.
 */
import { apiClient } from "@/lib/api";
import {
  creditNoteResponseSchema,
  invoiceableTripsResponseSchema,
  invoiceCancelSchema,
  invoiceDetailResponseSchema,
  invoiceListResponseSchema,
  type InvoiceEditValues,
  type InvoiceWizardValues,
} from "@/lib/schemas/invoice";
import type { z } from "zod";
import type {
  Invoice,
  InvoiceableTripsResponse,
  InvoiceFilters,
  InvoiceListResponse,
} from "@/types/invoice";

function toCreatePayload(values: InvoiceWizardValues) {
  return {
    customer_id: values.customer_id,
    invoice_type: values.invoice_type,
    service_type: values.service_type,
    trip_sheet_ids: values.trip_sheet_ids,
    invoice_date: values.invoice_date,
    due_date: values.due_date || undefined,
    notes: values.notes || undefined,
    reverse_charge: values.invoice_type === "TAX" ? values.reverse_charge : undefined,
  };
}

// service_type is genuinely absent here (not just stripped) — see this
// file's top comment. customer_id/invoice_type aren't collected by the
// edit form at all (read-only post-create), so there's nothing to
// delete/strip for them.
function toUpdatePayload(values: InvoiceEditValues) {
  return {
    trip_sheet_ids: values.trip_sheet_ids,
    invoice_date: values.invoice_date,
    notes: values.notes || undefined,
    reverse_charge: values.reverse_charge,
  };
}

function filtersToParams(filters: InvoiceFilters) {
  return {
    search: filters.search || undefined,
    status: filters.status || undefined,
    invoice_type: filters.invoice_type || undefined,
    service_type: filters.service_type || undefined,
    customer_id: filters.customer_id || undefined,
    date_from: filters.date_from || undefined,
    date_to: filters.date_to || undefined,
    limit: filters.limit,
    offset: filters.offset,
  };
}

export async function listInvoices(filters: InvoiceFilters): Promise<InvoiceListResponse> {
  const res = await apiClient.get("/invoices", { params: filtersToParams(filters) });
  return invoiceListResponseSchema.parse(res.data) as InvoiceListResponse;
}

export async function getInvoice(id: string): Promise<Invoice> {
  const res = await apiClient.get(`/invoices/${id}`);
  return invoiceDetailResponseSchema.parse(res.data).invoice as Invoice;
}

export async function createInvoice(values: InvoiceWizardValues): Promise<Invoice> {
  const res = await apiClient.post("/invoices", toCreatePayload(values));
  return invoiceDetailResponseSchema.parse(res.data).invoice as Invoice;
}

export async function updateInvoice(id: string, values: InvoiceEditValues): Promise<Invoice> {
  const res = await apiClient.patch(`/invoices/${id}`, toUpdatePayload(values));
  return invoiceDetailResponseSchema.parse(res.data).invoice as Invoice;
}

export async function deleteInvoice(id: string): Promise<void> {
  await apiClient.delete(`/invoices/${id}`);
}

export async function issueInvoice(id: string): Promise<Invoice> {
  const res = await apiClient.post(`/invoices/${id}/issue`, {});
  return invoiceDetailResponseSchema.parse(res.data).invoice as Invoice;
}

export async function cancelInvoice(id: string, values: z.infer<typeof invoiceCancelSchema>): Promise<Invoice> {
  const res = await apiClient.post(`/invoices/${id}/cancel`, values);
  return invoiceDetailResponseSchema.parse(res.data).invoice as Invoice;
}

export async function generateInvoicePdf(id: string): Promise<{ pdf_url: string }> {
  const res = await apiClient.post(`/invoices/${id}/pdf`);
  return res.data;
}

export async function downloadInvoicePdf(id: string): Promise<{ blob: Blob; filename: string }> {
  const res = await apiClient.get(`/invoices/${id}/pdf`, { responseType: "blob" });
  const disposition = (res.headers["content-disposition"] as string | undefined) || "";
  const match = /filename="?([^"]+)"?/.exec(disposition);
  return { blob: res.data as Blob, filename: match?.[1] || `invoice-${id}.pdf` };
}

export async function getInvoiceableTrips(
  customerId: string,
  invoiceId?: string,
): Promise<InvoiceableTripsResponse> {
  const res = await apiClient.get(`/customers/${customerId}/invoiceable-trips`, {
    params: { invoice_id: invoiceId || undefined },
  });
  return invoiceableTripsResponseSchema.parse(res.data) as InvoiceableTripsResponse;
}

// Detail page display only (F4b builds the real credit notes screen) —
// just enough to show "credit_note_number" next to a cancelled
// invoice's cancellation reason.
export async function getCreditNote(id: string) {
  const res = await apiClient.get(`/credit-notes/${id}`);
  return creditNoteResponseSchema.parse(res.data).credit_note;
}
