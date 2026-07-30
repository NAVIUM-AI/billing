export type CustomerType = "B2B" | "B2C";

// Matches customers.address JSONB shape exactly
// (customer.validator.js#addressSchema) — nested, not a flat string.
export interface CustomerAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  district?: string | null;
  state?: string | null;
  pincode?: string | null;
  country?: string | null;
}

export interface CustomerContact {
  id: string;
  customer_id: string;
  tenant_id: string;
  name: string;
  role: string | null;
  phone: string | null;
  phone_display: string | null;
  email: string | null;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

// Field names/nullability match the real `customers` table (Task 2.3
// migration) exactly — NOT a single unified "name" field. B2B uses
// company_name (required) + an optional name (billing contact person);
// B2C uses name (required) and never has company_name.
export interface Customer {
  id: string;
  tenant_id: string;
  customer_type: CustomerType;
  name: string | null;
  company_name: string | null;
  gstin: string | null;
  pan: string | null;
  state_code: string | null;
  phone: string | null;
  phone_display: string | null;
  email: string | null;
  address: CustomerAddress;
  credit_days: number;
  notes: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  contacts?: CustomerContact[];
}

export interface CustomerFilters {
  search?: string;
  customer_type?: CustomerType;
  limit?: number;
  offset?: number;
}

export interface CustomerListResponse {
  customers: Customer[];
  pagination: { total: number; limit: number; offset: number };
}
