import { Button } from "@/components/ui/button";
import { TripPickerFields } from "@/features/invoices/components/TripPickerFields";
import type { TripServiceType } from "@/lib/constants/enums";
import type { InvoiceType } from "@/types/invoice";

interface TripPickerStepProps {
  customerId: string;
  invoiceType: InvoiceType;
  serviceType: TripServiceType;
  onServiceTypeChange: (type: TripServiceType) => void;
  invoiceDate: string;
  onInvoiceDateChange: (date: string) => void;
  tripSheetIds: string[];
  onTripSheetIdsChange: (ids: string[]) => void;
  reverseCharge: boolean;
  onReverseChargeChange: (value: boolean) => void;
  notes: string;
  onNotesChange: (value: string) => void;
  onBack: () => void;
  onSaveDraft: () => void;
  onSaveAndIssue: () => void;
  isSavingDraft: boolean;
  isSavingAndIssuing: boolean;
}

export function TripPickerStep({
  customerId,
  invoiceType,
  serviceType,
  onServiceTypeChange,
  invoiceDate,
  onInvoiceDateChange,
  tripSheetIds,
  onTripSheetIdsChange,
  reverseCharge,
  onReverseChargeChange,
  notes,
  onNotesChange,
  onBack,
  onSaveDraft,
  onSaveAndIssue,
  isSavingDraft,
  isSavingAndIssuing,
}: TripPickerStepProps) {
  const isBusy = isSavingDraft || isSavingAndIssuing;

  return (
    <div>
      <TripPickerFields
        customerId={customerId}
        invoiceType={invoiceType}
        serviceType={serviceType}
        onServiceTypeChange={onServiceTypeChange}
        invoiceDate={invoiceDate}
        onInvoiceDateChange={onInvoiceDateChange}
        tripSheetIds={tripSheetIds}
        onTripSheetIdsChange={onTripSheetIdsChange}
        reverseCharge={reverseCharge}
        onReverseChargeChange={onReverseChargeChange}
        notes={notes}
        onNotesChange={onNotesChange}
      />

      <div className="mt-8 flex justify-between">
        <Button type="button" variant="secondary" onClick={onBack} disabled={isBusy}>
          Back
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={onSaveDraft} disabled={tripSheetIds.length === 0 || isBusy}>
            {isSavingDraft ? "Saving..." : "Save as Draft"}
          </Button>
          <Button
            type="button"
            onClick={onSaveAndIssue}
            disabled={tripSheetIds.length === 0 || isBusy}
            className="bg-primary-500 hover:bg-primary-600"
          >
            {isSavingAndIssuing ? "Issuing..." : "Save & Issue"}
          </Button>
        </div>
      </div>
    </div>
  );
}
