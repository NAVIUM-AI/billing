import { zodResolver } from "@hookform/resolvers/zod";
import { AxiosError } from "axios";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { FormProvider, useFieldArray, useForm, useFormContext, type Path } from "react-hook-form";
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
import type { RuleType, TripBillingMode, TripServiceType } from "@/lib/constants/enums";
import { formatPaiseAsRupees, paiseToRupees } from "@/lib/money";
import { calculateTripPreview, deriveRuleType, type RuleForCalc, type TripPreviewResult } from "@/lib/tripPricingCalc";
import {
  tripSheetFormSchema,
  type TripSheetFormValues,
  type TripSheetVehicleFormValues,
  type TripTollFormValues,
} from "@/lib/schemas/tripSheet";
import { cn } from "@/lib/utils";
import type { ApiErrorResponse } from "@/types/api";
import type { TripSheet, TripSheetVehicle } from "@/types/tripSheet";

const today = () => new Date().toISOString().slice(0, 10);
const MAX_VEHICLES = 10;

const EMPTY_VEHICLE: TripSheetVehicleFormValues = {
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
  start_datetime: "",
  end_datetime: "",
  total_km: "",
  total_hours: "",
  total_days: "1",
  toll_rupees: "0",
  parking_rupees: "0",
  permit_rupees: "0",
  fasttag_rupees: "0",
  advance_rupees: "0",
};

const EMPTY_VALUES: TripSheetFormValues = {
  service_type: "LOCAL",
  billing_mode: "GST",
  customer_id: "",
  manual_customer_name: "",
  vehicles: [EMPTY_VEHICLE],
  trip_date: today(),
  tolls: [],
  booked_by: "",
  pax_note: "",
  remarks: "",
};

// paise -> rupee-string for prefilling the edit form's rate inputs from
// a vehicle's frozen snap_* columns. paiseToRupees already returns ""
// for null, matching numericStringField's optional-field handling.
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

function vehicleToFormValues(v: TripSheetVehicle): TripSheetVehicleFormValues {
  return {
    manual_vehicle_number: v.snapshot_vehicle_number,
    manual_vehicle_type: v.snapshot_vehicle_type,
    driver_id: v.driver_id ?? "",
    base_price_rupees: paiseFieldToRupeeString(v.snap_base_price_paise),
    base_hours: v.snap_base_hours != null ? String(v.snap_base_hours) : "",
    base_km: v.snap_base_km != null ? String(v.snap_base_km) : "",
    extra_km_rate_rupees: paiseFieldToRupeeString(v.snap_extra_km_rate_paise),
    extra_hr_rate_rupees: paiseFieldToRupeeString(v.snap_extra_hr_rate_paise),
    slab_rate_rupees: paiseFieldToRupeeString(v.snap_slab_rate_paise),
    min_km_per_day: v.snap_min_km_per_day != null ? String(v.snap_min_km_per_day) : "",
    driver_batta_per_day_rupees: paiseFieldToRupeeString(v.snap_driver_batta_per_day_paise),
    per_km_rate_rupees: paiseFieldToRupeeString(v.snap_per_km_rate_paise),
    performance_batta_rupees: paiseFieldToRupeeString(v.snap_performance_batta_paise),
    start_datetime: v.start_datetime ? v.start_datetime.slice(0, 16) : "",
    end_datetime: v.end_datetime ? v.end_datetime.slice(0, 16) : "",
    total_km: String(v.total_km),
    total_hours: String(v.total_hours),
    total_days: String(v.total_days),
    toll_rupees: String(v.toll_paise / 100),
    parking_rupees: String(v.parking_paise / 100),
    permit_rupees: String(v.permit_paise / 100),
    fasttag_rupees: String(v.fasttag_paise / 100),
    advance_rupees: String(v.advance_paise / 100),
  };
}

// Task B1: vehicles is a PATCH-able whole-array-replace now (unlike
// before, when every vehicle/rate field was create-only immutable —
// see tripSheets.api.ts's own toUpdatePayload comment), so the edit
// form's vehicle cards are editable here, not disabled — this matches
// the actual backend capability rather than a stale immutability
// restriction the restructure removed. Only sheet-level identity
// (service_type/billing_mode/customer) stays immutable in edit mode,
// same as before.
function tripToFormValues(trip: TripSheet): TripSheetFormValues {
  return {
    service_type: trip.service_type,
    billing_mode: trip.billing_mode,
    customer_id: trip.customer_id ?? "",
    manual_customer_name: trip.manual_customer_name ?? "",
    vehicles: trip.vehicles.map(vehicleToFormValues),
    trip_date: trip.trip_date,
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

function toPaiseOrUndef(rupees: string | undefined): number | undefined {
  return rupees ? Math.round(Number(rupees) * 100) : undefined;
}

function vehicleRuleForCalc(v: TripSheetVehicleFormValues): RuleForCalc {
  return {
    base_price_paise: toPaiseOrUndef(v.base_price_rupees),
    base_hours: v.base_hours ? Number(v.base_hours) : undefined,
    base_km: v.base_km ? Number(v.base_km) : undefined,
    extra_km_rate_paise: toPaiseOrUndef(v.extra_km_rate_rupees),
    extra_hr_rate_paise: toPaiseOrUndef(v.extra_hr_rate_rupees),
    slab_rate_paise: toPaiseOrUndef(v.slab_rate_rupees),
    min_km_per_day: v.min_km_per_day ? Number(v.min_km_per_day) : undefined,
    driver_batta_per_day_paise: toPaiseOrUndef(v.driver_batta_per_day_rupees),
    per_km_rate_paise: toPaiseOrUndef(v.per_km_rate_rupees),
    performance_batta_paise: toPaiseOrUndef(v.performance_batta_rupees),
  };
}

// Same required-field set as MANUAL_RATE_FIELDS_BY_FORMULA in
// lib/schemas/tripSheet.ts, checked directly against the rule object's
// own relevant keys so this can't drift from what calculateTripPreview
// will actually use.
const REQUIRED_KEYS_BY_FORMULA: Record<RuleType, (keyof RuleForCalc)[]> = {
  LOCAL_PACKAGE: ["base_price_paise", "base_hours", "base_km", "extra_km_rate_paise", "extra_hr_rate_paise"],
  OUTSTATION_SLAB: ["slab_rate_paise", "min_km_per_day", "driver_batta_per_day_paise"],
  PERFORMANCE: ["per_km_rate_paise", "performance_batta_paise"],
};

function vehiclePreview(
  v: TripSheetVehicleFormValues,
  serviceType: TripServiceType,
  billingMode: TripBillingMode,
  ruleType: RuleType,
  effectiveTollPaise: number,
): TripPreviewResult | null {
  const rule = vehicleRuleForCalc(v);
  const complete = REQUIRED_KEYS_BY_FORMULA[ruleType].every((k) => rule[k] != null);
  if (!complete || v.total_km === "") return null;
  return calculateTripPreview(serviceType, billingMode, rule, {
    totalKm: Number(v.total_km) || 0,
    totalHours: Number(v.total_hours) || 0,
    totalDays: Number(v.total_days) || 1,
    tollPaise: effectiveTollPaise,
    parkingPaise: Math.round(Number(v.parking_rupees || 0) * 100),
    permitPaise: Math.round(Number(v.permit_rupees || 0) * 100),
    fasttagPaise: Math.round(Number(v.fasttag_rupees || 0) * 100),
    advancePaise: Math.round(Number(v.advance_rupees || 0) * 100),
  });
}

// One vehicle card — Vehicle identity, Rate Details (dynamic per
// formula), Usage/Charges, and a per-card live total footer. `preview`
// is computed by the PARENT (which owns the itemized-tolls-override
// logic that spans the whole form, not just one card) and passed down.
function VehicleFormCard({
  index,
  onRemove,
  canRemove,
  serviceType,
  billingMode,
  ruleType,
  preview,
}: {
  index: number;
  onRemove: () => void;
  canRemove: boolean;
  serviceType: TripServiceType;
  billingMode: TripBillingMode;
  ruleType: RuleType;
  preview: TripPreviewResult | null;
}) {
  const { register } = useFormContext<TripSheetFormValues>();
  const p = (field: keyof TripSheetVehicleFormValues) => `vehicles.${index}.${field}` as const;

  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">Vehicle {index + 1}</h3>
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label="Remove vehicle"
          className={cn("text-gray-400 hover:text-red-600", !canRemove && "cursor-not-allowed opacity-30")}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FormField name={p("manual_vehicle_number")} label="Vehicle Number">
          <Input id={p("manual_vehicle_number")} placeholder="e.g. KA51AK1031" className="uppercase" {...register(p("manual_vehicle_number"))} />
        </FormField>
        <div>
          <Label htmlFor={p("manual_vehicle_type")}>Vehicle Type</Label>
          <select
            id={p("manual_vehicle_type")}
            {...register(p("manual_vehicle_type"))}
            className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {VEHICLE_TYPES.map((t) => (
              <option key={t} value={t}>
                {VEHICLE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-3">
        <p className="mb-2 text-xs text-gray-500">
          {ruleType === "LOCAL_PACKAGE" && "Local package: base slab + extra km/hour rates."}
          {ruleType === "OUTSTATION_SLAB" && "Outstation slab: per-km rate with a minimum km/day floor."}
          {ruleType === "PERFORMANCE" && "Performance: per-km rate + a flat batta (internal cost tracking, not a GST invoice)."}
        </p>

        {ruleType === "LOCAL_PACKAGE" && (
          <div className="grid grid-cols-2 gap-3">
            <FormField name={p("base_price_rupees")} label="Base Price (₹)">
              <Input id={p("base_price_rupees")} type="number" step="0.01" {...register(p("base_price_rupees"))} />
            </FormField>
            <FormField name={p("base_hours")} label="Base Hours">
              <Input id={p("base_hours")} type="number" placeholder="8" {...register(p("base_hours"))} />
            </FormField>
            <FormField name={p("base_km")} label="Base Km">
              <Input id={p("base_km")} type="number" placeholder="80" {...register(p("base_km"))} />
            </FormField>
            <FormField name={p("extra_km_rate_rupees")} label="Extra Km Rate (₹/km)">
              <Input id={p("extra_km_rate_rupees")} type="number" step="0.01" {...register(p("extra_km_rate_rupees"))} />
            </FormField>
            <FormField name={p("extra_hr_rate_rupees")} label="Extra Hour Rate (₹/hr)">
              <Input id={p("extra_hr_rate_rupees")} type="number" step="0.01" {...register(p("extra_hr_rate_rupees"))} />
            </FormField>
          </div>
        )}

        {ruleType === "OUTSTATION_SLAB" && (
          <div className="grid grid-cols-2 gap-3">
            <FormField name={p("slab_rate_rupees")} label="Slab Rate (₹/km)">
              <Input id={p("slab_rate_rupees")} type="number" step="0.01" {...register(p("slab_rate_rupees"))} />
            </FormField>
            <FormField name={p("min_km_per_day")} label="Min Km Per Day">
              <Input id={p("min_km_per_day")} type="number" placeholder="250" {...register(p("min_km_per_day"))} />
            </FormField>
            <FormField name={p("driver_batta_per_day_rupees")} label="Driver Batta Per Day (₹)">
              <Input id={p("driver_batta_per_day_rupees")} type="number" step="0.01" {...register(p("driver_batta_per_day_rupees"))} />
            </FormField>
          </div>
        )}

        {ruleType === "PERFORMANCE" && (
          <div className="grid grid-cols-2 gap-3">
            <FormField name={p("per_km_rate_rupees")} label="Per Km Rate (₹/km)">
              <Input id={p("per_km_rate_rupees")} type="number" step="0.01" {...register(p("per_km_rate_rupees"))} />
            </FormField>
            {/* Flat amount, not "per day" — see MANUAL_RATE_FIELDS_BY_FORMULA's own comment. */}
            <FormField name={p("performance_batta_rupees")} label="Performance Batta (₹)">
              <Input id={p("performance_batta_rupees")} type="number" step="0.01" {...register(p("performance_batta_rupees"))} />
            </FormField>
          </div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <FormField name={p("total_km")} label={billingMode === "PERFORMANCE" ? "Running KM" : "Total KM"}>
          <Input id={p("total_km")} type="number" {...register(p("total_km"))} />
        </FormField>
        <FormField name={p("total_hours")} label="Total Hours">
          <Input id={p("total_hours")} type="number" {...register(p("total_hours"))} />
        </FormField>
      </div>

      {serviceType === "OUTSTATION" && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <FormField name={p("total_days")} label="Total Days">
              <Input id={p("total_days")} type="number" min={1} {...register(p("total_days"))} />
            </FormField>
            <FormField name={p("advance_rupees")} label="Advance (₹, optional)">
              <Input id={p("advance_rupees")} type="number" step="0.01" {...register(p("advance_rupees"))} />
            </FormField>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <FormField name={p("parking_rupees")} label="Parking (₹)">
              <Input id={p("parking_rupees")} type="number" step="0.01" {...register(p("parking_rupees"))} />
            </FormField>
            <FormField name={p("permit_rupees")} label="Permit (₹)">
              <Input id={p("permit_rupees")} type="number" step="0.01" {...register(p("permit_rupees"))} />
            </FormField>
            <FormField name={p("fasttag_rupees")} label="Fasttag (₹)">
              <Input id={p("fasttag_rupees")} type="number" step="0.01" {...register(p("fasttag_rupees"))} />
            </FormField>
          </div>
        </>
      )}

      {serviceType !== "OUTSTATION" && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <FormField name={p("toll_rupees")} label="Toll (₹, optional)">
            <Input id={p("toll_rupees")} type="number" step="0.01" {...register(p("toll_rupees"))} />
          </FormField>
        </div>
      )}

      {preview && (
        <div className="mt-3 flex flex-col gap-1 border-t pt-3 text-xs text-gray-600">
          {preview.breakdown.map((item, i) => (
            <div key={i} className="flex justify-between">
              <span>
                {item.label}
                {item.detail && <span className="text-gray-400"> ({item.detail})</span>}
              </span>
              <span>{formatPaiseAsRupees(item.value_paise)}</span>
            </div>
          ))}
          <div className="mt-1 flex justify-between border-t pt-1 text-sm font-semibold text-gray-900">
            <span>Taxable Value</span>
            <span>{formatPaiseAsRupees(preview.net_payable_paise)}</span>
          </div>
        </div>
      )}
    </div>
  );
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
  const { register, handleSubmit, reset, setError, watch, setValue, control } = form;
  const { fields: vehicleFields, append, remove } = useFieldArray({ control, name: "vehicles" });

  useEffect(() => {
    if (isEdit && existingTrip) {
      reset(tripToFormValues(existingTrip));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, existingTrip?.id]);

  const serviceType = watch("service_type");
  const billingMode = watch("billing_mode");
  const vehicles = watch("vehicles");
  const tolls = watch("tolls");
  const ruleType = deriveRuleType(serviceType, billingMode);

  // Itemized tolls only apply to a lone vehicle (see
  // tripSheet.validator.js's own tolls.multiVehicleUnsupported check) —
  // their sum overrides vehicle #1's own toll_rupees for the preview,
  // mirroring tripSheet.service.js#createTripSheet's exact precedence.
  const itemizedTollsSumPaise = tolls.reduce((sum, t) => sum + Math.round(Number(t.amount_rupees || 0) * 100), 0);
  const previews = vehicles.map((v, idx) => {
    const effectiveTollPaise =
      idx === 0 && vehicles.length === 1 && serviceType === "OUTSTATION" && tolls.length > 0
        ? itemizedTollsSumPaise
        : Math.round(Number(v.toll_rupees || 0) * 100);
    return vehiclePreview(v, serviceType, billingMode, ruleType, effectiveTollPaise);
  });
  const grandTotalPaise = previews.reduce((sum, pv) => sum + (pv?.net_payable_paise ?? 0), 0);
  const allPreviewsReady = previews.length > 0 && previews.every((pv) => pv !== null);

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
      } else if (
        apiErr.code === "TOLL_INPUT_CONFLICT" ||
        apiErr.code === "INVALID_KM_RANGE" ||
        apiErr.code === "TOLLS_MULTI_VEHICLE_UNSUPPORTED" ||
        apiErr.code === "INVALID_VEHICLE_ITEM"
      ) {
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
                  <Label htmlFor="customer_id">Customer (optional)</Label>
                  <select
                    id="customer_id"
                    disabled={isEdit}
                    {...register("customer_id")}
                    className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <option value="">No saved customer</option>
                    {customersData?.customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.customer_type === "B2B" ? c.company_name : c.name}
                      </option>
                    ))}
                  </select>
                  {!isEdit && (
                    <button
                      type="button"
                      onClick={() => setCustomerDrawerOpen(true)}
                      className="mt-1 text-xs font-medium text-primary-600 hover:text-primary-700"
                    >
                      + Quick create a new customer
                    </button>
                  )}
                </div>
                <div>
                  <FormField name="manual_customer_name" label="Or type a customer name (optional)">
                    <Input
                      id="manual_customer_name"
                      placeholder="e.g. a walk-in or one-off customer"
                      disabled={isEdit || Boolean(watch("customer_id"))}
                      {...register("manual_customer_name")}
                    />
                  </FormField>
                  {Boolean(watch("customer_id")) && (
                    <p className="mt-1 text-xs text-gray-500">
                      A saved customer is selected above — clear it to type a name instead.
                    </p>
                  )}
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

            {/* Vehicles — 1 to 10 fully self-contained cards (Task B1).
                Most trips are sub-contracted to partner operators outside
                the registered fleet, so this form still offers manual
                entry only (no fleet vehicle picker) — see the original
                trip-sheets-manual-mode task. Unlike before, these are
                editable on the edit form too — the whole array is now
                PATCH-able (delete + reinsert), not create-only immutable. */}
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-700">Vehicles ({vehicleFields.length})</h2>
                <button
                  type="button"
                  onClick={() => append(EMPTY_VEHICLE)}
                  disabled={vehicleFields.length >= MAX_VEHICLES}
                  className={cn(
                    "text-sm font-medium text-primary-600 hover:text-primary-700",
                    vehicleFields.length >= MAX_VEHICLES && "cursor-not-allowed opacity-40",
                  )}
                >
                  + Add Vehicle
                </button>
              </div>
              <div className="flex flex-col gap-4">
                {vehicleFields.map((field, index) => (
                  <VehicleFormCard
                    key={field.id}
                    index={index}
                    onRemove={() => remove(index)}
                    canRemove={vehicleFields.length > 1}
                    serviceType={serviceType}
                    billingMode={billingMode}
                    ruleType={ruleType}
                    preview={previews[index] ?? null}
                  />
                ))}
              </div>
            </div>

            {/* Itemized toll-plaza receipts — only meaningful against a
                single vehicle's toll_paise (see this form's tolls
                comment); hidden once a second vehicle is added. */}
            {serviceType === "OUTSTATION" && vehicleFields.length === 1 && (
              <div className="rounded-lg border bg-white p-4">
                <TollsSubList />
              </div>
            )}
            {serviceType === "OUTSTATION" && vehicleFields.length > 1 && tolls.length > 0 && (
              <p className="text-xs text-amber-600">
                Itemized toll receipts only apply to single-vehicle trips — remove extra vehicles or clear the toll list, or use
                each vehicle's own Toll field instead.
              </p>
            )}

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

      {/* Live Total Preview — per-vehicle lines + a sheet-level sum */}
      <div className="lg:sticky lg:top-4 lg:self-start">
        <div className="rounded-lg border bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">Live Total Preview</h2>
          {!allPreviewsReady && <p className="text-sm text-gray-500">Fill in every vehicle's rate details to see a live total.</p>}
          {allPreviewsReady && (
            <div className="flex flex-col gap-2 text-sm">
              {previews.map((pv, i) => (
                <div key={i} className="flex justify-between text-gray-600">
                  <span>Vehicle {i + 1}</span>
                  <span>{formatPaiseAsRupees(pv!.net_payable_paise)}</span>
                </div>
              ))}
              <div className="mt-2 flex justify-between border-t pt-2 font-semibold text-gray-900">
                <span>Net Payable</span>
                <span>{formatPaiseAsRupees(grandTotalPaise)}</span>
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
