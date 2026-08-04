import { AxiosError } from "axios";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/button";
import {
  useCreditNoteDetail,
  useDownloadCreditNotePdf,
  useGenerateCreditNotePdf,
} from "@/features/creditNotes/creditNotes.hooks";
import { formatPaiseAsRupees } from "@/lib/money";
import type { ApiErrorResponse } from "@/types/api";

interface CreditNoteDetailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creditNoteId: string | null;
}

function extractApiMessage(err: unknown): string {
  if (err instanceof AxiosError) {
    return (err.response?.data as ApiErrorResponse | undefined)?.error?.message || "Something went wrong.";
  }
  return "Cannot reach server. Try again.";
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-sm text-gray-900">{value ?? "—"}</div>
    </div>
  );
}

// Opened from CreditNotesListScreen AND from a cancelled invoice
// detail's credit_note_number link — one shared, read-only modal (Rule
// 4: no duplicated view logic between the two entry points).
export function CreditNoteDetailModal({ open, onOpenChange, creditNoteId }: CreditNoteDetailModalProps) {
  const navigate = useNavigate();
  const { data: creditNote, isLoading } = useCreditNoteDetail(creditNoteId ?? undefined);
  const generatePdf = useGenerateCreditNotePdf();
  const downloadPdf = useDownloadCreditNotePdf();

  async function handleDownload() {
    if (!creditNoteId) return;
    try {
      await downloadPdf.mutateAsync(creditNoteId);
    } catch (err) {
      toast.error(extractApiMessage(err));
    }
  }

  async function handleGenerate() {
    if (!creditNoteId) return;
    try {
      await generatePdf.mutateAsync(creditNoteId);
      toast.success("PDF generated");
    } catch (err) {
      toast.error(extractApiMessage(err));
    }
  }

  const customerLabel = creditNote
    ? (creditNote.customer_snapshot.company_name as string | undefined) ||
      (creditNote.customer_snapshot.name as string | undefined)
    : undefined;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={creditNote?.credit_note_number || "Credit Note"}
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {creditNote &&
            (creditNote.pdf_url ? (
              <Button type="button" onClick={handleDownload} disabled={downloadPdf.isPending} className="bg-primary-500 hover:bg-primary-600">
                {downloadPdf.isPending ? "Downloading..." : "Download PDF"}
              </Button>
            ) : (
              <Button type="button" onClick={handleGenerate} disabled={generatePdf.isPending} className="bg-primary-500 hover:bg-primary-600">
                {generatePdf.isPending ? "Generating..." : "Generate PDF"}
              </Button>
            ))}
        </div>
      }
    >
      {isLoading || !creditNote ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <DetailRow label="Credit Note Date" value={creditNote.credit_note_date} />
            <DetailRow label="Customer" value={customerLabel} />
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-gray-400">Original Invoice</div>
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  navigate(`/invoices/${creditNote.original_invoice_id}`);
                }}
                className="text-sm font-medium text-primary-600 hover:underline"
              >
                View Invoice
              </button>
            </div>
            <DetailRow label="Amount" value={formatPaiseAsRupees(creditNote.net_payable_paise)} />
          </div>
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-gray-400">Reason</div>
            <p className="text-sm text-gray-900">{creditNote.reason}</p>
          </div>
          {creditNote.amount_in_words && (
            <p className="text-xs text-gray-400">{creditNote.amount_in_words}</p>
          )}
        </div>
      )}
    </Modal>
  );
}
