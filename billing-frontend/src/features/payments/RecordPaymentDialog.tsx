import { zodResolver } from "@hookform/resolvers/zod";
import { AxiosError } from "axios";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRecordPayment } from "@/features/payments/payments.hooks";
import { paiseToRupees } from "@/lib/money";
import { paymentFormSchema, type PaymentFormValues } from "@/lib/schemas/payment";
import { PAYMENT_MODES, PAYMENT_MODE_LABELS, type PaymentMode } from "@/types/payment";
import type { ApiErrorResponse } from "@/types/api";

interface RecordPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  outstandingPaise: number;
}

const today = () => new Date().toISOString().slice(0, 10);

// Real column label per mode — "Reference" alone doesn't tell staff
// what to actually type in. CASH never shows this field at all
// (payment_mode CASH forbids reference_number server-side).
const REFERENCE_LABELS: Partial<Record<PaymentMode, string>> = {
  UPI: "UPI Reference",
  NEFT: "Transaction ID",
  RTGS: "Transaction ID",
  IMPS: "Transaction ID",
  BANK_TRANSFER: "Transaction ID",
  CARD: "Transaction ID",
  CHEQUE: "Cheque Number",
};

function extractApiError(err: unknown) {
  if (err instanceof AxiosError) {
    return (err.response?.data as ApiErrorResponse | undefined)?.error;
  }
  return undefined;
}

export function RecordPaymentDialog({ open, onOpenChange, invoiceId, outstandingPaise }: RecordPaymentDialogProps) {
  const recordPayment = useRecordPayment();

  const form = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentFormSchema),
    defaultValues: {
      payment_mode: "CASH",
      amount_rupees: String(paiseToRupees(outstandingPaise)),
      payment_date: today(),
      reference_number: "",
      notes: "",
    },
  });
  const { register, handleSubmit, watch, reset, setError, formState } = form;
  const mode = watch("payment_mode");
  const amountRupees = Number(watch("amount_rupees") || 0);

  useEffect(() => {
    if (open) {
      reset({
        payment_mode: "CASH",
        amount_rupees: String(paiseToRupees(outstandingPaise)),
        payment_date: today(),
        reference_number: "",
        notes: "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, outstandingPaise]);

  const outstandingRupees = paiseToRupees(outstandingPaise) || 0;
  const overpayBy = amountRupees - Number(outstandingRupees);
  const willCreateAdvance = overpayBy > 0.005;

  async function onSubmit(values: PaymentFormValues) {
    try {
      await recordPayment.mutateAsync({ invoiceId, values });
      toast.success("Payment recorded");
      onOpenChange(false);
    } catch (err) {
      const apiErr = extractApiError(err);
      if (apiErr?.code === "PAYMENT_REFERENCE_DUPLICATE") {
        setError("reference_number", {
          message: "This reference is already recorded. Enter a different one.",
        });
        return;
      }
      toast.error(apiErr?.message || "Failed to record payment");
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Record Payment"
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="record-payment-form"
            disabled={recordPayment.isPending || formState.isSubmitting}
            className="bg-primary-500 hover:bg-primary-600"
          >
            {recordPayment.isPending ? "Recording..." : "Record Payment"}
          </Button>
        </div>
      }
    >
      <form id="record-payment-form" onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
        <div>
          <Label htmlFor="payment_mode">Mode</Label>
          <select
            id="payment_mode"
            {...register("payment_mode")}
            className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {PAYMENT_MODES.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <Label htmlFor="amount_rupees">Amount (₹)</Label>
          <Input id="amount_rupees" type="number" step="0.01" min="0.01" {...register("amount_rupees")} className="mt-1.5" />
          {formState.errors.amount_rupees && (
            <p className="mt-1 text-xs text-destructive">{formState.errors.amount_rupees.message}</p>
          )}
          {willCreateAdvance && (
            <p className="mt-1.5 text-xs text-amber-600">
              This will create an advance of ₹{overpayBy.toFixed(2)} for this customer.
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="payment_date">Payment Date</Label>
          <Input id="payment_date" type="date" max={today()} {...register("payment_date")} className="mt-1.5" />
          {formState.errors.payment_date && (
            <p className="mt-1 text-xs text-destructive">{formState.errors.payment_date.message}</p>
          )}
        </div>

        {mode !== "CASH" && (
          <div>
            <Label htmlFor="reference_number">{REFERENCE_LABELS[mode] ?? "Reference"}</Label>
            <Input id="reference_number" {...register("reference_number")} className="mt-1.5" />
            {formState.errors.reference_number && (
              <p className="mt-1 text-xs text-destructive">{formState.errors.reference_number.message}</p>
            )}
          </div>
        )}

        <div>
          <Label htmlFor="notes">Notes (optional)</Label>
          <textarea
            id="notes"
            rows={2}
            {...register("notes")}
            className="mt-1.5 flex w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      </form>
    </Modal>
  );
}
