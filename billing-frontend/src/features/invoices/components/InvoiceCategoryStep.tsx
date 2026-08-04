import { FileCheck, FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { InvoiceType } from "@/types/invoice";

interface InvoiceCategoryStepProps {
  invoiceType: InvoiceType | null;
  gstRate: number | undefined;
  onInvoiceTypeChange: (type: InvoiceType) => void;
  onBack: () => void;
  onNext: () => void;
}

export function InvoiceCategoryStep({
  invoiceType,
  gstRate,
  onInvoiceTypeChange,
  onBack,
  onNext,
}: InvoiceCategoryStepProps) {
  const halfRate = gstRate != null ? gstRate / 2 : undefined;

  const CARDS: { type: InvoiceType; icon: typeof FileText; label: string; description: string }[] = [
    {
      type: "TAX",
      icon: FileText,
      label: "GST Invoice",
      description: halfRate != null ? `CGST ${halfRate}% + SGST ${halfRate}%` : "Legal tax invoice",
    },
    { type: "PERFORMANCE", icon: FileCheck, label: "Proforma Invoice", description: "No tax rows" },
  ];

  return (
    <div>
      <div className="grid grid-cols-2 gap-4">
        {CARDS.map(({ type, icon: Icon, label, description }) => (
          <button
            key={type}
            type="button"
            onClick={() => onInvoiceTypeChange(type)}
            className={cn(
              "flex flex-col items-center gap-2 rounded-lg border-2 p-6 text-center transition-colors",
              invoiceType === type
                ? "border-primary-500 bg-primary-50"
                : "border-gray-200 hover:border-gray-300 hover:bg-gray-50",
            )}
          >
            <Icon className={cn("h-8 w-8", invoiceType === type ? "text-primary-600" : "text-gray-400")} />
            <span className="text-base font-semibold text-gray-900">{label}</span>
            <span className="text-sm text-gray-500">{description}</span>
          </button>
        ))}
      </div>

      <div className="mt-8 flex justify-between">
        <Button type="button" variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button
          type="button"
          onClick={onNext}
          disabled={!invoiceType}
          className="bg-primary-500 hover:bg-primary-600"
        >
          Next
        </Button>
      </div>
    </div>
  );
}
