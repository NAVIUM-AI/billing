import type { TripServiceType, VehicleType } from "@/lib/constants/enums";

export type InvoiceType = "TAX" | "PERFORMANCE";
export type InvoiceStatus = "DRAFT" | "ISSUED" | "PAID" | "CANCELLED";

// Snapshot shapes frozen onto the invoice at ISSUE time
// (invoiceSnapshot.js#buildTenantSnapshot/buildCustomerSnapshot) — only
// the fields that actually exist on tenants/customers, no
// tagline/phone2/website invention (see pdf.service.js's own top
// comment on this exact gap).
export interface InvoiceTenantSnapshot {
  name: string;
  gstin: string | null;
  pan: string | null;
  state_code: string | null;
  address?: Record<string, unknown> | null;
  bank_details?: Record<string, unknown> | null;
}

export interface InvoiceCustomerSnapshot {
  customer_type: "B2B" | "B2C";
  name: string | null;
  company_name: string | null;
  gstin: string | null;
  pan: string | null;
  state_code: string | null;
  address?: Record<string, unknown> | null;
  phone?: string | null;
  email?: string | null;
}

// Matches invoice_lines exactly (Task 4.1 migration).
export interface InvoiceLine {
  id: string;
  invoice_id: string;
  trip_sheet_id: string;
  line_number: number;
  service_type: TripServiceType;
  trip_date: string;
  vehicle_number: string;
  vehicle_type: VehicleType;
  total_km: number;
  total_hours: number | null;
  total_days: number | null;
  base_amount_paise: number;
  extras_amount_paise: number;
  driver_batta_paise: number;
  line_amount_paise: number;
  hsn_sac_code: string;
  description: string | null;
  created_at: string;
}

// Full single-invoice shape (GET /invoices/:id) — matches `invoices`
// exactly (Task 4.1 migration) + service_type (Task 4.9) +
// reverse_charge (Task 4.8). getInvoice() also attaches lines/customer/
// tenant refs (invoice.service.js#getInvoice), not raw DB columns.
export interface Invoice {
  id: string;
  tenant_id: string;
  invoice_number: string | null;
  invoice_type: InvoiceType;
  // Task 4.9: nullable — legacy invoices created before this column
  // existed stay NULL forever (no backfill). F4a always sends one.
  service_type: TripServiceType | null;
  status: InvoiceStatus;
  customer_id: string;

  invoice_date: string;
  due_date: string;
  notes: string | null;
  terms: string | null;

  subtotal_paise: number;
  gst_rate_snapshot: number | null;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  total_gst_paise: number;

  toll_paise: number;
  parking_paise: number;
  permit_paise: number;
  fasttag_paise: number;
  toll_manual_override: boolean;
  parking_manual_override: boolean;
  permit_manual_override: boolean;
  fasttag_manual_override: boolean;

  discount_paise: number;
  discount_reason: string | null;

  round_off_paise: number;
  grand_total_paise: number;
  net_payable_paise: number;
  amount_in_words: string | null;

  reverse_charge: boolean | null;

  tenant_snapshot: InvoiceTenantSnapshot | null;
  customer_snapshot: InvoiceCustomerSnapshot | null;

  pdf_url: string | null;
  pdf_generated_at: string | null;
  pdf_template_version: string | null;

  created_by: string | null;
  created_at: string;
  updated_at: string;
  issued_at: string | null;
  issued_by: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  credit_note_id: string | null;

  lines: InvoiceLine[];
  customer?: {
    id: string;
    customer_type: "B2B" | "B2C";
    name: string | null;
    company_name: string | null;
    gstin: string | null;
    state_code: string | null;
  } | null;
  tenant?: { id: string; name: string; gstin: string | null; state_code: string | null } | null;
}

// Row shape from GET /invoices (Task 4.9, tenant-wide list) —
// invoice.repository.js#list's SELECT list exactly. NOTE:
// `gross_amount_paise` is a SQL alias for the real `net_payable_paise`
// column (the task's own comment on this) — there is no
// gross_amount_paise column anywhere; this list row genuinely only has
// this one money field, unlike the detail response's several.
export interface InvoiceListRow {
  id: string;
  invoice_number: string | null;
  invoice_type: InvoiceType;
  service_type: TripServiceType | null;
  status: InvoiceStatus;
  customer_id: string;
  customer_name: string | null;
  invoice_date: string;
  gross_amount_paise: number;
  issued_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceFilters {
  search?: string;
  status?: InvoiceStatus;
  invoice_type?: InvoiceType;
  service_type?: TripServiceType;
  customer_id?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
}

export interface InvoiceListResponse {
  invoices: InvoiceListRow[];
  pagination: { total: number; limit: number; offset: number; has_more: boolean };
}

// Task 4.2: one row from GET /customers/:id/invoiceable-trips. The
// backend groups these by service_type already (groups.LOCAL/
// OUTSTATION) but does NOT filter or split by billing_mode (Part A
// finding — no such query param exists), so a customer with both GST
// and PERFORMANCE trips gets them mixed within the same group; the
// frontend filters by billing_mode client-side using this field.
export interface InvoiceableTrip {
  id: string;
  trip_sheet_number: string;
  trip_date: string;
  service_type: TripServiceType;
  billing_mode: "GST" | "PERFORMANCE";
  snapshot_vehicle_number: string;
  total_km: number;
  toll_paise: number;
  parking_paise: number;
  permit_paise: number;
  fasttag_paise: number;
  subtotal_paise: number;
  gross_paise: number;
  net_payable_paise: number;
}

export interface InvoiceableTripsGroup {
  trips: InvoiceableTrip[];
  summary: {
    count: number;
    total_km: number;
    total_subtotal_paise: number;
    total_gross_paise: number;
    total_net_payable_paise: number;
  };
}

export interface InvoiceableTripsResponse {
  customer: {
    id: string;
    name: string | null;
    company_name: string | null;
    customer_type: "B2B" | "B2C";
    gstin: string | null;
    state_code: string | null;
    credit_days: number;
  };
  groups: {
    LOCAL: InvoiceableTripsGroup;
    OUTSTATION: InvoiceableTripsGroup;
  };
  total_summary: InvoiceableTripsGroup["summary"];
}

// Matches `credit_notes` exactly (Task 4.3 migration).
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
