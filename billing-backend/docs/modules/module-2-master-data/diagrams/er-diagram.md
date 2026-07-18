# Entity relationship diagram

_Last updated: 2026-07-18. Reviewers: TBD._

Covers `tenants` and `users` (Module 1, shown for context) plus every table Module 2 adds. Foreign keys, cardinality, and key fields only — see `03-database-schema.md` for full column lists.

```mermaid
erDiagram
    TENANTS ||--o{ USERS : "has"
    TENANTS ||--o{ VEHICLES : "owns"
    TENANTS ||--o{ DRIVERS : "owns"
    TENANTS ||--o{ CUSTOMERS : "owns"
    TENANTS ||--o{ PRICING_RULES : "owns"
    CUSTOMERS ||--o{ CUSTOMER_CONTACTS : "has"
    USERS ||--o{ VEHICLES : "created_by"
    USERS ||--o{ DRIVERS : "created_by"
    USERS ||--o{ CUSTOMERS : "created_by"
    USERS ||--o{ PRICING_RULES : "created_by"

    TENANTS {
        uuid id PK
        varchar name
        varchar slug
        varchar state_code
    }

    USERS {
        uuid id PK
        uuid tenant_id FK
        varchar email
        varchar role
    }

    VEHICLES {
        uuid id PK
        uuid tenant_id FK
        varchar vehicle_number "canonical, unique per tenant"
        varchar vehicle_number_display
        enum vehicle_type
        boolean is_active
    }

    DRIVERS {
        uuid id PK
        uuid tenant_id FK
        varchar full_name "only required field"
        varchar phone "canonical, unique per tenant when set"
        varchar license_number "unique per tenant when set"
        boolean is_active
    }

    CUSTOMERS {
        uuid id PK
        uuid tenant_id FK
        enum customer_type "B2C or B2B"
        varchar name
        varchar company_name
        varchar gstin "unique per tenant when set"
        varchar state_code
        jsonb address
        boolean is_active
    }

    CUSTOMER_CONTACTS {
        uuid id PK
        uuid customer_id FK
        uuid tenant_id "denormalized for RLS"
        varchar name
        boolean is_primary "at most one true per customer_id"
    }

    PRICING_RULES {
        uuid id PK
        uuid tenant_id FK
        enum rule_type "LOCAL_PACKAGE / OUTSTATION_SLAB / PERFORMANCE"
        enum vehicle_type
        date effective_from
        date effective_to "NULL = open-ended"
        daterange effective_range "generated column"
    }
```

Notes that don't fit cleanly into the diagram itself: `PRICING_RULES.vehicle_type` shares the same `vehicle_type_enum` as `VEHICLES.vehicle_type` but is **not** a foreign key to a specific vehicle — a pricing rule applies to an entire vehicle *category* (e.g. every `SEDAN`), not to one physical vehicle. `CUSTOMER_CONTACTS.tenant_id` is denormalized (duplicated from the parent `CUSTOMERS` row) purely so its row-level security policy can filter without a join. Every `created_by` edge shown above is nullable (`ON DELETE` behavior: the FK has no `ON DELETE` action specified, so it defaults to `NO ACTION` — a user cannot be hard-deleted while still referenced as a creator; this repo has no user hard-delete endpoint regardless, see Module 1).
