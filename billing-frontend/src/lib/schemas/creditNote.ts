import { z } from "zod";

const snapshotSchema = z.record(z.string(), z.unknown());

const creditNoteResponseSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  credit_note_number: z.string(),
  original_invoice_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  customer_snapshot: snapshotSchema,
  tenant_snapshot: snapshotSchema,
  subtotal_paise: z.number(),
  total_gst_paise: z.number(),
  cgst_paise: z.number(),
  sgst_paise: z.number(),
  igst_paise: z.number(),
  toll_paise: z.number(),
  parking_paise: z.number(),
  permit_paise: z.number(),
  fasttag_paise: z.number(),
  discount_paise: z.number(),
  grand_total_paise: z.number(),
  net_payable_paise: z.number(),
  credit_note_date: z.string(),
  reason: z.string(),
  amount_in_words: z.string().nullable(),
  pdf_url: z.string().nullable(),
  pdf_generated_at: z.string().nullable(),
  pdf_template_version: z.string().nullable(),
  issued_by: z.string().nullable(),
  created_at: z.string(),
});

export const creditNoteListResponseSchema = z.object({
  credit_notes: z.array(creditNoteResponseSchema),
  pagination: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    has_more: z.boolean(),
  }),
});

export const creditNoteDetailResponseSchema = z.object({ credit_note: creditNoteResponseSchema });
