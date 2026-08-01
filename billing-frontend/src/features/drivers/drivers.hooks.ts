import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import * as driversApi from "@/features/drivers/drivers.api";
import { queryKeys } from "@/lib/queryKeys";
import type { DriverFormValues } from "@/lib/schemas/driver";
import type { DriverFilters, DriverListResponse } from "@/types/driver";

export function useDrivers(filters: DriverFilters) {
  return useQuery({
    queryKey: queryKeys.drivers.list(filters),
    queryFn: () => driversApi.listDrivers(filters),
    placeholderData: (previous) => previous,
  });
}

export function useDriver(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.drivers.detail(id ?? ""),
    queryFn: () => driversApi.getDriver(id as string),
    enabled: Boolean(id),
  });
}

export function useCreateDriver() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: DriverFormValues) => driversApi.createDriver(values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.drivers.lists() });
    },
  });
}

export function useUpdateDriver() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: DriverFormValues }) => driversApi.updateDriver(id, values),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.drivers.lists() });
      queryClient.invalidateQueries({ queryKey: queryKeys.drivers.detail(variables.id) });
    },
  });
}

export function useArchiveDriver() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => driversApi.archiveDriver(id),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.drivers.lists() });
      const previous = queryClient.getQueriesData<DriverListResponse>({ queryKey: queryKeys.drivers.lists() });
      queryClient.setQueriesData<DriverListResponse>({ queryKey: queryKeys.drivers.lists() }, (old) => {
        if (!old) return old;
        return {
          drivers: old.drivers.map((d) => (d.id === id ? { ...d, is_active: false } : d)),
          pagination: old.pagination,
        };
      });
      return { previous };
    },
    onError: (_err, _id, context) => {
      context?.previous.forEach(([key, data]) => queryClient.setQueryData(key, data));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.drivers.lists() });
    },
  });
}

export function useUnarchiveDriver() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => driversApi.unarchiveDriver(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.drivers.lists() });
    },
  });
}
