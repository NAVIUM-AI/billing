import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import * as vehiclesApi from "@/features/vehicles/vehicles.api";
import { queryKeys } from "@/lib/queryKeys";
import type { VehicleFormValues } from "@/lib/schemas/vehicle";
import type { VehicleFilters, VehicleListResponse } from "@/types/vehicle";

export function useVehicles(filters: VehicleFilters) {
  return useQuery({
    queryKey: queryKeys.vehicles.list(filters),
    queryFn: () => vehiclesApi.listVehicles(filters),
    placeholderData: (previous) => previous,
  });
}

export function useVehicle(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.vehicles.detail(id ?? ""),
    queryFn: () => vehiclesApi.getVehicle(id as string),
    enabled: Boolean(id),
  });
}

export function useCreateVehicle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: VehicleFormValues) => vehiclesApi.createVehicle(values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.vehicles.lists() });
    },
  });
}

export function useUpdateVehicle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: VehicleFormValues }) =>
      vehiclesApi.updateVehicle(id, values),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.vehicles.lists() });
      queryClient.invalidateQueries({ queryKey: queryKeys.vehicles.detail(variables.id) });
    },
  });
}

export function useArchiveVehicle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => vehiclesApi.archiveVehicle(id),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.vehicles.lists() });
      const previous = queryClient.getQueriesData<VehicleListResponse>({
        queryKey: queryKeys.vehicles.lists(),
      });
      queryClient.setQueriesData<VehicleListResponse>({ queryKey: queryKeys.vehicles.lists() }, (old) => {
        if (!old) return old;
        return {
          vehicles: old.vehicles.map((v) => (v.id === id ? { ...v, is_active: false } : v)),
          pagination: old.pagination,
        };
      });
      return { previous };
    },
    onError: (_err, _id, context) => {
      context?.previous.forEach(([key, data]) => queryClient.setQueryData(key, data));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.vehicles.lists() });
    },
  });
}

export function useUnarchiveVehicle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => vehiclesApi.unarchiveVehicle(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.vehicles.lists() });
    },
  });
}
