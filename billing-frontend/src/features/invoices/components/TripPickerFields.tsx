import { useInvoiceableTrips } from "@/features/invoices/invoices.hooks";
import { InvoiceSummary } from "@/features/invoices/components/InvoiceSummary";
import { isSameState } from "@/features/invoices/gstCalc";
import { useBusinessProfile } from "@/features/settings/settings.hooks";
import { TRIP_SERVICE_TYPES, TRIP_SERVICE_TYPE_LABELS } from "@/lib/constants/enums";
import { formatPaiseAsRupees } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { InvoiceType } from "@/types/invoice";
import type { TripServiceType } from "@/lib/constants/enums";

interface TripPickerFieldsProps {
  customerId: string;
  invoiceType: InvoiceType;
  serviceType: TripServiceType;
  onServiceTypeChange: (type: TripServiceType) => void;
  lockServiceType?: boolean;
  invoiceDate: string;
  onInvoiceDateChange: (date: string) => void;
  tripSheetIds: string[];
  onTripSheetIdsChange: (ids: string[]) => void;
  reverseCharge: boolean;
  onReverseChargeChange: (value: boolean) => void;
  notes: string;
  onNotesChange: (value: string) => void;
  invoiceIdForEdit?: string;
}

const today = () => new Date().toISOString().slice(0, 10);

// Reused verbatim by both the wizard's Step 3 (TripPickerStep) and
// InvoiceDraftEditPage — "same picker component" per the task spec, not
// two copies that could drift.
export function TripPickerFields({
  customerId,
  invoiceType,
  serviceType,
  onServiceTypeChange,
  lockServiceType,
  invoiceDate,
  onInvoiceDateChange,
  tripSheetIds,
  onTripSheetIdsChange,
  reverseCharge,
  onReverseChargeChange,
  notes,
  onNotesChange,
  invoiceIdForEdit,
}: TripPickerFieldsProps) {
  const { data, isLoading } = useInvoiceableTrips(customerId, invoiceIdForEdit);
  const { data: profile } = useBusinessProfile();

  // Task 4.9/Part A: the backend groups by service_type but does NOT
  // filter by billing_mode — filter client-side against the mode this
  // invoice_type implies.
  const billingMode = invoiceType === "TAX" ? "GST" : "PERFORMANCE";
  const group = data?.groups[serviceType];
  const availableTrips = (group?.trips ?? []).filter((t) => t.billing_mode === billingMode);
  const selectedTrips = availableTrips.filter((t) => tripSheetIds.includes(t.id));

  function toggleTrip(id: string) {
    if (tripSheetIds.includes(id)) {
      onTripSheetIdsChange(tripSheetIds.filter((x) => x !== id));
    } else {
      onTripSheetIdsChange([...tripSheetIds, id]);
    }
  }

  const sameState = isSameState(data?.customer.state_code, profile?.state_code);

  return (
    <div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">Service Type</label>
          <div className="flex gap-2">
            {TRIP_SERVICE_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                disabled={lockServiceType}
                onClick={() => onServiceTypeChange(type)}
                className={cn(
                  "flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                  serviceType === type
                    ? "border-primary-500 bg-primary-50 text-primary-700"
                    : "border-gray-300 text-gray-600 hover:bg-gray-50",
                  lockServiceType && "cursor-not-allowed opacity-60",
                )}
              >
                {TRIP_SERVICE_TYPE_LABELS[type]}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label htmlFor="invoice_date" className="mb-1.5 block text-sm font-medium text-gray-700">
            Invoice Date
          </label>
          <input
            id="invoice_date"
            type="date"
            value={invoiceDate}
            max={today()}
            onChange={(e) => onInvoiceDateChange(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-6">
        <div className="col-span-2">
          <label className="mb-1.5 block text-sm font-medium text-gray-700">
            Select Trips ({selectedTrips.length} selected)
          </label>
          {isLoading && <p className="text-sm text-gray-500">Loading trips...</p>}
          {!isLoading && availableTrips.length === 0 && (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-gray-500">
              No finalized {billingMode} {TRIP_SERVICE_TYPE_LABELS[serviceType].toLowerCase()} trips for this customer.
              Create trips first.
            </div>
          )}
          {!isLoading && availableTrips.length > 0 && (
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50 text-left text-gray-500">
                    <th className="w-10 px-3 py-2" />
                    <th className="px-3 py-2 font-medium">Trip #</th>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Vehicle</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {availableTrips.map((trip) => (
                    <tr
                      key={trip.id}
                      onClick={() => toggleTrip(trip.id)}
                      className="cursor-pointer border-b last:border-0 hover:bg-accent-50"
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={tripSheetIds.includes(trip.id)}
                          onChange={() => toggleTrip(trip.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="h-4 w-4 rounded border-gray-300"
                        />
                      </td>
                      <td className="px-3 py-2 font-medium text-gray-900">{trip.trip_sheet_number}</td>
                      <td className="px-3 py-2 text-gray-600">{trip.trip_date}</td>
                      <td className="px-3 py-2 text-gray-600">{trip.snapshot_vehicle_number}</td>
                      <td className="px-3 py-2 text-right text-gray-900">
                        {formatPaiseAsRupees(trip.net_payable_paise)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {invoiceType === "TAX" && (
            <label className="mt-4 flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={reverseCharge}
                onChange={(e) => onReverseChargeChange(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              GST payable under reverse charge by the recipient
            </label>
          )}

          <div className="mt-4">
            <label htmlFor="notes" className="mb-1.5 block text-sm font-medium text-gray-700">
              Notes (optional)
            </label>
            <textarea
              id="notes"
              rows={2}
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
              className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </div>

        <div>
          <InvoiceSummary
            selectedTrips={selectedTrips}
            invoiceType={invoiceType}
            gstRate={profile?.gst_rate}
            sameState={sameState}
          />
        </div>
      </div>
    </div>
  );
}
