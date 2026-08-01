import { zodResolver } from "@hookform/resolvers/zod";
import { AxiosError } from "axios";
import { useEffect } from "react";
import { FormProvider, useForm, type Path } from "react-hook-form";
import { toast } from "sonner";

import { FormField } from "@/components/FormField";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCreateVehicle, useUpdateVehicle, useVehicle } from "@/features/vehicles/vehicles.hooks";
import { FUEL_TYPES, VEHICLE_TYPE_LABELS, VEHICLE_TYPES } from "@/lib/constants/enums";
import { vehicleFormSchema, type VehicleFormValues } from "@/lib/schemas/vehicle";
import type { ApiErrorResponse } from "@/types/api";
import type { Vehicle } from "@/types/vehicle";

interface VehicleFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicleId?: string;
}

const EMPTY_VALUES: VehicleFormValues = {
  vehicle_number: "",
  vehicle_type: "SEDAN",
  make_model: "",
  registration_state: "",
  seating_capacity: "",
  fuel_type: "",
  year_of_manufacture: "",
  notes: "",
};

function vehicleToFormValues(vehicle: Vehicle): VehicleFormValues {
  return {
    vehicle_number: vehicle.vehicle_number_display || vehicle.vehicle_number,
    vehicle_type: vehicle.vehicle_type,
    make_model: vehicle.make_model ?? "",
    registration_state: vehicle.registration_state ?? "",
    seating_capacity: vehicle.seating_capacity != null ? String(vehicle.seating_capacity) : "",
    fuel_type: vehicle.fuel_type ?? "",
    year_of_manufacture: vehicle.year_of_manufacture != null ? String(vehicle.year_of_manufacture) : "",
    notes: vehicle.notes ?? "",
  };
}

export function VehicleFormModal({ open, onOpenChange, vehicleId }: VehicleFormModalProps) {
  const isEdit = Boolean(vehicleId);
  const { data: existingVehicle, isLoading: isLoadingVehicle } = useVehicle(isEdit ? vehicleId : undefined);
  const createVehicle = useCreateVehicle();
  const updateVehicle = useUpdateVehicle();

  const form = useForm<VehicleFormValues>({
    resolver: zodResolver(vehicleFormSchema),
    defaultValues: EMPTY_VALUES,
  });
  const { register, handleSubmit, reset, setError } = form;

  useEffect(() => {
    if (!open) return;
    if (isEdit && existingVehicle) {
      reset(vehicleToFormValues(existingVehicle));
    } else if (!isEdit) {
      reset(EMPTY_VALUES);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isEdit, existingVehicle?.id]);

  async function onSubmit(values: VehicleFormValues) {
    try {
      if (isEdit && vehicleId) {
        await updateVehicle.mutateAsync({ id: vehicleId, values });
        toast.success("Vehicle updated");
      } else {
        await createVehicle.mutateAsync(values);
        toast.success("Vehicle created");
      }
      onOpenChange(false);
    } catch (err) {
      const apiErr = err instanceof AxiosError ? (err.response?.data as ApiErrorResponse | undefined)?.error : undefined;
      if (!apiErr) {
        toast.error("Cannot reach server. Try again.");
        return;
      }
      if (apiErr.code === "VALIDATION_ERROR") {
        const fields = (apiErr.details?.fields as { field: string; message: string }[]) || [];
        for (const f of fields) setError(f.field as Path<VehicleFormValues>, { message: f.message });
        toast.error("Please fix the highlighted fields");
      } else if (apiErr.code === "VEHICLE_ALREADY_EXISTS" || apiErr.code === "VEHICLE_ARCHIVED_EXISTS") {
        setError("vehicle_number", { message: apiErr.message });
      } else {
        toast.error(apiErr.message || "Something went wrong. Try again.");
      }
    }
  }

  const isSaving = createVehicle.isPending || updateVehicle.isPending;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Edit ${existingVehicle?.vehicle_number_display || existingVehicle?.vehicle_number || "Vehicle"}` : "New Vehicle"}
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="vehicle-form"
            disabled={isSaving || (isEdit && isLoadingVehicle)}
            className="bg-primary-500 hover:bg-primary-600"
          >
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      }
    >
      {isEdit && isLoadingVehicle ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : (
        <FormProvider {...form}>
          <form id="vehicle-form" onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <FormField name="vehicle_number" label="Registration Number">
              <Input
                id="vehicle_number"
                disabled={isEdit}
                className="font-mono uppercase"
                placeholder="KA51AK1031"
                {...register("vehicle_number", {
                  onChange: (e) => {
                    e.target.value = e.target.value.toUpperCase();
                  },
                })}
              />
            </FormField>
            {isEdit && (
              <p className="-mt-2 text-xs text-gray-500">
                Registration number can't be changed after creation.
              </p>
            )}

            <FormField name="vehicle_type" label="Vehicle Type">
              <select
                id="vehicle_type"
                {...register("vehicle_type")}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {VEHICLE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {VEHICLE_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </FormField>

            <FormField name="make_model" label="Make / Model">
              <Input id="make_model" placeholder="Maruti Dzire" {...register("make_model")} />
            </FormField>

            <div className="grid grid-cols-2 gap-3">
              <FormField name="seating_capacity" label="Seating Capacity">
                <Input id="seating_capacity" type="number" min={1} max={60} {...register("seating_capacity")} />
              </FormField>
              <FormField name="fuel_type" label="Fuel Type">
                <select
                  id="fuel_type"
                  {...register("fuel_type")}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="">—</option>
                  {FUEL_TYPES.map((f) => (
                    <option key={f} value={f}>
                      {f.charAt(0) + f.slice(1).toLowerCase()}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField name="registration_state" label="Reg. State (optional)">
                <Input id="registration_state" maxLength={2} placeholder="KA" {...register("registration_state")} />
              </FormField>
              <FormField name="year_of_manufacture" label="Year">
                <Input id="year_of_manufacture" type="number" {...register("year_of_manufacture")} />
              </FormField>
            </div>

            <FormField name="notes" label="Notes (optional)">
              <textarea
                id="notes"
                rows={2}
                {...register("notes")}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </FormField>
          </form>
        </FormProvider>
      )}
    </Modal>
  );
}
