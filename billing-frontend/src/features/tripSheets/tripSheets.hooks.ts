import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import * as tripSheetsApi from "@/features/tripSheets/tripSheets.api";
import { queryKeys } from "@/lib/queryKeys";
import type { TripSheetFormValues } from "@/lib/schemas/tripSheet";
import type { TripSheetFilters } from "@/types/tripSheet";

export function useTripSheets(filters: TripSheetFilters) {
  return useQuery({
    queryKey: queryKeys.tripSheets.list(filters),
    queryFn: () => tripSheetsApi.listTripSheets(filters),
    placeholderData: (previous) => previous,
  });
}

export function useTripSheet(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.tripSheets.detail(id ?? ""),
    queryFn: () => tripSheetsApi.getTripSheet(id as string),
    enabled: Boolean(id),
  });
}

export function useCreateTripSheet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: TripSheetFormValues) => tripSheetsApi.createTripSheet(values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tripSheets.lists() });
    },
  });
}

export function useUpdateTripSheet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: TripSheetFormValues }) =>
      tripSheetsApi.updateTripSheet(id, values),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tripSheets.lists() });
      queryClient.invalidateQueries({ queryKey: queryKeys.tripSheets.detail(variables.id) });
    },
  });
}

export function useFinalizeTripSheet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => tripSheetsApi.finalizeTripSheet(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tripSheets.lists() });
      queryClient.invalidateQueries({ queryKey: queryKeys.tripSheets.detail(id) });
    },
  });
}

export function useCancelTripSheet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => tripSheetsApi.cancelTripSheet(id, reason),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tripSheets.lists() });
      queryClient.invalidateQueries({ queryKey: queryKeys.tripSheets.detail(variables.id) });
    },
  });
}

// Composed action behind the detail page's single "Download PDF"
// button — generate (or regenerate, idempotent) then immediately
// download, so the UI never exposes the two-endpoint nature
// underneath. Mirrors invoices.hooks.ts's useIssueAndGeneratePdf +
// useDownloadInvoicePdf pairing, collapsed into one hook since a trip
// sheet PDF has no separate "issue" step to compose against.
export function useDownloadTripSheetPdf() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await tripSheetsApi.generateTripSheetPdf(id);
      return tripSheetsApi.downloadTripSheetPdf(id);
    },
    onSuccess: ({ blob, filename }, id) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      queryClient.invalidateQueries({ queryKey: queryKeys.tripSheets.detail(id) });
    },
  });
}

// Imperative (called from a button click), not a query — CSV export is
// an action, not data the UI renders directly.
export function useExportTripSheetsCsv() {
  return useMutation({
    mutationFn: (filters: TripSheetFilters) => tripSheetsApi.exportTripSheetsCsv(filters),
    onSuccess: ({ blob, filename }) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
  });
}
