import { zodResolver } from "@hookform/resolvers/zod";
import { AxiosError } from "axios";
import { useEffect } from "react";
import { FormProvider, useForm, type Path } from "react-hook-form";
import { toast } from "sonner";

import { FormField } from "@/components/FormField";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCreateDriver, useDriver, useUpdateDriver } from "@/features/drivers/drivers.hooks";
import { driverFormSchema, type DriverFormValues } from "@/lib/schemas/driver";
import type { ApiErrorResponse } from "@/types/api";
import type { Driver } from "@/types/driver";

interface DriverFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  driverId?: string;
}

const EMPTY_VALUES: DriverFormValues = {
  full_name: "",
  phone: "",
  license_number: "",
  license_expiry_date: "",
  address_line: "",
  emergency_contact: "",
  notes: "",
};

function driverToFormValues(driver: Driver): DriverFormValues {
  return {
    full_name: driver.full_name,
    phone: driver.phone_display ?? driver.phone ?? "",
    license_number: driver.license_number ?? "",
    license_expiry_date: driver.license_expiry_date ?? "",
    address_line: driver.address_line ?? "",
    emergency_contact: driver.emergency_contact ?? "",
    notes: driver.notes ?? "",
  };
}

export function DriverFormModal({ open, onOpenChange, driverId }: DriverFormModalProps) {
  const isEdit = Boolean(driverId);
  const { data: existingDriver, isLoading: isLoadingDriver } = useDriver(isEdit ? driverId : undefined);
  const createDriver = useCreateDriver();
  const updateDriver = useUpdateDriver();

  const form = useForm<DriverFormValues>({
    resolver: zodResolver(driverFormSchema),
    defaultValues: EMPTY_VALUES,
  });
  const { register, handleSubmit, reset, setError } = form;

  useEffect(() => {
    if (!open) return;
    if (isEdit && existingDriver) {
      reset(driverToFormValues(existingDriver));
    } else if (!isEdit) {
      reset(EMPTY_VALUES);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isEdit, existingDriver?.id]);

  async function onSubmit(values: DriverFormValues) {
    try {
      if (isEdit && driverId) {
        await updateDriver.mutateAsync({ id: driverId, values });
        toast.success("Driver updated");
      } else {
        await createDriver.mutateAsync(values);
        toast.success("Driver created");
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
        for (const f of fields) setError(f.field as Path<DriverFormValues>, { message: f.message });
        toast.error("Please fix the highlighted fields");
      } else if (apiErr.code === "DRIVER_PHONE_ALREADY_EXISTS") {
        setError("phone", { message: apiErr.message });
      } else if (apiErr.code === "DRIVER_LICENSE_ALREADY_EXISTS") {
        setError("license_number", { message: apiErr.message });
      } else {
        toast.error(apiErr.message || "Something went wrong. Try again.");
      }
    }
  }

  const isSaving = createDriver.isPending || updateDriver.isPending;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Edit ${existingDriver?.full_name || "Driver"}` : "New Driver"}
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="driver-form"
            disabled={isSaving || (isEdit && isLoadingDriver)}
            className="bg-primary-500 hover:bg-primary-600"
          >
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      }
    >
      {isEdit && isLoadingDriver ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : (
        <FormProvider {...form}>
          <form id="driver-form" onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <FormField name="full_name" label="Full Name">
              <Input id="full_name" {...register("full_name")} />
            </FormField>

            <div className="grid grid-cols-2 gap-3">
              <FormField name="phone" label="Phone">
                <Input id="phone" {...register("phone")} />
              </FormField>
              <FormField name="emergency_contact" label="Emergency Contact">
                <Input id="emergency_contact" {...register("emergency_contact")} />
              </FormField>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField name="license_number" label="License Number">
                <Input id="license_number" className="uppercase" {...register("license_number")} />
              </FormField>
              <FormField name="license_expiry_date" label="License Expiry">
                <Input id="license_expiry_date" type="date" {...register("license_expiry_date")} />
              </FormField>
            </div>

            <FormField name="address_line" label="Address (optional)">
              <textarea
                id="address_line"
                rows={2}
                {...register("address_line")}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </FormField>

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
