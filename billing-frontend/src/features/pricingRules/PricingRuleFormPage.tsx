import { zodResolver } from "@hookform/resolvers/zod";
import { AxiosError } from "axios";
import { addDays, format, parseISO } from "date-fns";
import { useEffect } from "react";
import { FormProvider, useForm, type Path } from "react-hook-form";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { EmptyState } from "@/components/EmptyState";
import { FormField } from "@/components/FormField";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreatePricingRule, usePricingRule, useSupersedePricingRule } from "@/features/pricingRules/pricingRules.hooks";
import { RULE_TYPES, RULE_TYPE_LABELS, VEHICLE_TYPES, VEHICLE_TYPE_LABELS } from "@/lib/constants/enums";
import { paiseToRupees } from "@/lib/money";
import { pricingRuleFormSchema, type PricingRuleFormValues } from "@/lib/schemas/pricingRule";
import type { ApiErrorResponse } from "@/types/api";
import type { PricingRule } from "@/types/pricingRule";

const today = () => new Date().toISOString().slice(0, 10);

// pricing_rules_effective_range CHECK (effective_to IS NULL OR
// effective_to > effective_from) means a supersede's new effective_from
// must be STRICTLY AFTER the current version's own effective_from —
// supersede() sets old.effective_to = new.effective_from, so a
// same-day supersede (both dates equal "today", e.g. superseding a
// rule created earlier today) makes the OLD row's range empty and
// violates that constraint. The backend's own supersede() repo
// function doesn't wrap this particular UPDATE in the same
// mapConstraintError() catch its sibling insert() uses, so this
// currently leaks as a raw 500 (Postgres code 23514) instead of a
// clean 400 — caught only by actually driving a same-day supersede in
// the browser. Out of scope to fix backend-side this phase (Rule:
// zero backend changes), so the frontend prevents it proactively
// instead: the effective_from input's min is never earlier than the
// day AFTER the current version started.
function minSupersedeDate(currentEffectiveFrom: string): string {
  const dayAfterCurrent = format(addDays(parseISO(currentEffectiveFrom), 1), "yyyy-MM-dd");
  return dayAfterCurrent > today() ? dayAfterCurrent : today();
}

const EMPTY_VALUES: PricingRuleFormValues = {
  rule_type: "LOCAL_PACKAGE",
  vehicle_type: "SEDAN",
  label: "",
  notes: "",
  effective_from: today(),
  base_hours: "",
  base_km: "",
  base_price_rupees: "",
  extra_km_rate_rupees: "",
  extra_hr_rate_rupees: "",
  slab_rate_rupees: "",
  min_km_per_day: "",
  driver_batta_per_day_rupees: "",
  per_km_rate_rupees: "",
  performance_batta_rupees: "",
};

function ruleToFormValues(rule: PricingRule): PricingRuleFormValues {
  return {
    rule_type: rule.rule_type,
    vehicle_type: rule.vehicle_type,
    label: rule.label,
    notes: rule.notes ?? "",
    // See minSupersedeDate's comment — must be strictly after THIS
    // rule's own effective_from, not just "today or later".
    effective_from: minSupersedeDate(rule.effective_from),
    base_hours: rule.base_hours != null ? String(rule.base_hours) : "",
    base_km: rule.base_km != null ? String(rule.base_km) : "",
    base_price_rupees: String(paiseToRupees(rule.base_price_paise)),
    extra_km_rate_rupees: String(paiseToRupees(rule.extra_km_rate_paise)),
    extra_hr_rate_rupees: String(paiseToRupees(rule.extra_hr_rate_paise)),
    slab_rate_rupees: String(paiseToRupees(rule.slab_rate_paise)),
    min_km_per_day: rule.min_km_per_day != null ? String(rule.min_km_per_day) : "",
    driver_batta_per_day_rupees: String(paiseToRupees(rule.driver_batta_per_day_paise)),
    per_km_rate_rupees: String(paiseToRupees(rule.per_km_rate_paise)),
    performance_batta_rupees: String(paiseToRupees(rule.performance_batta_paise)),
  };
}

export function PricingRuleFormPage() {
  const { id } = useParams<{ id?: string }>();
  const isSupersede = Boolean(id);
  const navigate = useNavigate();

  const { data: existingRule, isLoading: isLoadingExisting } = usePricingRule(isSupersede ? id : undefined);
  const createRule = useCreatePricingRule();
  const supersedeRule = useSupersedePricingRule();

  const form = useForm<PricingRuleFormValues>({
    resolver: zodResolver(pricingRuleFormSchema),
    defaultValues: EMPTY_VALUES,
  });
  const { register, handleSubmit, reset, setError, watch } = form;
  const ruleType = watch("rule_type");

  useEffect(() => {
    if (isSupersede && existingRule) {
      reset(ruleToFormValues(existingRule));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupersede, existingRule?.id]);

  if (isSupersede && isLoadingExisting) {
    return <p className="text-sm text-gray-500">Loading...</p>;
  }

  // ADR-005 guard: this target is already a closed/superseded version
  // (effective_to is set), not the current one — creating a "new
  // version" FROM an old version makes no sense (the backend's own
  // supersede() would reject this as ALREADY_SUPERSEDED regardless),
  // so the form doesn't even render in that case. Reachable only by
  // hand-editing the URL to an old version's id; the detail page's own
  // "+ New Version" button always links to the CURRENT version's id.
  if (isSupersede && existingRule && existingRule.effective_to !== null) {
    return (
      <EmptyState
        title="This rule version has already been superseded"
        description="You can't create a new version from an old one. Go to the current version's history page and use its own '+ New Version' button."
        action={
          <Button
            onClick={() => navigate(`/pricing/${existingRule.rule_type}/${existingRule.vehicle_type}`)}
            className="bg-primary-500 hover:bg-primary-600"
          >
            Go to current version
          </Button>
        }
      />
    );
  }

  async function onSubmit(values: PricingRuleFormValues) {
    // Client-side backstop for the same-day-supersede case
    // minSupersedeDate's comment describes — belt-and-suspenders on
    // top of the input's own `min` attribute, since a min attribute
    // alone doesn't stop every path a value can reach the field.
    if (isSupersede && existingRule && values.effective_from <= existingRule.effective_from) {
      setError("effective_from", {
        message: `Must be after ${existingRule.effective_from} (the current version's own start date)`,
      });
      return;
    }
    try {
      if (isSupersede && id) {
        const { newRule } = await supersedeRule.mutateAsync({ id, values });
        toast.success("New version created");
        navigate(`/pricing/${newRule.rule_type}/${newRule.vehicle_type}`);
      } else {
        const rule = await createRule.mutateAsync(values);
        toast.success("Pricing rule created");
        navigate(`/pricing/${rule.rule_type}/${rule.vehicle_type}`);
      }
    } catch (err) {
      const apiErr = err instanceof AxiosError ? (err.response?.data as ApiErrorResponse | undefined)?.error : undefined;
      if (!apiErr) {
        toast.error("Cannot reach server. Try again.");
        return;
      }
      if (apiErr.code === "VALIDATION_ERROR") {
        const fields = (apiErr.details?.fields as { field: string; message: string }[]) || [];
        for (const f of fields) setError(f.field as Path<PricingRuleFormValues>, { message: f.message });
        toast.error("Please fix the highlighted fields");
      } else if (apiErr.code === "PRICING_RULE_OVERLAP") {
        setError("effective_from", { message: apiErr.message });
      } else if (apiErr.code === "ALREADY_SUPERSEDED") {
        toast.error(apiErr.message);
      } else if (/^\d{5}$/.test(apiErr.code)) {
        // A raw Postgres SQLSTATE leaking through as the error code
        // means an unmapped constraint violation on the backend (see
        // minSupersedeDate's comment) — the client-side guards above
        // should prevent this in practice, but if one somehow still
        // gets through, give a specific hint instead of a bare
        // "Internal server error".
        setError("effective_from", {
          message: "This date conflicts with the current version's date range. Try a later date.",
        });
      } else {
        toast.error(apiErr.message || "Something went wrong. Try again.");
      }
    }
  }

  const isSaving = createRule.isPending || supersedeRule.isPending;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={isSupersede ? "New Version" : "New Pricing Rule"}
        description={
          isSupersede
            ? `Supersedes the current ${existingRule ? RULE_TYPE_LABELS[existingRule.rule_type] : ""} / ${existingRule ? VEHICLE_TYPE_LABELS[existingRule.vehicle_type] : ""} rule`
            : "Define a base rate for a service type + vehicle combination"
        }
      />

      {isSupersede && (
        <div className="mb-6 rounded-md border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800">
          This creates a new version. Trips already invoiced use the old rates — nothing already
          charged changes retroactively.
        </div>
      )}

      <FormProvider {...form}>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="rule_type">Service Type</Label>
              <select
                id="rule_type"
                disabled={isSupersede}
                {...register("rule_type")}
                className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              >
                {RULE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {RULE_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="vehicle_type">Vehicle Type</Label>
              <select
                id="vehicle_type"
                disabled={isSupersede}
                {...register("vehicle_type")}
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
          {isSupersede && (
            <p className="-mt-2 text-xs text-gray-500">
              Service type and vehicle type are inherited from the current version and can't change.
            </p>
          )}

          <FormField name="label" label="Label">
            <Input id="label" placeholder="SEDAN Local 8H/80K" {...register("label")} />
          </FormField>

          <FormField name="effective_from" label="Effective From">
            <Input
              id="effective_from"
              type="date"
              min={isSupersede && existingRule ? minSupersedeDate(existingRule.effective_from) : undefined}
              {...register("effective_from")}
            />
          </FormField>

          {ruleType === "LOCAL_PACKAGE" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <FormField name="base_hours" label="Base Hours">
                  <Input id="base_hours" type="number" {...register("base_hours")} />
                </FormField>
                <FormField name="base_km" label="Base KM">
                  <Input id="base_km" type="number" {...register("base_km")} />
                </FormField>
              </div>
              <FormField name="base_price_rupees" label="Base Price (₹)">
                <Input id="base_price_rupees" type="number" step="0.01" {...register("base_price_rupees")} />
              </FormField>
              <div className="grid grid-cols-2 gap-3">
                <FormField name="extra_km_rate_rupees" label="Extra KM Rate (₹)">
                  <Input id="extra_km_rate_rupees" type="number" step="0.01" {...register("extra_km_rate_rupees")} />
                </FormField>
                <FormField name="extra_hr_rate_rupees" label="Extra Hour Rate (₹)">
                  <Input id="extra_hr_rate_rupees" type="number" step="0.01" {...register("extra_hr_rate_rupees")} />
                </FormField>
              </div>
            </>
          )}

          {ruleType === "OUTSTATION_SLAB" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <FormField name="slab_rate_rupees" label="Slab Rate (₹/km)">
                  <Input id="slab_rate_rupees" type="number" step="0.01" {...register("slab_rate_rupees")} />
                </FormField>
                <FormField name="min_km_per_day" label="Min KM/Day">
                  <Input id="min_km_per_day" type="number" {...register("min_km_per_day")} />
                </FormField>
              </div>
              <FormField name="driver_batta_per_day_rupees" label="Driver Batta/Day (₹)">
                <Input id="driver_batta_per_day_rupees" type="number" step="0.01" {...register("driver_batta_per_day_rupees")} />
              </FormField>
            </>
          )}

          {ruleType === "PERFORMANCE" && (
            <div className="grid grid-cols-2 gap-3">
              <FormField name="per_km_rate_rupees" label="Per-KM Rate (₹)">
                <Input id="per_km_rate_rupees" type="number" step="0.01" {...register("per_km_rate_rupees")} />
              </FormField>
              <FormField name="performance_batta_rupees" label="Batta (₹)">
                <Input id="performance_batta_rupees" type="number" step="0.01" {...register("performance_batta_rupees")} />
              </FormField>
            </div>
          )}

          <FormField name="notes" label="Notes (optional)">
            <textarea
              id="notes"
              rows={2}
              {...register("notes")}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </FormField>

          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => navigate(-1)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving} className="bg-primary-500 hover:bg-primary-600">
              {isSaving ? "Saving..." : isSupersede ? "Create New Version" : "Create Rule"}
            </Button>
          </div>
        </form>
      </FormProvider>
    </div>
  );
}
