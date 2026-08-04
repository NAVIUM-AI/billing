import { AxiosError } from "axios";
import { useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { InvoiceStatusBadge } from "@/features/invoices/components/InvoiceStatusBadge";
import {
  useCancelInvoice,
  useCreditNote,
  useDeleteInvoice,
  useDownloadInvoicePdf,
  useGenerateInvoicePdf,
  useInvoice,
  useIssueInvoice,
} from "@/features/invoices/invoices.hooks";
import { formatPaiseAsRupees } from "@/lib/money";
import type { ApiErrorResponse } from "@/types/api";

function extractApiMessage(err: unknown): string {
  if (err instanceof AxiosError) {
    return (err.response?.data as ApiErrorResponse | undefined)?.error?.message || "Something went wrong.";
  }
  return "Cannot reach server. Try again.";
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-sm text-gray-900">{value ?? "—"}</div>
    </div>
  );
}

function CancelInvoiceDialog({
  open,
  onOpenChange,
  onConfirm,
  isLoading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
  isLoading: boolean;
}) {
  const [reason, setReason] = useState("");
  const trimmedLen = reason.trim().length;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) setReason("");
        onOpenChange(next);
      }}
      title="Cancel this invoice?"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Back
          </Button>
          <Button
            type="button"
            disabled={trimmedLen < 3 || isLoading}
            onClick={() => onConfirm(reason.trim())}
            className="bg-red-600 text-white hover:bg-red-700"
          >
            {isLoading ? "Cancelling..." : "Cancel Invoice"}
          </Button>
        </div>
      }
    >
      <label htmlFor="cancel-invoice-reason" className="mb-1.5 block text-sm font-medium text-gray-700">
        Reason (required)
      </label>
      <textarea
        id="cancel-invoice-reason"
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why is this invoice being cancelled?"
        className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {trimmedLen > 0 && trimmedLen < 3 && (
        <p className="mt-1 text-xs text-destructive">Reason must be at least 3 characters.</p>
      )}
    </Modal>
  );
}

export function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: invoice, isLoading } = useInvoice(id);
  const issueInvoice = useIssueInvoice();
  const cancelInvoice = useCancelInvoice();
  const deleteInvoice = useDeleteInvoice();
  const generatePdf = useGenerateInvoicePdf();
  const downloadPdf = useDownloadInvoicePdf();
  const { data: creditNote } = useCreditNote(invoice?.credit_note_id ?? undefined);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (isLoading || !invoice) {
    return <p className="text-sm text-gray-500">Loading...</p>;
  }

  async function handleIssue() {
    try {
      await issueInvoice.mutateAsync(invoice!.id);
      toast.success("Invoice issued");
    } catch (err) {
      toast.error(extractApiMessage(err));
    }
  }

  async function handleCancel(reason: string) {
    try {
      await cancelInvoice.mutateAsync({ id: invoice!.id, values: { reason } });
      toast.success("Invoice cancelled");
      setCancelOpen(false);
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

  async function handleGeneratePdf() {
    try {
      await generatePdf.mutateAsync(invoice!.id);
      toast.success("PDF generated");
    } catch (err) {
      toast.error(extractApiMessage(err));
    }
  }

  async function handleDownloadPdf() {
    try {
      await downloadPdf.mutateAsync(invoice!.id);
    } catch (err) {
      toast.error(extractApiMessage(err));
    }
  }

  const customerLabel =
    invoice.customer?.customer_type === "B2B" ? invoice.customer.company_name : invoice.customer?.name;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={invoice.invoice_number || "Draft Invoice"}
        description={`${invoice.invoice_type === "TAX" ? "GST Invoice" : "Proforma Invoice"}${invoice.service_type ? ` · ${invoice.service_type}` : ""}`}
        action={
          <div className="flex items-center gap-2">
            <InvoiceStatusBadge status={invoice.status} />
            {invoice.status === "DRAFT" && (
              <>
                <Button variant="secondary" onClick={() => navigate(`/invoices/${invoice.id}/edit`)}>
                  Edit
                </Button>
                <Button onClick={handleIssue} disabled={issueInvoice.isPending} className="bg-primary-500 hover:bg-primary-600">
                  {issueInvoice.isPending ? "Issuing..." : "Issue"}
                </Button>
                <Button variant="secondary" className="text-red-600" onClick={() => setDeleteOpen(true)}>
                  Delete
                </Button>
              </>
            )}
            {(invoice.status === "ISSUED" || invoice.status === "PAID" || invoice.status === "CANCELLED") &&
              (invoice.pdf_url ? (
                <Button variant="secondary" onClick={handleDownloadPdf} disabled={downloadPdf.isPending}>
                  {downloadPdf.isPending ? "Downloading..." : "Download PDF"}
                </Button>
              ) : (
                <Button variant="secondary" onClick={handleGeneratePdf} disabled={generatePdf.isPending}>
                  {generatePdf.isPending ? "Generating..." : "Generate PDF"}
                </Button>
              ))}
            {invoice.status === "ISSUED" && (
              <Button className="bg-red-600 text-white hover:bg-red-700" onClick={() => setCancelOpen(true)}>
                Cancel
              </Button>
            )}
          </div>
        }
      />

      <div className="flex flex-col gap-6">
        <div className="rounded-lg border bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Invoice Details</h2>
          <div className="grid grid-cols-3 gap-4">
            <DetailRow label="Customer" value={customerLabel} />
            <DetailRow label="Invoice Date" value={invoice.invoice_date} />
            <DetailRow label="Due Date" value={invoice.due_date} />
            <DetailRow label="Terms" value={invoice.terms} />
            <DetailRow label="Notes" value={invoice.notes} />
            <DetailRow label="Reverse Charge" value={invoice.reverse_charge ? "Yes" : invoice.reverse_charge === false ? "No" : null} />
          </div>
        </div>

        <div className="rounded-lg border bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Line Items</h2>
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50 text-left text-gray-500">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lines.map((line) => (
                  <tr key={line.id} className="border-b last:border-0">
                    <td className="px-3 py-2 text-gray-500">{line.line_number}</td>
                    <td className="px-3 py-2 text-gray-900">{line.description}</td>
                    <td className="px-3 py-2 text-right text-gray-900">{formatPaiseAsRupees(line.line_amount_paise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-lg border bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Summary</h2>
          <div className="flex flex-col gap-1.5 text-sm">
            <div className="flex justify-between text-gray-600">
              <span>Taxable Amount</span>
              <span>{formatPaiseAsRupees(invoice.subtotal_paise)}</span>
            </div>
            {invoice.invoice_type === "TAX" && (
              <>
                {invoice.igst_paise > 0 ? (
                  <div className="flex justify-between text-gray-600">
                    <span>IGST</span>
                    <span>{formatPaiseAsRupees(invoice.igst_paise)}</span>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between text-gray-600">
                      <span>CGST</span>
                      <span>{formatPaiseAsRupees(invoice.cgst_paise)}</span>
                    </div>
                    <div className="flex justify-between text-gray-600">
                      <span>SGST</span>
                      <span>{formatPaiseAsRupees(invoice.sgst_paise)}</span>
                    </div>
                  </>
                )}
              </>
            )}
            {invoice.discount_paise > 0 && (
              <div className="flex justify-between text-gray-600">
                <span>Discount</span>
                <span>-{formatPaiseAsRupees(invoice.discount_paise)}</span>
              </div>
            )}
            {(invoice.toll_paise > 0 || invoice.parking_paise > 0 || invoice.permit_paise > 0 || invoice.fasttag_paise > 0) && (
              <div className="flex justify-between text-gray-600">
                <span>Toll / Parking / Permit / Fasttag</span>
                <span>
                  {formatPaiseAsRupees(
                    invoice.toll_paise + invoice.parking_paise + invoice.permit_paise + invoice.fasttag_paise,
                  )}
                </span>
              </div>
            )}
            <div className="flex justify-between text-gray-600">
              <span>Round Off</span>
              <span>{formatPaiseAsRupees(invoice.round_off_paise)}</span>
            </div>
            <div className="mt-2 flex justify-between border-t pt-2 font-semibold text-gray-900">
              <span>Net Payable</span>
              <span>{formatPaiseAsRupees(invoice.net_payable_paise)}</span>
            </div>
            {invoice.amount_in_words && <p className="mt-1 text-xs text-gray-400">{invoice.amount_in_words}</p>}
          </div>
        </div>

        <div className="rounded-lg border bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Lifecycle</h2>
          <div className="grid grid-cols-3 gap-4">
            <DetailRow label="Created" value={new Date(invoice.created_at).toLocaleString()} />
            <DetailRow label="Issued" value={invoice.issued_at ? new Date(invoice.issued_at).toLocaleString() : null} />
            <DetailRow label="Cancelled" value={invoice.cancelled_at ? new Date(invoice.cancelled_at).toLocaleString() : null} />
            {invoice.cancellation_reason && (
              <div className="col-span-2">
                <DetailRow label="Cancellation Reason" value={invoice.cancellation_reason} />
              </div>
            )}
            {creditNote && <DetailRow label="Credit Note" value={creditNote.credit_note_number} />}
          </div>
        </div>
      </div>

      <CancelInvoiceDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        onConfirm={handleCancel}
        isLoading={cancelInvoice.isPending}
      />

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
