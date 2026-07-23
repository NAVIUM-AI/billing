# Entity relationship diagram

_Last updated: 2026-07-23. Reviewers: TBD._

Scoped to Module 4's own tables (`invoices`, `invoice_lines`, `invoice_number_sequences`, `credit_notes`, `credit_note_number_sequences`, `payments`) plus their foreign keys into Modules 1-3, shown for context. For the full Module 1/2 and Module 3 ER diagrams, see `docs/modules/module-2-master-data/diagrams/er-diagram.md` and `docs/modules/module-3-trip-sheets/diagrams/er-diagram.md`.

```mermaid
erDiagram
    TENANTS ||--o{ INVOICES : owns
    TENANTS ||--o{ INVOICE_NUMBER_SEQUENCES : owns
    TENANTS ||--o{ CREDIT_NOTES : owns
    TENANTS ||--o{ CREDIT_NOTE_NUMBER_SEQUENCES : owns
    TENANTS ||--o{ PAYMENTS : owns
    CUSTOMERS ||--o{ INVOICES : "billed to"
    CUSTOMERS ||--o{ CREDIT_NOTES : "issued to"
    CUSTOMERS ||--o{ PAYMENTS : "paid by"
    USERS ||--o{ INVOICES : "created_by / issued_by / cancelled_by"
    USERS ||--o{ CREDIT_NOTES : issued_by
    USERS ||--o{ PAYMENTS : "recorded_by / cancelled_by"
    INVOICES ||--o{ INVOICE_LINES : "has lines"
    INVOICES ||--o{ PAYMENTS : "receives"
    INVOICES ||--o| CREDIT_NOTES : "reversed by"
    TRIP_SHEETS ||--o{ INVOICE_LINES : "billed via"
    TRIP_SHEETS }o--o| INVOICES : "held by (DRAFT only)"
    PAYMENTS ||--o{ PAYMENTS : "parent_payment_id (split / partial advance)"

    TENANTS {
        uuid id PK
        smallint gst_rate "0-28, default 5"
        varchar invoice_prefix "TAX invoice number prefix"
        varchar performance_prefix "PERFORMANCE invoice number prefix"
        varchar credit_note_prefix "auto-derived at signup"
    }

    INVOICES {
        uuid id PK
        uuid tenant_id FK
        varchar invoice_number "NULL until issued; unique per tenant"
        enum invoice_type "TAX or PERFORMANCE"
        enum status "DRAFT / ISSUED / PAID / CANCELLED"
        uuid customer_id FK
        date invoice_date
        date due_date
        bigint subtotal_paise
        bigint cgst_paise
        bigint sgst_paise
        bigint igst_paise
        bigint toll_paise "reimbursement, post-GST"
        bigint net_payable_paise
        jsonb tenant_snapshot "NULL until issue, then immutable"
        jsonb customer_snapshot "NULL until issue, then immutable"
        varchar pdf_url
        varchar pdf_template_version
        uuid credit_note_id "set on ISSUED/PAID cancel"
    }

    INVOICE_LINES {
        uuid id PK
        uuid invoice_id FK
        uuid trip_sheet_id FK
        smallint line_number "unique per invoice_id"
        enum service_type "LOCAL or OUTSTATION, snapshot"
        bigint base_amount_paise
        bigint extras_amount_paise "LOCAL only, ADR-010"
        bigint line_amount_paise
        varchar description "the only user-editable field"
    }

    INVOICE_NUMBER_SEQUENCES {
        uuid tenant_id PK
        enum invoice_type PK "TAX and PERFORMANCE are independent"
        varchar fiscal_year PK
        integer next_seq
    }

    CREDIT_NOTES {
        uuid id PK
        uuid tenant_id FK
        varchar credit_note_number "unique per tenant, own sequence"
        uuid original_invoice_id FK
        uuid customer_id FK
        jsonb customer_snapshot "as of CANCELLATION, not copied from invoice"
        jsonb tenant_snapshot "as of CANCELLATION"
        bigint net_payable_paise "mirrors original invoice's frozen total"
        text reason
    }

    CREDIT_NOTE_NUMBER_SEQUENCES {
        uuid tenant_id PK
        varchar fiscal_year PK
        integer next_seq
    }

    PAYMENTS {
        uuid id PK
        uuid tenant_id FK
        uuid customer_id FK
        uuid invoice_id FK "nullable — NULL means unallocated advance"
        uuid parent_payment_id FK "self-ref, split/partial-advance audit"
        bigint amount_paise "CHECK > 0"
        enum payment_mode "CASH/UPI/NEFT/RTGS/IMPS/CHEQUE/CARD/BANK_TRANSFER"
        varchar reference_number "required for non-CASH"
        timestamptz received_at
        enum status "RECORDED / CANCELLED"
    }
```

Notes that don't fit cleanly into the diagram itself: `INVOICES.credit_note_id` has no declared FK `ON DELETE` action — it's populated only after the credit note already exists, inside the same transaction as the invoice's own `CANCELLED` transition, so the two rows are always created/committed together. `PAYMENTS.parent_payment_id` is self-referential and used for two distinct audit relationships that share the same column: an over-payment's spillover advance points at the applied portion that triggered the split, and a partial advance application's new applied-portion row points at the advance it was carved out of — `payments_parent_self_ref` (`CHECK (parent_payment_id IS NULL OR parent_payment_id <> id)`) is the only constraint distinguishing "this is a derived row" from "this is a standalone payment," the actual relationship type is inferred from context (whether `invoice_id` is set on the row versus its parent), not a separate discriminator column. `TRIP_SHEETS.held_by_invoice_id` (Module 3's own column, extended by Task 4.1) is only ever non-null while a trip sits on a DRAFT invoice — an `ISSUED` invoice's trips move to `trip_sheets.status = 'INVOICED'` instead, which is the actual, permanent record of "this trip belongs to this invoice" (via `trip_sheets.invoice_id`, also Module 3's own column), not the hold.
