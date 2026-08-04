import type { InvoiceCustomerSnapshot, InvoiceTenantSnapshot } from "@/types/invoice";

// Matches `credit_notes` exactly (raw SELECT * — creditNote.repository.js
// never narrows columns). No `invoice_number`/`customer_name` columns —
// only `original_invoice_id`/`customer_id` (+ customer_snapshot, which
// DOES carry a display name). CreditNotesListScreen joins invoice
// numbers client-side against a fetched invoices map (Part A: GET
// /credit-notes has no server-side filters OR joins at all).
export interface CreditNote {
  id: string;
  tenant_id: string;
  credit_note_number: string;
  original_invoice_id: string;
  customer_id: string;
  customer_snapshot: InvoiceCustomerSnapshot;
  tenant_snapshot: InvoiceTenantSnapshot;
  subtotal_paise: number;
  total_gst_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  toll_paise: number;
  parking_paise: number;
  permit_paise: number;
  fasttag_paise: number;
  discount_paise: number;
  grand_total_paise: number;
  net_payable_paise: number;
  credit_note_date: string;
  reason: string;
  amount_in_words: string | null;
  pdf_url: string | null;
  pdf_generated_at: string | null;
  pdf_template_version: string | null;
  issued_by: string | null;
  created_at: string;
}

export interface CreditNoteListResponse {
  credit_notes: CreditNote[];
  pagination: { total: number; limit: number; offset: number; has_more: boolean };
}
