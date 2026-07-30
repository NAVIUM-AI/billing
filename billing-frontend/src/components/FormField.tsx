import type { ReactNode } from "react";
import { useFormContext, type FieldErrors } from "react-hook-form";

import { Label } from "@/components/ui/label";

interface FormFieldProps {
  name: string;
  label: string;
  description?: string;
  children: ReactNode;
}

interface FieldErrorLike {
  message?: string;
}

// RHF nests errors along dotted paths (e.g. "address.pincode") as
// actual nested objects, not flat string keys — walk the path instead
// of a single `errors[name]` lookup.
function getNestedError(errors: FieldErrors, path: string): FieldErrorLike | undefined {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in acc) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, errors) as FieldErrorLike | undefined;
}

// Wraps any input with a label + RHF error message, reading error
// state from context rather than requiring each caller to thread
// `formState.errors` through manually:
//   <FormField name="email" label="Email">
//     <Input {...register("email")} />
//   </FormField>
export function FormField({ name, label, description, children }: FormFieldProps) {
  const { formState } = useFormContext();
  const error = getNestedError(formState.errors, name);

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      {children}
      {description && !error && <p className="text-xs text-gray-500">{description}</p>}
      {error?.message && <p className="text-xs text-destructive">{error.message}</p>}
    </div>
  );
}
