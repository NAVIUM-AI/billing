import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import * as customersApi from "@/features/customers/customers.api";
import { queryKeys } from "@/lib/queryKeys";
import type {
  ContactFormValues,
  CustomerFormValues,
} from "@/lib/schemas/customer";
import type { Customer, CustomerFilters, CustomerListResponse } from "@/types/customer";

export function useCustomers(filters: CustomerFilters) {
  return useQuery({
    queryKey: queryKeys.customers.list(filters),
    queryFn: () => customersApi.listCustomers(filters),
    placeholderData: (previous) => previous,
  });
}

export function useCustomer(id: string | undefined, withContacts = true) {
  return useQuery({
    queryKey: queryKeys.customers.detail(id ?? ""),
    queryFn: () => customersApi.getCustomer(id as string, withContacts),
    enabled: Boolean(id),
  });
}

export function useCreateCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: CustomerFormValues) => customersApi.createCustomer(values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.lists() });
    },
  });
}

export function useUpdateCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: CustomerFormValues }) =>
      customersApi.updateCustomer(id, values),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.lists() });
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.detail(variables.id) });
    },
  });
}

// Optimistically removes the row from every cached list query
// (regardless of its filters) so the row disappears immediately, then
// reconciles with the server on settle. See customers.api.ts's top
// comment — this calls POST /:id/archive under the hood, not DELETE.
export function useDeleteCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => customersApi.deleteCustomer(id),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.customers.lists() });
      const previous = queryClient.getQueriesData<CustomerListResponse>({
        queryKey: queryKeys.customers.lists(),
      });
      queryClient.setQueriesData<CustomerListResponse>(
        { queryKey: queryKeys.customers.lists() },
        (old) => {
          if (!old) return old;
          return {
            customers: old.customers.filter((c) => c.id !== id),
            pagination: { ...old.pagination, total: Math.max(0, old.pagination.total - 1) },
          };
        },
      );
      return { previous };
    },
    onError: (_err, _id, context) => {
      context?.previous.forEach(([key, data]) => {
        queryClient.setQueryData(key, data);
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.lists() });
    },
  });
}

export function useContacts(customerId: string | undefined) {
  return useQuery({
    queryKey: [...queryKeys.customers.detail(customerId ?? ""), "contacts"] as const,
    queryFn: () => customersApi.listContacts(customerId as string),
    enabled: Boolean(customerId),
  });
}

export function useCreateContact(customerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: ContactFormValues) => customersApi.createContact(customerId, values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.detail(customerId) });
    },
  });
}

export function useDeleteContact(customerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (contactId: string) => customersApi.deleteContact(customerId, contactId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.detail(customerId) });
    },
  });
}

export type { Customer };
