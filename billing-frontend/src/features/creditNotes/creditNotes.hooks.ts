import { useMutation, useQuery } from "@tanstack/react-query";

import * as creditNotesApi from "@/features/creditNotes/creditNotes.api";
import { queryKeys } from "@/lib/queryKeys";

export function useCreditNotes(limit = 100) {
  return useQuery({
    queryKey: queryKeys.creditNotes.list(limit),
    queryFn: () => creditNotesApi.listCreditNotes(limit),
  });
}

export function useCreditNoteDetail(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.creditNotes.detail(id ?? ""),
    queryFn: () => creditNotesApi.getCreditNote(id as string),
    enabled: Boolean(id),
  });
}

export function useGenerateCreditNotePdf() {
  return useMutation({
    mutationFn: (id: string) => creditNotesApi.generateCreditNotePdf(id),
  });
}

export function useDownloadCreditNotePdf() {
  return useMutation({
    mutationFn: (id: string) => creditNotesApi.downloadCreditNotePdf(id),
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
