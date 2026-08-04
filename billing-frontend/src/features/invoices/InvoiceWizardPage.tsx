import { AxiosError } from "axios";
import { X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { PageHeader } from "@/components/PageHeader";
import { BillingTypeStep } from "@/features/invoices/components/BillingTypeStep";
import { InvoiceCategoryStep } from "@/features/invoices/components/InvoiceCategoryStep";
import { TripPickerStep } from "@/features/invoices/components/TripPickerStep";
import { WizardStepper } from "@/features/invoices/components/WizardStepper";
import { useCreateInvoice, useIssueAndGeneratePdf } from "@/features/invoices/invoices.hooks";
import { useBusinessProfile } from "@/features/settings/settings.hooks";
import type { TripServiceType } from "@/lib/constants/enums";
import type { ApiErrorResponse } from "@/types/api";
import type { CustomerType } from "@/types/customer";
import type { InvoiceType } from "@/types/invoice";

const today = () => new Date().toISOString().slice(0, 10);

function extractApiMessage(err: unknown): string {
  if (err instanceof AxiosError) {
    return (err.response?.data as ApiErrorResponse | undefined)?.error?.message || "Something went wrong.";
  }
  return "Cannot reach server. Try again.";
}

export function InvoiceWizardPage() {
  const navigate = useNavigate();
  const { data: profile } = useBusinessProfile();
  const createInvoice = useCreateInvoice();
  const issueAndGeneratePdf = useIssueAndGeneratePdf();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

  const [customerType, setCustomerType] = useState<CustomerType | null>(null);
  const [customerId, setCustomerId] = useState<string>("");
  const [invoiceType, setInvoiceType] = useState<InvoiceType | null>(null);
  const [serviceType, setServiceType] = useState<TripServiceType>("LOCAL");
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [tripSheetIds, setTripSheetIds] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [reverseCharge, setReverseCharge] = useState(false);
  // Tracks which of the two save actions is in flight — createInvoice
  // is shared by both, so its own isPending can't distinguish them.
  const [savingMode, setSavingMode] = useState<"draft" | "issue" | null>(null);

  function handleCustomerTypeChange(type: CustomerType) {
    setCustomerType(type);
  }

  async function handleSaveDraft() {
    if (!invoiceType) return;
    setSavingMode("draft");
    try {
      const invoice = await createInvoice.mutateAsync({
        customer_id: customerId,
        invoice_type: invoiceType,
        service_type: serviceType,
        trip_sheet_ids: tripSheetIds,
        invoice_date: invoiceDate,
        notes,
        reverse_charge: reverseCharge,
      });
      toast.success("Invoice saved as draft");
      navigate(`/invoices/${invoice.id}`);
    } catch (err) {
      toast.error(extractApiMessage(err));
      setSavingMode(null);
    }
  }

  async function handleSaveAndIssue() {
    if (!invoiceType) return;
    setSavingMode("issue");
    try {
      const invoice = await createInvoice.mutateAsync({
        customer_id: customerId,
        invoice_type: invoiceType,
        service_type: serviceType,
        trip_sheet_ids: tripSheetIds,
        invoice_date: invoiceDate,
        notes,
        reverse_charge: reverseCharge,
      });
      await issueAndGeneratePdf.mutateAsync(invoice.id);
      toast.success("Invoice issued");
      navigate(`/invoices/${invoice.id}`);
    } catch (err) {
      toast.error(extractApiMessage(err));
      setSavingMode(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="New Invoice"
        description="3-step wizard"
        action={
          <button
            type="button"
            aria-label="Close"
            onClick={() => setCloseConfirmOpen(true)}
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        }
      />

      <WizardStepper currentStep={step} />

      <div className="rounded-lg border bg-white p-6">
        {step === 1 && (
          <BillingTypeStep
            customerType={customerType}
            customerId={customerId || null}
            onCustomerTypeChange={handleCustomerTypeChange}
            onCustomerIdChange={setCustomerId}
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && (
          <InvoiceCategoryStep
            invoiceType={invoiceType}
            gstRate={profile?.gst_rate}
            onInvoiceTypeChange={setInvoiceType}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
          />
        )}
        {step === 3 && invoiceType && (
          <TripPickerStep
            customerId={customerId}
            invoiceType={invoiceType}
            serviceType={serviceType}
            onServiceTypeChange={(type) => {
              setServiceType(type);
              setTripSheetIds([]);
            }}
            invoiceDate={invoiceDate}
            onInvoiceDateChange={setInvoiceDate}
            tripSheetIds={tripSheetIds}
            onTripSheetIdsChange={setTripSheetIds}
            reverseCharge={reverseCharge}
            onReverseChargeChange={setReverseCharge}
            notes={notes}
            onNotesChange={setNotes}
            onBack={() => setStep(2)}
            onSaveDraft={handleSaveDraft}
            onSaveAndIssue={handleSaveAndIssue}
            isSavingDraft={savingMode === "draft"}
            isSavingAndIssuing={savingMode === "issue"}
          />
        )}
      </div>

      <DeleteConfirmDialog
        open={closeConfirmOpen}
        onOpenChange={setCloseConfirmOpen}
        title="Discard invoice draft?"
        description="Nothing has been saved yet. Leaving now discards everything entered in this wizard."
        confirmLabel="Discard"
        onConfirm={() => navigate("/invoices")}
      />
    </div>
  );
}
