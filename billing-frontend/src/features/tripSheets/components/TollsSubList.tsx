import { Trash2 } from "lucide-react";
import { useFieldArray, useFormContext } from "react-hook-form";

import { Input } from "@/components/ui/input";
import type { TripSheetFormValues } from "@/lib/schemas/tripSheet";

// OUTSTATION only (ADR-010, tripSheet.validator.js's tollReceiptSchema
// comment) — itemized toll-plaza receipts. Part of the SAME form as
// the rest of the trip (tolls is a field on tripSheetFormSchema, not a
// separate sub-resource form) since the backend accepts/replaces the
// whole tolls[] array in one PATCH — see tripSheets.api.ts's own
// comment on why there's no per-toll id to preserve across an edit.
export function TollsSubList() {
  const { control, register, watch } = useFormContext<TripSheetFormValues>();
  const { fields, append, remove } = useFieldArray({ control, name: "tolls" });
  const tolls = watch("tolls");
  const total = tolls.reduce((sum, t) => sum + (Number(t.amount_rupees) || 0), 0);

  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 text-sm font-medium text-gray-700">Toll Receipts</div>

      {fields.length === 0 && <p className="text-sm text-gray-500">No tolls added</p>}

      <div className="flex flex-col gap-2">
        {fields.map((field, index) => (
          <div key={field.id} className="flex items-end gap-2">
            <div className="flex-1">
              <Input placeholder="Plaza name" {...register(`tolls.${index}.plaza_name` as const)} />
            </div>
            <div className="w-28">
              <Input
                type="number"
                step="0.01"
                placeholder="Amount (₹)"
                {...register(`tolls.${index}.amount_rupees` as const)}
              />
            </div>
            <button
              type="button"
              aria-label="Remove toll"
              onClick={() => remove(index)}
              className="mb-1.5 text-gray-400 hover:text-red-600"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() =>
          append({
            plaza_name: "",
            toll_id: "",
            amount_rupees: "",
            crossed_at: "",
            vehicle_number: "",
            closing_balance_rupees: "",
            notes: "",
          })
        }
        className="mt-2 text-sm font-medium text-primary-600 hover:text-primary-700"
      >
        + Add Toll
      </button>

      {fields.length > 0 && (
        <div className="mt-2 border-t pt-2 text-sm font-medium text-gray-700">Total: ₹{total.toFixed(2)}</div>
      )}
    </div>
  );
}
