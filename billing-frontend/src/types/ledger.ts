import type { PaymentMode } from "@/types/payment";
import type { InvoiceStatus } from "@/types/invoice";

// Mirrors payment.service.js#getCustomerLedger's merged entry shapes
// EXACTLY — there are only TWO entry types on the wire (INVOICE,
// PAYMENT), not the 4-type union (invoice/payment/credit-note/advance)
// an earlier draft of this task assumed. A credit note never appears
// as its own ledger row (the cancelled invoice's own INVOICE entry
// just drops to debit_paise: 0); an advance is a PAYMENT entry whose
// invoice_id is null — distinguish it in the UI via that field, not a
// separate discriminator value.
export interface InvoiceLedgerEntry {
  type: "INVOICE";
  invoice_id: string;
  invoice_number: string | null;
  invoice_date: string;
  due_date: string;
  debit_paise: number;
  status: InvoiceStatus;
  running_balance_paise: number;
}

export interface PaymentLedgerEntry {
  type: "PAYMENT";
  payment_id: string;
  invoice_id: string | null;
  received_at: string;
  credit_paise: number;
  payment_mode: PaymentMode;
  reference_number: string | null;
  running_balance_paise: number;
}

export type LedgerEntry = InvoiceLedgerEntry | PaymentLedgerEntry;

export interface LedgerResponse {
  customer: {
    id: string;
    customer_type: "B2B" | "B2C";
    name: string | null;
    company_name: string | null;
    gstin: string | null;
    state_code: string | null;
    credit_days: number;
  };
  summary: {
    total_invoiced_paise: number;
    total_paid_paise: number;
    total_cancelled_paise: number;
    unallocated_advance_paise: number;
    outstanding_paise: number;
  };
  entries: LedgerEntry[];
}
