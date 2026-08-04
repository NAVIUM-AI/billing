import { useMutation, useQuery } from "@tanstack/react-query";

import * as reportsApi from "@/features/reports/reports.api";
import { queryKeys } from "@/lib/queryKeys";

export function useReceivablesAging(asOfDate?: string) {
  return useQuery({
    queryKey: queryKeys.aging.report(asOfDate),
    queryFn: () => reportsApi.getReceivablesAging(asOfDate),
  });
}

// Imperative (button click), not a query — CSV export is an action.
export function useExportAgingCsv() {
  return useMutation({
    mutationFn: async (rows: Parameters<typeof reportsApi.agingRowsToCsv>[0]) => reportsApi.agingRowsToCsv(rows),
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
