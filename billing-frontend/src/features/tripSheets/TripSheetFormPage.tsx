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
import { TollsSubList } from "@/features/tripSheets/components/TollsSubList";
import { useCreateTripSheet, useTripSheet, useUpdateTripSheet } from "@/features/tripSheets/tripSheets.hooks";
import {
  TRIP_BILLING_MODE_LABELS,
  TRIP_BILLING_MODES,
  TRIP_SERVICE_TYPE_LABELS,
  TRIP_SERVICE_TYPES,
  VEHICLE_TYPES,
  VEHICLE_TYPE_LABELS,
} from "@/lib/constants/enums";
import { formatPaiseAsRupees, paiseToRupees } from "@/lib/money";
import { calculateTripPreview, deriveRuleType, type RuleForCalc } from "@/lib/tripPricingCalc";
import { tripSheetFormSchema, type TripSheetFormValues, type TripTollFormValues } from "@/lib/schemas/tripSheet";
import { cn } from "@/lib/utils";
import type { ApiErrorResponse } from "@/types/api";
import type { TripSheet } from "@/types/tripSheet";

const today = () => new Date().toISOString().slice(0, 10);

const EMPTY_VALUES: TripSheetFormValues = {
  service_type: "LOCAL",
  billing_mode: "GST",
  customer_id: "",
  manual_vehicle_number: "",
  manual_vehicle_type: "SEDAN",
  driver_id: "",
  base_price_rupees: "",
  base_hours: "",
  base_km: "",
  extra_km_rate_rupees: "",
  extra_hr_rate_rupees: "",
  slab_rate_rupees: "",
  min_km_per_day: "",
  driver_batta_per_day_rupees: "",
  per_km_rate_rupees: "",
  performance_batta_rupees: "",
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

// paise -> rupee-string for prefilling the edit form's (disabled, but
// still displayed) rate inputs from a trip's immutable snap_* columns.
// paiseToRupees already returns "" for null, matching
// numericStringField's optional-field handling.
function paiseFieldToRupeeString(paise: number | null): string {
  return String(paiseToRupees(paise));
}

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
    // Vehicle/rate fields are immutable post-create (not in
    // updateTripSheetSchema at all — same as fleet mode's vehicle_id/
    // pricing_rule_id) — prefilled here purely for display on the edit
    // form, whose inputs render `disabled` for these fields. Works
    // identically for a FLEET-mode trip being edited (pre-existing,
    // this task doesn't touch those) since snapshot_vehicle_number/
    // type and snap_* are populated the same way in both modes.
    manual_vehicle_number: trip.snapshot_vehicle_number,
    manual_vehicle_type: trip.snapshot_vehicle_type,
    driver_id: trip.driver_id ?? "",
    base_price_rupees: paiseFieldToRupeeString(trip.snap_base_price_paise),
    base_hours: trip.snap_base_hours != null ? String(trip.snap_base_hours) : "",
    base_km: trip.snap_base_km != null ? String(trip.snap_base_km) : "",
    extra_km_rate_rupees: paiseFieldToRupeeString(trip.snap_extra_km_rate_paise),
    extra_hr_rate_rupees: paiseFieldToRupeeString(trip.snap_extra_hr_rate_paise),
    slab_rate_rupees: paiseFieldToRupeeString(trip.snap_slab_rate_paise),
    min_km_per_day: trip.snap_min_km_per_day != null ? String(trip.snap_min_km_per_day) : "",
    driver_batta_per_day_rupees: paiseFieldToRupeeString(trip.snap_driver_batta_per_day_paise),
    per_km_rate_rupees: paiseFieldToRupeeString(trip.snap_per_km_rate_paise),
    performance_batta_rupees: paiseFieldToRupeeString(trip.snap_performance_batta_paise),
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
  const totalKm = watch("total_km");
  const totalHours = watch("total_hours");
  const totalDays = watch("total_days");
  const tollRupees = watch("toll_rupees");
  const parkingRupees = watch("parking_rupees");
  const permitRupees = watch("permit_rupees");
  const fasttagRupees = watch("fasttag_rupees");
  const advanceRupees = watch("advance_rupees");
  const tolls = watch("tolls");
  const basePriceRupees = watch("base_price_rupees");
  const baseHours = watch("base_hours");
  const baseKm = watch("base_km");
  const extraKmRateRupees = watch("extra_km_rate_rupees");
  const extraHrRateRupees = watch("extra_hr_rate_rupees");
  const slabRateRupees = watch("slab_rate_rupees");
  const minKmPerDay = watch("min_km_per_day");
  const driverBattaPerDayRupees = watch("driver_batta_per_day_rupees");
  const perKmRateRupees = watch("per_km_rate_rupees");
  const performanceBattaRupees = watch("performance_batta_rupees");

  const ruleType = deriveRuleType(serviceType, billingMode);

  // The manual rate fields ARE the rule for the live preview — same
  // shape calculateTripPreview already expects, built straight from
  // this render's watched form values instead of a fetched fleet rule.
  // Only the active formula's fields matter; the others are simply
  // unset (undefined) on whichever RuleForCalc this produces.
  const toPaise = (rupees: string | undefined) => (rupees ? Math.round(Number(rupees) * 100) : undefined);
  const manualRule: RuleForCalc = {
    base_price_paise: toPaise(basePriceRupees),
    base_hours: baseHours ? Number(baseHours) : undefined,
    base_km: baseKm ? Number(baseKm) : undefined,
    extra_km_rate_paise: toPaise(extraKmRateRupees),
    extra_hr_rate_paise: toPaise(extraHrRateRupees),
    slab_rate_paise: toPaise(slabRateRupees),
    min_km_per_day: minKmPerDay ? Number(minKmPerDay) : undefined,
    driver_batta_per_day_paise: toPaise(driverBattaPerDayRupees),
    per_km_rate_paise: toPaise(perKmRateRupees),
    performance_batta_paise: toPaise(performanceBattaRupees),
  };
  // Whether every rate field the ACTIVE formula needs has been filled
  // in yet — same required-field set as MANUAL_RATE_FIELDS_BY_FORMULA
  // in lib/schemas/tripSheet.ts, checked directly against the rule
  // object's own relevant keys so this can't drift from what
  // calculateTripPreview will actually use.
  const requiredKeysByFormula: Record<string, (keyof RuleForCalc)[]> = {
    LOCAL_PACKAGE: ["base_price_paise", "base_hours", "base_km", "extra_km_rate_paise", "extra_hr_rate_paise"],
    OUTSTATION_SLAB: ["slab_rate_paise", "min_km_per_day", "driver_batta_per_day_paise"],
    PERFORMANCE: ["per_km_rate_paise", "performance_batta_paise"],
  };
  const rateFieldsComplete = requiredKeysByFormula[ruleType].every((k) => manualRule[k] != null);

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
    rateFieldsComplete && totalKm !== ""
      ? calculateTripPreview(serviceType, billingMode, manualRule, {
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

            {/* Card 3: Vehicle — manual entry only (trip-sheets-manual-mode).
                Most trips are sub-contracted to partner operators outside
                the registered fleet, so this form no longer offers a
                fleet vehicle picker at all — Vehicles/Drivers/Pricing
                Rules screens still exist, just aren't consulted here.
                Immutable post-create, same as fleet mode's vehicle_id
                was — disabled (not omitted) in edit mode so the original
                entry stays visible. */}
            <div className="rounded-lg border bg-white p-4">
              <h2 className="mb-3 text-sm font-semibold text-gray-700">Vehicle</h2>
              <div className="grid grid-cols-2 gap-3">
                <FormField name="manual_vehicle_number" label="Vehicle Number">
                  <Input
                    id="manual_vehicle_number"
                    placeholder="e.g. KA51AK1031"
                    className="uppercase"
                    disabled={isEdit}
                    {...register("manual_vehicle_number")}
                  />
                </FormField>
                <div>
                  <Label htmlFor="manual_vehicle_type">Vehicle Type</Label>
                  <select
                    id="manual_vehicle_type"
                    disabled={isEdit}
                    {...register("manual_vehicle_type")}
                    className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {VEHICLE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {VEHICLE_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {isEdit && <p className="mt-2 text-xs text-gray-500">Vehicle details can't be changed after creation.</p>}
            </div>

            {/* Card: Rate Details — dynamic per formula (Formula A/B/C) */}
            <div className="rounded-lg border bg-white p-4">
              <h2 className="mb-1 text-sm font-semibold text-gray-700">Rate Details</h2>
              <p className="mb-3 text-xs text-gray-500">
                {ruleType === "LOCAL_PACKAGE" && "Local package: base slab + extra km/hour rates."}
                {ruleType === "OUTSTATION_SLAB" && "Outstation slab: per-km rate with a minimum km/day floor."}
                {ruleType === "PERFORMANCE" && "Performance: per-km rate + a flat batta (internal cost tracking, not a GST invoice)."}
              </p>

              {ruleType === "LOCAL_PACKAGE" && (
                <div className="grid grid-cols-2 gap-3">
                  <FormField name="base_price_rupees" label="Base Price (₹)">
                    <Input id="base_price_rupees" type="number" step="0.01" disabled={isEdit} {...register("base_price_rupees")} />
                  </FormField>
                  <FormField name="base_hours" label="Base Hours">
                    <Input id="base_hours" type="number" placeholder="8" disabled={isEdit} {...register("base_hours")} />
                  </FormField>
                  <FormField name="base_km" label="Base Km">
                    <Input id="base_km" type="number" placeholder="80" disabled={isEdit} {...register("base_km")} />
                  </FormField>
                  <FormField name="extra_km_rate_rupees" label="Extra Km Rate (₹/km)">
                    <Input id="extra_km_rate_rupees" type="number" step="0.01" disabled={isEdit} {...register("extra_km_rate_rupees")} />
                  </FormField>
                  <FormField name="extra_hr_rate_rupees" label="Extra Hour Rate (₹/hr)">
                    <Input id="extra_hr_rate_rupees" type="number" step="0.01" disabled={isEdit} {...register("extra_hr_rate_rupees")} />
                  </FormField>
                </div>
              )}

              {ruleType === "OUTSTATION_SLAB" && (
                <div className="grid grid-cols-2 gap-3">
                  <FormField name="slab_rate_rupees" label="Slab Rate (₹/km)">
                    <Input id="slab_rate_rupees" type="number" step="0.01" disabled={isEdit} {...register("slab_rate_rupees")} />
                  </FormField>
                  <FormField name="min_km_per_day" label="Min Km Per Day">
                    <Input id="min_km_per_day" type="number" placeholder="250" disabled={isEdit} {...register("min_km_per_day")} />
                  </FormField>
                  <FormField name="driver_batta_per_day_rupees" label="Driver Batta Per Day (₹)">
                    <Input
                      id="driver_batta_per_day_rupees"
                      type="number"
                      step="0.01"
                      disabled={isEdit}
                      {...register("driver_batta_per_day_rupees")}
                    />
                  </FormField>
                </div>
              )}

              {ruleType === "PERFORMANCE" && (
                <div className="grid grid-cols-2 gap-3">
                  <FormField name="per_km_rate_rupees" label="Per Km Rate (₹/km)">
                    <Input id="per_km_rate_rupees" type="number" step="0.01" disabled={isEdit} {...register("per_km_rate_rupees")} />
                  </FormField>
                  {/* Flat amount, not "per day" — see this file's top-level
                      MANUAL_RATE_FIELDS_BY_FORMULA comment (Part A finding). */}
                  <FormField name="performance_batta_rupees" label="Performance Batta (₹)">
                    <Input
                      id="performance_batta_rupees"
                      type="number"
                      step="0.01"
                      disabled={isEdit}
                      {...register("performance_batta_rupees")}
                    />
                  </FormField>
                </div>
              )}
              {isEdit && <p className="mt-2 text-xs text-gray-500">Rates can't be changed after creation.</p>}
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
          {!rateFieldsComplete && <p className="text-sm text-gray-500">Fill in the rate details to see a live total.</p>}
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
