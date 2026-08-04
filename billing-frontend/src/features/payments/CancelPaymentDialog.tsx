import { useState } from "react";

import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/button";

interface CancelPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
  isLoading: boolean;
}

// Shared by InvoiceDetailPage's payments card and the top-level
// PaymentsListScreen — same reason-required-min-3-chars shape as
// invoices'/trip sheets' own cancel dialogs (cancelPaymentSchema).
export function CancelPaymentDialog({ open, onOpenChange, onConfirm, isLoading }: CancelPaymentDialogProps) {
  const [reason, setReason] = useState("");
  const trimmedLen = reason.trim().length;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) setReason("");
        onOpenChange(next);
      }}
      title="Cancel this payment?"
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
            {isLoading ? "Cancelling..." : "Cancel Payment"}
          </Button>
        </div>
      }
    >
      <label htmlFor="cancel-payment-reason" className="mb-1.5 block text-sm font-medium text-gray-700">
        Reason (required)
      </label>
      <textarea
        id="cancel-payment-reason"
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why is this payment being cancelled?"
        className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {trimmedLen > 0 && trimmedLen < 3 && (
        <p className="mt-1 text-xs text-destructive">Reason must be at least 3 characters.</p>
      )}
    </Modal>
  );
}
