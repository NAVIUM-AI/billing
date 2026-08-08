import { AxiosError } from "axios";
import { useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { useDriver } from "@/features/drivers/drivers.hooks";
import { useCancelTripSheet, useFinalizeTripSheet, useTripSheet } from "@/features/tripSheets/tripSheets.hooks";
import {
  TRIP_BILLING_MODE_LABELS,
  TRIP_SERVICE_TYPE_LABELS,
  TRIP_STATUS_LABELS,
  VEHICLE_TYPE_LABELS,
} from "@/lib/constants/enums";
import { formatPaiseAsRupees } from "@/lib/money";
import { deriveRuleType } from "@/lib/tripPricingCalc";
import { cn } from "@/lib/utils";
import type { ApiErrorResponse } from "@/types/api";

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-sm text-gray-900">{value ?? "—"}</div>
    </div>
  );
}

function CancelTripDialog({
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
      title="Cancel this trip sheet?"
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
            {isLoading ? "Cancelling..." : "Cancel Trip"}
          </Button>
        </div>
      }
    >
      <label htmlFor="cancel-reason" className="mb-1.5 block text-sm font-medium text-gray-700">
        Reason (required)
      </label>
      <textarea
        id="cancel-reason"
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why is this trip being cancelled?"
        className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {trimmedLen > 0 && trimmedLen < 3 && (
        <p className="mt-1 text-xs text-destructive">Reason must be at least 3 characters.</p>
      )}
    </Modal>
  );
}

export function TripSheetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: trip, isLoading } = useTripSheet(id);
  const { data: driver } = useDriver(trip?.driver_id ?? undefined);
  const finalizeTrip = useFinalizeTripSheet();
  const cancelTrip = useCancelTripSheet();

  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  if (isLoading || !trip) {
    return <p className="text-sm text-gray-500">Loading...</p>;
  }

  async function handleFinalize() {
    try {
      await finalizeTrip.mutateAsync(trip!.id);
      toast.success("Trip sheet finalized");
      setFinalizeOpen(false);
    } catch (err) {
      const apiErr = err instanceof AxiosError ? (err.response?.data as ApiErrorResponse | undefined)?.error : undefined;
      toast.error(apiErr?.message || "Failed to finalize trip sheet");
    }
  }

  async function handleCancel(reason: string) {
    try {
      await cancelTrip.mutateAsync({ id: trip!.id, reason });
      toast.success("Trip sheet cancelled");
      setCancelOpen(false);
    } catch (err) {
      const apiErr = err instanceof AxiosError ? (err.response?.data as ApiErrorResponse | undefined)?.error : undefined;
      toast.error(apiErr?.message || "Failed to cancel trip sheet");
    }
  }

  const canEdit = trip.status === "DRAFT";
  const canFinalize = trip.status === "DRAFT";
  const canCancel = trip.status === "DRAFT" || trip.status === "FINALIZED";
  const cancelBlocked = trip.status === "INVOICED";

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={trip.trip_sheet_number}
        description={`${TRIP_SERVICE_TYPE_LABELS[trip.service_type]} · ${TRIP_BILLING_MODE_LABELS[trip.billing_mode]}`}
        action={
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "rounded px-2 py-1 text-xs font-medium",
                trip.status === "DRAFT" && "bg-gray-200 text-gray-700",
                trip.status === "FINALIZED" && "bg-green-100 text-green-700",
                trip.status === "INVOICED" && "bg-blue-100 text-blue-700",
                trip.status === "CANCELLED" && "bg-red-100 text-red-700",
              )}
            >
              {TRIP_STATUS_LABELS[trip.status]}
            </span>
            {canEdit && (
              <Button variant="secondary" onClick={() => navigate(`/trips/${trip.id}/edit`)}>
                Edit
              </Button>
            )}
            {canFinalize && (
              <Button onClick={() => setFinalizeOpen(true)} className="bg-primary-500 hover:bg-primary-600">
                Finalize
              </Button>
            )}
            {canCancel && (
              <Button onClick={() => setCancelOpen(true)} className="bg-red-600 text-white hover:bg-red-700">
                Cancel
              </Button>
            )}
            {cancelBlocked && (
              <Button disabled title="Cancel the invoice first" className="cursor-not-allowed opacity-50">
                Cancel
              </Button>
            )}
          </div>
        }
      />

      <div className="flex flex-col gap-6">
        <div className="rounded-lg border bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Trip Basics</h2>
          <div className="grid grid-cols-3 gap-4">
            <DetailRow label="Trip Date" value={trip.trip_date} />
            <DetailRow label="Booked By" value={trip.booked_by} />
            <DetailRow label="Customer" value={trip.snapshot_customer_name} />
            <DetailRow
              label="Vehicle"
              value={
                <span className="inline-flex items-center gap-1.5">
                  {trip.snapshot_vehicle_number} · {VEHICLE_TYPE_LABELS[trip.snapshot_vehicle_type]}
                  {trip.pricing_source === "MANUAL" && (
                    <span
                      className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500"
                      title="Sub-contracted vehicle, manually priced"
                    >
                      External
                    </span>
                  )}
                </span>
              }
            />
            <DetailRow label="Driver" value={driver?.full_name} />
            <DetailRow label="Notes" value={trip.remarks} />
          </div>
        </div>

        <div className="rounded-lg border bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Rate Details</h2>
          <div className="grid grid-cols-3 gap-4">
            {deriveRuleType(trip.service_type, trip.billing_mode) === "LOCAL_PACKAGE" && (
              <>
                <DetailRow label="Base Price" value={formatPaiseAsRupees(trip.snap_base_price_paise)} />
                <DetailRow label="Base Hours" value={trip.snap_base_hours} />
                <DetailRow label="Base Km" value={trip.snap_base_km} />
                <DetailRow label="Extra Km Rate" value={formatPaiseAsRupees(trip.snap_extra_km_rate_paise)} />
                <DetailRow label="Extra Hour Rate" value={formatPaiseAsRupees(trip.snap_extra_hr_rate_paise)} />
              </>
            )}
            {deriveRuleType(trip.service_type, trip.billing_mode) === "OUTSTATION_SLAB" && (
              <>
                <DetailRow label="Slab Rate" value={formatPaiseAsRupees(trip.snap_slab_rate_paise)} />
                <DetailRow label="Min Km Per Day" value={trip.snap_min_km_per_day} />
                <DetailRow label="Driver Batta Per Day" value={formatPaiseAsRupees(trip.snap_driver_batta_per_day_paise)} />
              </>
            )}
            {deriveRuleType(trip.service_type, trip.billing_mode) === "PERFORMANCE" && (
              <>
                <DetailRow label="Per Km Rate" value={formatPaiseAsRupees(trip.snap_per_km_rate_paise)} />
                <DetailRow label="Performance Batta" value={formatPaiseAsRupees(trip.snap_performance_batta_paise)} />
              </>
            )}
          </div>
        </div>

        <div className="rounded-lg border bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Usage</h2>
          <div className="grid grid-cols-3 gap-4">
            <DetailRow label="Total KM" value={trip.total_km} />
            <DetailRow label="Total Hours" value={trip.total_hours} />
            <DetailRow label="Total Days" value={trip.total_days} />
            <DetailRow label="Opening KM" value={trip.opening_km} />
            <DetailRow label="Closing KM" value={trip.closing_km} />
          </div>
          {trip.tolls.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">Toll Receipts</div>
              <div className="flex flex-col gap-1">
                {trip.tolls.map((t) => (
                  <div key={t.id} className="flex justify-between text-sm text-gray-700">
                    <span>{t.plaza_name}</span>
                    <span>{formatPaiseAsRupees(t.amount_paise)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="rounded-lg border bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Billing Breakdown</h2>
          <div className="flex flex-col gap-1.5 text-sm">
            {trip.breakdown.map((item, i) => (
              <div key={i} className="flex justify-between text-gray-600">
                <span>
                  {item.label}
                  {item.detail && <span className="text-xs text-gray-400"> ({item.detail})</span>}
                </span>
                <span>{formatPaiseAsRupees(item.value_paise)}</span>
              </div>
            ))}
            <div className="mt-2 flex justify-between border-t pt-2 font-semibold text-gray-900">
              <span>Net Payable</span>
              <span>{formatPaiseAsRupees(trip.net_payable_paise)}</span>
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Lifecycle</h2>
          <div className="grid grid-cols-3 gap-4">
            <DetailRow label="Created" value={new Date(trip.created_at).toLocaleString()} />
            <DetailRow label="Finalized" value={trip.finalized_at ? new Date(trip.finalized_at).toLocaleString() : null} />
            <DetailRow label="Invoiced" value={trip.invoiced_at ? new Date(trip.invoiced_at).toLocaleString() : null} />
            <DetailRow label="Cancelled" value={trip.cancelled_at ? new Date(trip.cancelled_at).toLocaleString() : null} />
            {trip.cancellation_reason && (
              <div className="col-span-2">
                <DetailRow label="Cancellation Reason" value={trip.cancellation_reason} />
              </div>
            )}
          </div>
        </div>
      </div>

      <DeleteConfirmDialog
        open={finalizeOpen}
        onOpenChange={setFinalizeOpen}
        title="Finalize this trip sheet?"
        description="Finalizing locks the trip's billing figures and makes it eligible for invoicing. This does not recompute anything — the pricing was already frozen at creation."
        confirmLabel="Finalize"
        onConfirm={handleFinalize}
        isLoading={finalizeTrip.isPending}
      />

      <CancelTripDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        onConfirm={handleCancel}
        isLoading={cancelTrip.isPending}
      />
    </div>
  );
}
