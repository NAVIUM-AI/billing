/**
 * Credit notes API layer. GET /credit-notes has NO server-side filters
 * (creditNote.repository.js#list takes only limit/offset — Part A
 * confirmed) — search/date/customer filtering in CreditNotesListScreen
 * all happens client-side over one fetched page, same adaptation as
 * PaymentsListScreen's reference search.
 */
import { apiClient } from "@/lib/api";
import { creditNoteDetailResponseSchema, creditNoteListResponseSchema } from "@/lib/schemas/creditNote";
import type { CreditNote, CreditNoteListResponse } from "@/types/creditNote";

export async function listCreditNotes(limit = 100): Promise<CreditNoteListResponse> {
  const res = await apiClient.get("/credit-notes", { params: { limit, offset: 0 } });
  return creditNoteListResponseSchema.parse(res.data) as unknown as CreditNoteListResponse;
}

export async function getCreditNote(id: string): Promise<CreditNote> {
  const res = await apiClient.get(`/credit-notes/${id}`);
  return creditNoteDetailResponseSchema.parse(res.data).credit_note as unknown as CreditNote;
}

export async function generateCreditNotePdf(id: string): Promise<{ pdf_url: string }> {
  const res = await apiClient.post(`/credit-notes/${id}/pdf`);
  return res.data;
}

export async function downloadCreditNotePdf(id: string): Promise<{ blob: Blob; filename: string }> {
  const res = await apiClient.get(`/credit-notes/${id}/pdf`, { responseType: "blob" });
  const disposition = (res.headers["content-disposition"] as string | undefined) || "";
  const match = /filename="?([^"]+)"?/.exec(disposition);
  return { blob: res.data as Blob, filename: match?.[1] || `credit-note-${id}.pdf` };
}
