# Entity relationship diagram

_Last updated: 2026-07-19. Reviewers: TBD._

Scoped to Module 3's own tables (`trip_sheets`, `trip_sheet_sequences`, `trip_tolls`) plus their foreign keys into Module 1/2 tables, shown for context. For the full Module 1/2 ER diagram, see `docs/modules/module-2-master-data/diagrams/er-diagram.md`.

```mermaid
erDiagram
    TENANTS ||--o{ TRIP_SHEETS : owns
    TENANTS ||--o{ TRIP_SHEET_SEQUENCES : owns
    TENANTS ||--o{ TRIP_TOLLS : owns
    CUSTOMERS ||--o{ TRIP_SHEETS : "billed to"
    VEHICLES ||--o{ TRIP_SHEETS : "operated by"
    DRIVERS ||--o{ TRIP_SHEETS : "driven by (optional)"
    PRICING_RULES ||--o{ TRIP_SHEETS : "rated by (optional)"
    USERS ||--o{ TRIP_SHEETS : "created_by / finalized_by / cancelled_by"
    TRIP_SHEETS ||--o{ TRIP_TOLLS : "has itemized tolls"

    TENANTS {
        uuid id PK
        varchar trip_sheet_prefix "e.g. 'TS'"
    }

    TRIP_SHEETS {
        uuid id PK
        uuid tenant_id FK
        varchar trip_sheet_number "unique per tenant, {prefix}-{seq}/{FY}"
        enum service_type "LOCAL or OUTSTATION"
        enum billing_mode "GST or PERFORMANCE"
        enum status "DRAFT / FINALIZED / INVOICED / CANCELLED"
        uuid customer_id FK
        uuid vehicle_id FK
        uuid driver_id FK "nullable"
        uuid pricing_rule_id FK "nullable"
        varchar snapshot_vehicle_number "immutable snapshot"
        varchar snapshot_customer_name "immutable snapshot"
        date trip_date
        integer total_km
        integer subtotal_paise
        integer gross_paise
        integer net_payable_paise
        jsonb breakdown
    }

    TRIP_SHEET_SEQUENCES {
        uuid tenant_id PK
        varchar fiscal_year PK "e.g. '26-27'"
        integer next_seq
    }

    TRIP_TOLLS {
        uuid id PK
        uuid trip_sheet_id FK
        uuid tenant_id "denormalized for RLS"
        varchar plaza_name
        integer amount_paise
        smallint line_number "unique per trip_sheet_id"
    }
```

Notes that don't fit cleanly into the diagram itself: `TRIP_SHEETS.pricing_rule_id` is nullable and `ON DELETE SET NULL` — the row's own `snap_*` columns (not shown individually above; see `03-database-schema.md` for the full list) are the fallback source of truth if the referenced rule ever goes away, which is the entire point of the snapshot pattern (ADR-005). `TRIP_TOLLS.tenant_id` is denormalized from the parent `TRIP_SHEETS` row, the same pattern `CUSTOMER_CONTACTS.tenant_id` uses in Module 2, purely so its row-level security policy can filter without a join. `TRIP_SHEET_SEQUENCES` has no foreign key to any individual trip — it's a pure counter, keyed on `(tenant_id, fiscal_year)`, that trip-number allocation draws from atomically.
