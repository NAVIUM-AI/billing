import { AxiosError } from "axios";
import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { TripPickerFields } from "@/features/invoices/components/TripPickerFields";
import {
  useDeleteInvoice,
  useInvoice,
  useIssueAndGeneratePdf,
  useUpdateInvoice,
} from "@/features/invoices/invoices.hooks";
import type { TripServiceType } from "@/lib/constants/enums";
import type { ApiErrorResponse } from "@/types/api";

function extractApiMessage(err: unknown): string {
  if (err instanceof AxiosError) {
    return (err.response?.data as ApiErrorResponse | undefined)?.error?.message || "Something went wrong.";
  }
  return "Cannot reach server. Try again.";
}

export function InvoiceDraftEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: invoice, isLoading } = useInvoice(id);
  const updateInvoice = useUpdateInvoice();
  const deleteInvoice = useDeleteInvoice();
  const issueAndGeneratePdf = useIssueAndGeneratePdf();

  const [tripSheetIds, setTripSheetIds] = useState<string[]>([]);
  const [invoiceDate, setInvoiceDate] = useState("");
  const [notes, setNotes] = useState("");
  const [reverseCharge, setReverseCharge] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Hydrate local form state from the fetched invoice exactly once —
  // not on every refetch, so an in-progress edit isn't clobbered by a
  // background revalidation (same pattern as CustomerFormDrawer).
  useEffect(() => {
    if (!invoice || hydrated) return;
    setTripSheetIds(invoice.lines.map((l) => l.trip_sheet_id));
    setInvoiceDate(invoice.invoice_date);
    setNotes(invoice.notes ?? "");
    setReverseCharge(Boolean(invoice.reverse_charge));
    setHydrated(true);
  }, [invoice, hydrated]);

  if (isLoading || !invoice) {
    return <p className="text-sm text-gray-500">Loading...</p>;
  }

  if (invoice.status !== "DRAFT") {
    return <Navigate to={`/invoices/${invoice.id}`} replace />;
  }

  async function handleSave() {
    try {
      await updateInvoice.mutateAsync({
        id: invoice!.id,
        values: { trip_sheet_ids: tripSheetIds, invoice_date: invoiceDate, notes, reverse_charge: reverseCharge },
      });
      toast.success("Invoice updated");
    } catch (err) {
      toast.error(extractApiMessage(err));
    }
  }

  async function handleIssue() {
    try {
      await issueAndGeneratePdf.mutateAsync(invoice!.id);
      toast.success("Invoice issued");
      navigate(`/invoices/${invoice!.id}`);
    } catch (err) {
      toast.error(extractApiMessage(err));
    }
  }

  async function handleDelete() {
    try {
      await deleteInvoice.mutateAsync(invoice!.id);
      toast.success("Draft invoice deleted");
      navigate("/invoices");
    } catch (err) {
      toast.error(extractApiMessage(err));
    }
  }

  const customerLabel =
    invoice.customer?.customer_type === "B2B" ? invoice.customer.company_name : invoice.customer?.name;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={`Edit Draft Invoice`}
        description={`${customerLabel ?? "—"} · ${invoice.invoice_type === "TAX" ? "GST Invoice" : "Proforma Invoice"}`}
        action={
          <div className="flex gap-2">
            <Button type="button" variant="secondary" className="text-red-600" onClick={() => setDeleteOpen(true)}>
              Delete
            </Button>
            <Button type="button" variant="secondary" onClick={handleSave} disabled={updateInvoice.isPending}>
              {updateInvoice.isPending ? "Saving..." : "Save"}
            </Button>
            <Button
              type="button"
              onClick={handleIssue}
              disabled={issueAndGeneratePdf.isPending || tripSheetIds.length === 0}
              className="bg-primary-500 hover:bg-primary-600"
            >
              {issueAndGeneratePdf.isPending ? "Issuing..." : "Issue"}
            </Button>
          </div>
        }
      />

      <div className="rounded-lg border bg-white p-6">
        <div className="mb-6 grid grid-cols-3 gap-4 text-sm">
          <ReadOnlyField label="Customer" value={customerLabel ?? "—"} />
          <ReadOnlyField label="Invoice Type" value={invoice.invoice_type === "TAX" ? "GST Invoice" : "Proforma Invoice"} />
          <ReadOnlyField label="Service Type" value={invoice.service_type ?? "—"} />
        </div>

        <TripPickerFields
          customerId={invoice.customer_id}
          invoiceType={invoice.invoice_type}
          serviceType={(invoice.service_type ?? "LOCAL") as TripServiceType}
          onServiceTypeChange={() => {
            /* immutable post-create — see lockServiceType below */
          }}
          lockServiceType
          invoiceDate={invoiceDate}
          onInvoiceDateChange={setInvoiceDate}
          tripSheetIds={tripSheetIds}
          onTripSheetIdsChange={setTripSheetIds}
          reverseCharge={reverseCharge}
          onReverseChargeChange={setReverseCharge}
          notes={notes}
          onNotesChange={setNotes}
          invoiceIdForEdit={invoice.id}
        />
      </div>

      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this draft invoice?"
        description="This cannot be undone. Any held trips will be released and become invoiceable again."
        onConfirm={handleDelete}
        isLoading={deleteInvoice.isPending}
      />
    </div>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-gray-900">{value}</div>
    </div>
  );
}
