import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { Trash2 } from "lucide-react";
import { useEffect } from "react";
import { FormProvider, useFieldArray, useForm, type Path } from "react-hook-form";
import { toast } from "sonner";

import { Drawer } from "@/components/Drawer";
import { FormField } from "@/components/FormField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import * as customersApi from "@/features/customers/customers.api";
import {
  useContacts,
  useCreateCustomer,
  useCustomer,
  useDeleteContact,
  useUpdateCustomer,
} from "@/features/customers/customers.hooks";
import { CUSTOMER_ERROR_CODES } from "@/features/customers/customerErrorCodes";
import { queryKeys } from "@/lib/queryKeys";
import { STATE_OPTIONS } from "@/lib/constants/gstStateCodes";
import {
  customerFormSchema,
  type ContactFormValues,
  type CustomerFormValues,
} from "@/lib/schemas/customer";
import { cn } from "@/lib/utils";
import type { ApiErrorResponse } from "@/types/api";
import type { Customer } from "@/types/customer";

interface CustomerFormDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // undefined => create mode. Fetched internally (not passed as a full
  // Customer object) so edit mode always gets a fresh row + contacts
  // via GET /:id?withContacts=true — the list row itself never carries
  // contacts (only the detail endpoint does).
  customerId?: string;
}

const EMPTY_VALUES: CustomerFormValues = {
  customer_type: "B2C",
  name: "",
  company_name: "",
  gstin: "",
  pan: "",
  state_code: "",
  phone: "",
  email: "",
  address: { line1: "", line2: "", city: "", district: "", state: "", pincode: "", country: "India" },
  credit_days: 0,
  notes: "",
};

function customerToFormValues(customer: Customer): CustomerFormValues {
  return {
    customer_type: customer.customer_type,
    name: customer.name ?? "",
    company_name: customer.company_name ?? "",
    gstin: customer.gstin ?? "",
    pan: customer.pan ?? "",
    state_code: customer.state_code ?? "",
    // phone_display preserves what was actually typed (e.g. with a
    // leading 0 or spacing); `phone` is the canonical, normalized form
    // — the display value is the one worth editing.
    phone: customer.phone_display ?? customer.phone ?? "",
    email: customer.email ?? "",
    address: {
      line1: customer.address?.line1 ?? "",
      line2: customer.address?.line2 ?? "",
      city: customer.address?.city ?? "",
      district: customer.address?.district ?? "",
      state: customer.address?.state ?? "",
      pincode: customer.address?.pincode ?? "",
      country: customer.address?.country ?? "India",
    },
    credit_days: customer.credit_days,
    notes: customer.notes ?? "",
  };
}

function extractApiError(err: unknown) {
  if (err instanceof AxiosError) {
    return (err.response?.data as ApiErrorResponse | undefined)?.error;
  }
  return undefined;
}

export function CustomerFormDrawer({ open, onOpenChange, customerId }: CustomerFormDrawerProps) {
  const isEdit = Boolean(customerId);
  const { data: existingCustomer, isLoading: isLoadingCustomer } = useCustomer(customerId, true);
  const createCustomer = useCreateCustomer();
  const updateCustomer = useUpdateCustomer();

  const form = useForm<CustomerFormValues>({
    resolver: zodResolver(customerFormSchema),
    defaultValues: EMPTY_VALUES,
  });
  const { register, handleSubmit, watch, reset, setError, setValue, formState } = form;
  const customerType = watch("customer_type");

  // (Re)hydrate the form whenever the drawer opens or the fetched
  // customer changes — NOT on every render, so in-progress edits
  // aren't clobbered by a background refetch while the drawer is open.
  useEffect(() => {
    if (!open) return;
    if (isEdit && existingCustomer) {
      reset(customerToFormValues(existingCustomer));
    } else if (!isEdit) {
      reset(EMPTY_VALUES);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isEdit, existingCustomer?.id]);

  // ─── Contacts (B2B only) ───
  // Existing, already-persisted contacts (fetched fresh via
  // useContacts) are shown read-only + a remove button that calls
  // DELETE immediately — there is no PATCH /contacts/:id on the
  // backend, so in-place editing of a saved contact isn't possible.
  // New contacts are collected in this field array and POSTed one by
  // one after the customer itself saves successfully ("on-save flush",
  // per spec).
  const queryClient = useQueryClient();
  const { data: existingContacts } = useContacts(isEdit ? customerId : undefined);
  const deleteContact = useDeleteContact(customerId ?? "");

  const contactForm = useForm<{ drafts: ContactFormValues[] }>({
    defaultValues: { drafts: [] },
  });
  const { fields: draftContacts, append: appendDraftContact, remove: removeDraftContact } = useFieldArray({
    control: contactForm.control,
    name: "drafts",
  });

  useEffect(() => {
    if (!open) contactForm.reset({ drafts: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function applyServerFieldErrors(fields: { field: string; message: string }[]) {
    for (const f of fields) {
      // Backend field names (dot-joined, e.g. "address.pincode") match
      // this form's own field paths 1:1 — a dynamic string from the
      // wire can't be statically checked against RHF's typed Path<T>,
      // hence the cast (a boundary case, not a general escape hatch).
      setError(f.field as Path<CustomerFormValues>, { message: f.message });
    }
  }

  async function onSubmit(values: CustomerFormValues) {
    try {
      let savedCustomer: Customer;
      if (isEdit && customerId) {
        savedCustomer = await updateCustomer.mutateAsync({ id: customerId, values });
      } else {
        savedCustomer = await createCustomer.mutateAsync(values);
      }

      // Flush any newly drafted contacts now that we have a real
      // customer id — savedCustomer.id, NOT the customerId PROP: in
      // create mode that prop is undefined for this whole call (it
      // only changes on the NEXT render, after the id exists), so
      // closing over it here would silently POST to a contacts
      // sub-resource of "undefined". Best-effort in parallel — one bad
      // contact shouldn't block the others; failures are toasted.
      const drafts = contactForm.getValues("drafts").filter((d) => d.name?.trim());
      if (drafts.length > 0) {
        const results = await Promise.allSettled(
          drafts.map((d) => customersApi.createContact(savedCustomer.id, d)),
        );
        const failures = results.filter((r) => r.status === "rejected").length;
        if (failures > 0) {
          toast.error(
            `Customer saved, but ${failures} contact${failures > 1 ? "s" : ""} failed to save.`,
          );
        }
        queryClient.invalidateQueries({ queryKey: queryKeys.customers.detail(savedCustomer.id) });
      }

      toast.success(isEdit ? "Customer updated" : "Customer created");
      onOpenChange(false);
    } catch (err) {
      const apiErr = extractApiError(err);
      if (!apiErr) {
        toast.error("Cannot reach server. Try again.");
        return;
      }
      switch (apiErr.code) {
        case CUSTOMER_ERROR_CODES.VALIDATION_ERROR: {
          const fields = (apiErr.details?.fields as { field: string; message: string }[]) || [];
          applyServerFieldErrors(fields);
          toast.error("Please fix the highlighted fields");
          break;
        }
        case CUSTOMER_ERROR_CODES.GSTIN_STATE_MISMATCH: {
          const gstinState = apiErr.details?.gstin_state as string | undefined;
          setError("state_code", {
            message: gstinState
              ? `GSTIN belongs to a different state (expected ${gstinState})`
              : "GSTIN does not match the selected state",
          });
          break;
        }
        case CUSTOMER_ERROR_CODES.CUSTOMER_GSTIN_ALREADY_EXISTS:
          setError("gstin", { message: "A customer with this GSTIN already exists" });
          break;
        case CUSTOMER_ERROR_CODES.CUSTOMER_PHONE_ALREADY_EXISTS:
          setError("phone", { message: "A customer with this phone already exists" });
          break;
        case CUSTOMER_ERROR_CODES.CUSTOMER_ARCHIVED_EXISTS:
          toast.error(`${apiErr.message} You can restore it from the deleted customers list.`);
          break;
        case CUSTOMER_ERROR_CODES.B2B_REQUIRED_FIELDS:
          toast.error(apiErr.message);
          break;
        default:
          toast.error("Something went wrong. Try again.");
      }
    }
  }

  const isSaving = createCustomer.isPending || updateCustomer.isPending || formState.isSubmitting;

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Edit ${existingCustomer?.company_name || existingCustomer?.name || "Customer"}` : "New Customer"}
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="customer-form"
            disabled={isSaving || (isEdit && isLoadingCustomer)}
            className="bg-primary-500 hover:bg-primary-600"
          >
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      }
    >
      {isEdit && isLoadingCustomer ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : (
        <FormProvider {...form}>
          <form id="customer-form" onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <div>
              <Label>Customer Type</Label>
              <div className="mt-1.5 flex gap-2">
                {(["B2B", "B2C"] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    disabled={isEdit}
                    onClick={() => setValue("customer_type", type, { shouldValidate: true })}
                    className={cn(
                      "rounded-full border px-4 py-1 text-sm font-medium transition-colors",
                      customerType === type
                        ? "border-primary-500 bg-primary-50 text-primary-700"
                        : "border-gray-300 text-gray-600 hover:bg-gray-50",
                      isEdit && "cursor-not-allowed opacity-60",
                    )}
                  >
                    {type}
                  </button>
                ))}
              </div>
              {isEdit && (
                <p className="mt-1 text-xs text-gray-500">Customer type can't be changed after creation.</p>
              )}
            </div>

            {customerType === "B2B" && (
              <FormField name="company_name" label="Company Name">
                <Input id="company_name" {...register("company_name")} />
              </FormField>
            )}

            <FormField name="name" label={customerType === "B2B" ? "Billing Contact Name" : "Full Name"}>
              <Input id="name" {...register("name")} />
            </FormField>

            {customerType === "B2B" && (
              <div className="grid grid-cols-2 gap-3">
                <FormField name="gstin" label="GSTIN">
                  <Input
                    id="gstin"
                    className="font-mono uppercase"
                    {...register("gstin", {
                      onChange: (e) => {
                        e.target.value = e.target.value.toUpperCase();
                      },
                    })}
                  />
                </FormField>
                <FormField name="state_code" label="State">
                  <select
                    id="state_code"
                    {...register("state_code")}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">Select state</option>
                    {STATE_OPTIONS.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </FormField>
              </div>
            )}

            {customerType === "B2B" && (
              <FormField name="pan" label="PAN (optional)">
                <Input
                  id="pan"
                  className="font-mono uppercase"
                  {...register("pan", {
                    onChange: (e) => {
                      e.target.value = e.target.value.toUpperCase();
                    },
                  })}
                />
              </FormField>
            )}

            <FormField name="address.line1" label="Address">
              <textarea
                id="address.line1"
                rows={2}
                {...register("address.line1")}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </FormField>

            <div className="grid grid-cols-2 gap-3">
              <FormField name="address.city" label="City">
                <Input id="address.city" {...register("address.city")} />
              </FormField>
              <FormField name="address.pincode" label="Pincode">
                <Input id="address.pincode" {...register("address.pincode")} />
              </FormField>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField name="phone" label="Phone">
                <Input id="phone" {...register("phone")} />
              </FormField>
              <FormField name="email" label="Email">
                <Input id="email" type="email" {...register("email")} />
              </FormField>
            </div>

            {customerType === "B2B" && (
              <FormField name="credit_days" label="Credit Days">
                <Input id="credit_days" type="number" min={0} max={365} {...register("credit_days")} />
              </FormField>
            )}

            <FormField name="notes" label="Notes (optional)">
              <textarea
                id="notes"
                rows={2}
                {...register("notes")}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </FormField>

            {customerType === "B2B" && (
              <div className="border-t pt-4">
                <Label>Contacts</Label>
                <div className="mt-2 flex flex-col gap-2">
                  {existingContacts?.map((contact) => (
                    <div
                      key={contact.id}
                      className="flex items-center justify-between gap-2 rounded-md border bg-gray-50 px-3 py-2 text-sm"
                    >
                      <div className="flex-1">
                        <span className="font-medium">{contact.name}</span>
                        {contact.is_primary && (
                          <span className="ml-2 rounded bg-primary-100 px-1.5 py-0.5 text-xs text-primary-700">
                            Primary
                          </span>
                        )}
                        <div className="text-xs text-gray-500">
                          {[contact.phone_display, contact.email].filter(Boolean).join(" · ") || "—"}
                        </div>
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${contact.name}`}
                        onClick={() => deleteContact.mutate(contact.id)}
                        className="text-gray-400 hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}

                  {draftContacts.map((draft, index) => (
                    <div key={draft.id} className="flex items-end gap-2 rounded-md border border-dashed p-2">
                      <div className="flex-1">
                        <Input
                          placeholder="Name"
                          {...contactForm.register(`drafts.${index}.name` as const)}
                        />
                      </div>
                      <div className="flex-1">
                        <Input
                          placeholder="Phone"
                          {...contactForm.register(`drafts.${index}.phone` as const)}
                        />
                      </div>
                      <div className="flex-1">
                        <Input
                          placeholder="Email"
                          {...contactForm.register(`drafts.${index}.email` as const)}
                        />
                      </div>
                      <button
                        type="button"
                        aria-label="Remove draft contact"
                        onClick={() => removeDraftContact(index)}
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
                    appendDraftContact({ name: "", role: "", phone: "", email: "", is_primary: false })
                  }
                  className="mt-2 text-sm font-medium text-primary-600 hover:text-primary-700"
                >
                  + Add Contact
                </button>
              </div>
            )}

            {formState.errors.root && (
              <p className="text-xs text-destructive">{formState.errors.root.message}</p>
            )}
          </form>
        </FormProvider>
      )}
    </Drawer>
  );
}
