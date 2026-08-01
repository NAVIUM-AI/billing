import { zodResolver } from "@hookform/resolvers/zod";
import { AxiosError } from "axios";
import { useEffect, useState } from "react";
import { FormProvider, useForm, type Path } from "react-hook-form";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { EmptyState } from "@/components/EmptyState";
import { FormField } from "@/components/FormField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CustomerFormDrawer } from "@/features/customers/CustomerFormDrawer";
import { useCustomers } from "@/features/customers/customers.hooks";
import { useDrivers } from "@/features/drivers/drivers.hooks";
import { useApplicablePricingRule } from "@/features/pricingRules/pricingRules.hooks";
import { TollsSubList } from "@/features/tripSheets/components/TollsSubList";
import { useCreateTripSheet, useTripSheet, useUpdateTripSheet } from "@/features/tripSheets/tripSheets.hooks";
import { useVehicles } from "@/features/vehicles/vehicles.hooks";
import {
  TRIP_BILLING_MODE_LABELS,
  TRIP_BILLING_MODES,
  TRIP_SERVICE_TYPE_LABELS,
  TRIP_SERVICE_TYPES,
} from "@/lib/constants/enums";
import { formatPaiseAsRupees } from "@/lib/money";
import { calculateTripPreview, deriveRuleType } from "@/lib/tripPricingCalc";
import { tripSheetFormSchema, type TripSheetFormValues, type TripTollFormValues } from "@/lib/schemas/tripSheet";
import { cn } from "@/lib/utils";
import type { ApiErrorResponse } from "@/types/api";
import type { TripSheet } from "@/types/tripSheet";

const today = () => new Date().toISOString().slice(0, 10);

const EMPTY_VALUES: TripSheetFormValues = {
  service_type: "LOCAL",
  billing_mode: "GST",
  customer_id: "",
  vehicle_id: "",
  driver_id: "",
  trip_date: today(),
  start_datetime: "",
  end_datetime: "",
  opening_km: "",
  closing_km: "",
  total_km: "",
  total_hours: "",
  total_days: "1",
  toll_rupees: "0",
  parking_rupees: "0",
  permit_rupees: "0",
  fasttag_rupees: "0",
  advance_rupees: "0",
  tolls: [],
  booked_by: "",
  pax_note: "",
  remarks: "",
};

function tollToFormValues(t: TripSheet["tolls"][number]): TripTollFormValues {
  return {
    plaza_name: t.plaza_name,
    toll_id: t.toll_id ?? "",
    amount_rupees: String(t.amount_paise / 100),
    crossed_at: t.crossed_at ? t.crossed_at.slice(0, 16) : "",
    vehicle_number: t.vehicle_number ?? "",
    closing_balance_rupees: t.closing_balance_paise != null ? String(t.closing_balance_paise / 100) : "",
    notes: t.notes ?? "",
  };
}

function tripToFormValues(trip: TripSheet): TripSheetFormValues {
  return {
    service_type: trip.service_type,
    billing_mode: trip.billing_mode,
    customer_id: trip.customer_id,
    vehicle_id: trip.vehicle_id,
    driver_id: trip.driver_id ?? "",
    trip_date: trip.trip_date,
    start_datetime: trip.start_datetime ? trip.start_datetime.slice(0, 16) : "",
    end_datetime: trip.end_datetime ? trip.end_datetime.slice(0, 16) : "",
    opening_km: trip.opening_km != null ? String(trip.opening_km) : "",
    closing_km: trip.closing_km != null ? String(trip.closing_km) : "",
    total_km: String(trip.total_km),
    total_hours: String(trip.total_hours),
    total_days: String(trip.total_days),
    toll_rupees: String(trip.toll_paise / 100),
    parking_rupees: String(trip.parking_paise / 100),
    permit_rupees: String(trip.permit_paise / 100),
    fasttag_rupees: String(trip.fasttag_paise / 100),
    advance_rupees: String(trip.advance_paise / 100),
    tolls: trip.tolls.map(tollToFormValues),
    booked_by: trip.booked_by ?? "",
    pax_note: trip.pax_note ?? "",
    remarks: trip.remarks ?? "",
  };
}

function extractApiError(err: unknown) {
  if (err instanceof AxiosError) {
    return (err.response?.data as ApiErrorResponse | undefined)?.error;
  }
  return undefined;
}

export function TripSheetFormPage() {
  const { id } = useParams<{ id?: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const [customerDrawerOpen, setCustomerDrawerOpen] = useState(false);

  const { data: existingTrip, isLoading: isLoadingTrip } = useTripSheet(isEdit ? id : undefined);
  const createTrip = useCreateTripSheet();
  const updateTrip = useUpdateTripSheet();

  const { data: customersData } = useCustomers({ limit: 100 });
  const { data: vehiclesData } = useVehicles({ limit: 100 });
  const { data: driversData } = useDrivers({ limit: 100 });

  const form = useForm<TripSheetFormValues>({
    resolver: zodResolver(tripSheetFormSchema),
    defaultValues: EMPTY_VALUES,
  });
  const { register, handleSubmit, reset, setError, watch, setValue } = form;

  useEffect(() => {
    if (isEdit && existingTrip) {
      reset(tripToFormValues(existingTrip));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, existingTrip?.id]);

  const serviceType = watch("service_type");
  const billingMode = watch("billing_mode");
  const vehicleId = watch("vehicle_id");
  const tripDate = watch("trip_date");
  const totalKm = watch("total_km");
  const totalHours = watch("total_hours");
  const totalDays = watch("total_days");
  const tollRupees = watch("toll_rupees");
  const parkingRupees = watch("parking_rupees");
  const permitRupees = watch("permit_rupees");
  const fasttagRupees = watch("fasttag_rupees");
  const advanceRupees = watch("advance_rupees");
  const tolls = watch("tolls");

  const selectedVehicle = vehiclesData?.vehicles.find((v) => v.id === vehicleId);
  const ruleType = deriveRuleType(serviceType, billingMode);
  const { data: applicableRule, isLoading: isLoadingRule } = useApplicablePricingRule(
    ruleType,
    selectedVehicle?.vehicle_type,
    tripDate,
  );

  // ── EARLY RETURNS (after all hooks above have run) ──
  if (isEdit && isLoadingTrip) {
    return <p className="text-sm text-gray-500">Loading...</p>;
  }
  if (isEdit && existingTrip && existingTrip.status !== "DRAFT") {
    return (
      <EmptyState
        title={`This trip is ${existingTrip.status.toLowerCase()} and can't be edited`}
        description="Only DRAFT trips can be edited. Backend enforces this regardless of what the UI allows, but there's no edit form here either way."
        action={
          <Button onClick={() => navigate(`/trips/${existingTrip.id}`)} className="bg-primary-500 hover:bg-primary-600">
            View trip
          </Button>
        }
      />
    );
  }

  // Effective toll (client-mirror of the same "itemized wins over
  // lump-sum" rule tripSheet.service.js#createTripSheet applies) for
  // the live preview only.
  const tollPaiseForPreview =
    serviceType === "OUTSTATION" && tolls.length > 0
      ? tolls.reduce((sum, t) => sum + Math.round(Number(t.amount_rupees || 0) * 100), 0)
      : Math.round(Number(tollRupees || 0) * 100);

  const preview =
    applicableRule && totalKm !== ""
      ? calculateTripPreview(serviceType, billingMode, applicableRule, {
          totalKm: Number(totalKm) || 0,
          totalHours: Number(totalHours) || 0,
          totalDays: Number(totalDays) || 1,
          tollPaise: tollPaiseForPreview,
          parkingPaise: Math.round(Number(parkingRupees || 0) * 100),
          permitPaise: Math.round(Number(permitRupees || 0) * 100),
          fasttagPaise: Math.round(Number(fasttagRupees || 0) * 100),
          advancePaise: Math.round(Number(advanceRupees || 0) * 100),
        })
      : null;

  async function onSubmit(values: TripSheetFormValues) {
    try {
      if (isEdit && id) {
        await updateTrip.mutateAsync({ id, values });
        toast.success("Trip sheet updated");
      } else {
        const trip = await createTrip.mutateAsync(values);
        toast.success("Trip sheet created");
        navigate(`/trips/${trip.id}`);
      }
    } catch (err) {
      const apiErr = extractApiError(err);
      if (!apiErr) {
        toast.error("Cannot reach server. Try again.");
        return;
      }
      if (apiErr.code === "VALIDATION_ERROR") {
        const fields = (apiErr.details?.fields as { field: string; message: string }[]) || [];
        for (const f of fields) setError(f.field as Path<TripSheetFormValues>, { message: f.message });
        toast.error("Please fix the highlighted fields");
      } else if (apiErr.code === "NO_APPLICABLE_PRICING_RULE") {
        toast.error(apiErr.message);
      } else if (apiErr.code === "TOLL_INPUT_CONFLICT" || apiErr.code === "INVALID_KM_RANGE") {
        toast.error(apiErr.message);
      } else {
        toast.error(apiErr.message || "Something went wrong. Try again.");
      }
    }
  }

  const isSaving = createTrip.isPending || updateTrip.isPending;
  const activeVehicles = vehiclesData?.vehicles.filter((v) => v.is_active) ?? [];
  const activeDrivers =
    driversData?.drivers.filter((d) => d.is_active && (!d.license_expiry_date || d.license_expiry_date >= today())) ??
    [];

  return (
    <div className="mx-auto grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
      <div>
        <h1 className="mb-6 text-2xl font-bold text-gray-900">{isEdit ? "Edit Trip Sheet" : "New Trip Sheet"}</h1>

        <FormProvider {...form}>
          <form id="trip-form" onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-6">
            {/* Card 1: Service Type + Billing Mode selectors */}
            <div className="rounded-lg border bg-white p-4">
              <Label>Service Type</Label>
              <div className="mt-1.5 flex gap-2">
                {TRIP_SERVICE_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    disabled={isEdit}
                    onClick={() => setValue("service_type", t, { shouldValidate: true })}
                    className={cn(
                      "rounded-lg border px-6 py-3 text-sm font-medium transition-colors",
                      serviceType === t
                        ? "border-primary-500 bg-primary-50 text-primary-700"
                        : "border-gray-300 text-gray-600 hover:bg-gray-50",
                      isEdit && "cursor-not-allowed opacity-60",
                    )}
                  >
                    {TRIP_SERVICE_TYPE_LABELS[t]}
                  </button>
                ))}
              </div>

              <Label className="mt-4 block">Billing Mode</Label>
              <div className="mt-1.5 flex gap-2">
                {TRIP_BILLING_MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    disabled={isEdit}
                    onClick={() => setValue("billing_mode", m, { shouldValidate: true })}
                    className={cn(
                      "rounded-lg border px-6 py-3 text-sm font-medium transition-colors",
                      billingMode === m
                        ? "border-primary-500 bg-primary-50 text-primary-700"
                        : "border-gray-300 text-gray-600 hover:bg-gray-50",
                      isEdit && "cursor-not-allowed opacity-60",
                    )}
                  >
                    {TRIP_BILLING_MODE_LABELS[m]}
                  </button>
                ))}
              </div>
              {isEdit && (
                <p className="mt-2 text-xs text-gray-500">Service type and billing mode can't be changed after creation.</p>
              )}
            </div>

            {/* Card 2: Trip Basics */}
            <div className="rounded-lg border bg-white p-4">
              <h2 className="mb-3 text-sm font-semibold text-gray-700">Trip Basics</h2>
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-3">
                  <FormField name="trip_date" label="Trip Date">
                    <Input id="trip_date" type="date" max={today()} {...register("trip_date")} />
                  </FormField>
                  <FormField name="booked_by" label="Booked By (optional)">
                    <Input id="booked_by" {...register("booked_by")} />
                  </FormField>
                </div>

                <div>
                  <Label htmlFor="customer_id">Customer</Label>
                  <select
                    id="customer_id"
                    {...register("customer_id")}
                    className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">Select customer</option>
                    {customersData?.customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.customer_type === "B2B" ? c.company_name : c.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setCustomerDrawerOpen(true)}
                    className="mt-1 text-xs font-medium text-primary-600 hover:text-primary-700"
                  >
                    + Quick create a new customer
                  </button>
                </div>

                <FormField name="remarks" label="Notes (optional)">
                  <textarea
                    id="remarks"
                    rows={2}
                    {...register("remarks")}
                    className="flex w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </FormField>
              </div>
            </div>

            {/* Card 3: Vehicle & Driver */}
            <div className="rounded-lg border bg-white p-4">
              <h2 className="mb-3 text-sm font-semibold text-gray-700">Vehicle &amp; Driver</h2>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="vehicle_id">Vehicle</Label>
                  <select
                    id="vehicle_id"
                    {...register("vehicle_id")}
                    className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">Select vehicle</option>
                    {activeVehicles.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.vehicle_number_display || v.vehicle_number} — {v.vehicle_type}
                      </option>
                    ))}
                  </select>
                  {selectedVehicle && (
                    <p className="mt-1 text-xs text-gray-500">
                      {selectedVehicle.make_model || "—"}
                      {selectedVehicle.seating_capacity ? ` · ${selectedVehicle.seating_capacity} seats` : ""}
                    </p>
                  )}
                </div>
                <div>
                  <Label htmlFor="driver_id">Driver (optional)</Label>
                  <select
                    id="driver_id"
                    {...register("driver_id")}
                    className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">No driver</option>
                    {activeDrivers.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.full_name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Card 4: Usage — LOCAL vs OUTSTATION shape */}
            <div className="rounded-lg border bg-white p-4">
              <h2 className="mb-3 text-sm font-semibold text-gray-700">Trip Usage</h2>
              <div className="grid grid-cols-2 gap-3">
                <FormField name="opening_km" label="Opening KM (optional)">
                  <Input id="opening_km" type="number" {...register("opening_km")} />
                </FormField>
                <FormField name="closing_km" label="Closing KM (optional)">
                  <Input id="closing_km" type="number" {...register("closing_km")} />
                </FormField>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <FormField name="total_km" label={billingMode === "PERFORMANCE" ? "Running KM" : "Total KM"}>
                  <Input id="total_km" type="number" {...register("total_km")} />
                </FormField>
                <FormField name="total_hours" label="Total Hours">
                  <Input id="total_hours" type="number" {...register("total_hours")} />
                </FormField>
              </div>

              {serviceType === "OUTSTATION" && (
                <>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <FormField name="total_days" label="Total Days">
                      <Input id="total_days" type="number" min={1} {...register("total_days")} />
                    </FormField>
                    <FormField name="advance_rupees" label="Advance (₹, optional)">
                      <Input id="advance_rupees" type="number" step="0.01" {...register("advance_rupees")} />
                    </FormField>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-3">
                    <FormField name="parking_rupees" label="Parking (₹)">
                      <Input id="parking_rupees" type="number" step="0.01" {...register("parking_rupees")} />
                    </FormField>
                    <FormField name="permit_rupees" label="Permit (₹)">
                      <Input id="permit_rupees" type="number" step="0.01" {...register("permit_rupees")} />
                    </FormField>
                    <FormField name="fasttag_rupees" label="Fasttag (₹)">
                      <Input id="fasttag_rupees" type="number" step="0.01" {...register("fasttag_rupees")} />
                    </FormField>
                  </div>
                  <div className="mt-3">
                    <TollsSubList />
                  </div>
                </>
              )}

              {serviceType !== "OUTSTATION" && (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <FormField name="toll_rupees" label="Toll (₹, optional)">
                    <Input id="toll_rupees" type="number" step="0.01" {...register("toll_rupees")} />
                  </FormField>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => navigate(-1)}>
                Cancel
              </Button>
              <Button type="submit" form="trip-form" disabled={isSaving} className="bg-primary-500 hover:bg-primary-600">
                {isSaving ? "Saving..." : isEdit ? "Save Changes" : "Create Trip Sheet"}
              </Button>
            </div>
          </form>
        </FormProvider>
      </div>

      {/* Live Total Preview */}
      <div className="lg:sticky lg:top-4 lg:self-start">
        <div className="rounded-lg border bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Live Total Preview</h2>
          {isLoadingRule && <p className="text-sm text-gray-500">Looking up pricing rule...</p>}
          {!isLoadingRule && !applicableRule && selectedVehicle && (
            <div className="rounded-md border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-800">
              No pricing rule for {ruleType} + {selectedVehicle.vehicle_type}. Create one in Pricing Rules first.
            </div>
          )}
          {!selectedVehicle && <p className="text-sm text-gray-500">Select a vehicle to see a live total.</p>}
          {preview && (
            <div className="flex flex-col gap-1.5 text-sm">
              {preview.breakdown.map((item, i) => (
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
                <span>{formatPaiseAsRupees(preview.net_payable_paise)}</span>
              </div>
              <p className="mt-1 text-xs text-gray-400">
                Preview only — the backend recomputes this on save and is the source of truth.
              </p>
            </div>
          )}
        </div>
      </div>

      <CustomerFormDrawer open={customerDrawerOpen} onOpenChange={setCustomerDrawerOpen} />
    </div>
  );
}
