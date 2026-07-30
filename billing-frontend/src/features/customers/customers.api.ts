/**
 * Customer + customer-contact API layer. All responses parse through
 * Zod at the boundary (Rule 4) — features never see raw axios data.
 *
 * ─── Flagged spec deviations (Rule 10 — backend wins) ───
 * - There is no DELETE /customers/:id. Soft-delete is
 *   POST /customers/:id/archive (and POST /:id/unarchive to undo),
 *   returning the updated `{ customer }` (is_active: false), not a 204.
 *   deleteCustomer()/restoreCustomer() below wrap those two endpoints
 *   — the UI still presents this as "Delete" (matches the task's own
 *   UX ask), it's just reversible under the hood.
 * - There is NO PATCH /customers/:id/contacts/:contactId — contacts
 *   only support create (POST) and remove (DELETE), never in-place
 *   edit. There is deliberately no updateContact() here; the drawer
 *   only lets a user add a new contact or remove an existing one.
 * - List query param is `search`, not `q`; list response is
 *   `{ customers, pagination: { total, limit, offset } }`, not
 *   `{ items, total }`.
 */
import { apiClient } from "@/lib/api";
import {
  contactDetailResponseSchema,
  contactListResponseSchema,
  customerDetailResponseSchema,
  listCustomersResponseSchema,
  type ContactFormValues,
  type CustomerFormValues,
} from "@/lib/schemas/customer";
import type {
  Customer,
  CustomerContact,
  CustomerFilters,
  CustomerListResponse,
} from "@/types/customer";

// Joi's gstin/pan/state_code/name/company_name/phone/email/notes
// fields have no `.allow("")` — an empty string fails validation
// (e.g. "Invalid GSTIN format"), unlike the nested `address` fields
// which DO allow "". Strips empty-string values down to "not sent"
// (distinct from explicit null) so a blank B2C form doesn't try to
// send gstin: "".
function omitEmptyStrings<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === "" || value === undefined) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function toCreatePayload(values: CustomerFormValues) {
  const { address, ...rest } = values;
  const base = omitEmptyStrings(rest);
  if (base.gstin) base.gstin = (base.gstin as string).toUpperCase();
  if (base.pan) base.pan = (base.pan as string).toUpperCase();
  if (base.state_code) base.state_code = (base.state_code as string).toUpperCase();
  return { ...base, address };
}

// updateCustomerSchema has customer_type as Joi.any().forbidden() — it
// isn't just ignored if present, the whole request 400s
// (VALIDATION_ERROR: "customer_type is immutable..."). Every edit-mode
// save was silently failing this way until this was split out from
// toCreatePayload (caught only by actually driving the edit drawer in
// the browser, not by inspection — Rule 9).
function toUpdatePayload(values: CustomerFormValues) {
  const payload = toCreatePayload(values) as Record<string, unknown>;
  delete payload.customer_type;
  return payload;
}

export async function listCustomers(filters: CustomerFilters): Promise<CustomerListResponse> {
  const res = await apiClient.get("/customers", {
    params: {
      search: filters.search || undefined,
      customer_type: filters.customer_type || undefined,
      limit: filters.limit,
      offset: filters.offset,
    },
  });
  const parsed = listCustomersResponseSchema.parse(res.data);
  return parsed as CustomerListResponse;
}

export async function getCustomer(id: string, withContacts = false): Promise<Customer> {
  const res = await apiClient.get(`/customers/${id}`, {
    params: { withContacts },
  });
  return customerDetailResponseSchema.parse(res.data).customer as Customer;
}

export async function createCustomer(values: CustomerFormValues): Promise<Customer> {
  const res = await apiClient.post("/customers", toCreatePayload(values));
  return customerDetailResponseSchema.parse(res.data).customer as Customer;
}

export async function updateCustomer(id: string, values: CustomerFormValues): Promise<Customer> {
  const res = await apiClient.patch(`/customers/${id}`, toUpdatePayload(values));
  return customerDetailResponseSchema.parse(res.data).customer as Customer;
}

// See this file's top comment — wraps POST /:id/archive, not DELETE.
export async function deleteCustomer(id: string): Promise<Customer> {
  const res = await apiClient.post(`/customers/${id}/archive`);
  return customerDetailResponseSchema.parse(res.data).customer as Customer;
}

export async function restoreCustomer(id: string): Promise<Customer> {
  const res = await apiClient.post(`/customers/${id}/unarchive`);
  return customerDetailResponseSchema.parse(res.data).customer as Customer;
}

export async function listContacts(customerId: string): Promise<CustomerContact[]> {
  const res = await apiClient.get(`/customers/${customerId}/contacts`);
  return contactListResponseSchema.parse(res.data).contacts as CustomerContact[];
}

export async function createContact(
  customerId: string,
  values: ContactFormValues,
): Promise<CustomerContact> {
  const payload = omitEmptyStrings(values as unknown as Record<string, unknown>);
  const res = await apiClient.post(`/customers/${customerId}/contacts`, payload);
  return contactDetailResponseSchema.parse(res.data).contact as CustomerContact;
}

export async function deleteContact(customerId: string, contactId: string): Promise<void> {
  await apiClient.delete(`/customers/${customerId}/contacts/${contactId}`);
}
