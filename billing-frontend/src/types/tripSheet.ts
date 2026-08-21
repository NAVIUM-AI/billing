import type { TripBillingMode, TripServiceType, TripStatus, VehicleType } from "@/lib/constants/enums";

// Which code path priced this trip — trip-sheets-manual-mode migration.
// FLEET is the pre-existing registered-vehicle + pricing-rule lookup
// (still fully supported server-side, just no longer offered by this
// form — see TripSheetFormPage.tsx's own top comment). MANUAL is a
// sub-contracted/partner vehicle with per-trip negotiated rates typed
// in by hand.
export type PricingSource = "FLEET" | "MANUAL";

// Field names match the real `trip_tolls` table exactly (Task 3.2
// migration). No update lifecycle — tolls are append-once, delete-
// with-parent (see tripToll.repository.js's own comment); an edit
// resends the FULL desired tolls array and the backend atomically
// deletes+reinserts, so the frontend never needs to track
// created/removed toll ids across an edit. Stayed SHEET-level under
// Task B1 (not per-vehicle).
export interface TripToll {
  id: string;
  trip_sheet_id: string;
  tenant_id: string;
  plaza_name: string;
  toll_id: string | null;
  amount_paise: number;
  crossed_at: string | null;
  vehicle_number: string | null;
  closing_balance_paise: number | null;
  notes: string | null;
  line_number: number;
  created_at: string;
}

// One vehicle's worth of a trip sheet (Task B1: trip_sheet_vehicles
// child table, 1-10 rows per sheet). Matches the DB table exactly —
// every field the old single-vehicle `TripSheet` interface used to
// carry as its own scalars now lives here instead.
export interface TripSheetVehicle {
  id: string;
  tenant_id: string;
  trip_sheet_id: string;
  line_number: number;

  vehicle_id: string | null;
  driver_id: string | null;
  pricing_rule_id: string | null;
  pricing_source: PricingSource;

  snapshot_vehicle_number: string;
  snapshot_vehicle_type: VehicleType;

  snap_base_hours: number | null;
  snap_base_km: number | null;
  snap_base_price_paise: number | null;
  snap_extra_km_rate_paise: number | null;
  snap_extra_hr_rate_paise: number | null;
  snap_slab_rate_paise: number | null;
  snap_min_km_per_day: number | null;
  snap_driver_batta_per_day_paise: number | null;
  snap_per_km_rate_paise: number | null;
  snap_performance_batta_paise: number | null;

  start_datetime: string | null;
  end_datetime: string | null;
  opening_km: number | null;
  closing_km: number | null;
  total_km: number;
  total_hours: number;
  total_days: number;

  toll_paise: number;
  parking_paise: number;
  permit_paise: number;
  fasttag_paise: number;
  advance_paise: number;

  base_amount_paise: number;
  extras_amount_paise: number;
  driver_batta_paise: number;
  subtotal_paise: number;
  gross_paise: number;
  net_payable_paise: number;
  breakdown: { label: string; value_paise: number; detail?: string }[];

  created_at: string;
}

// Full single-trip shape (GET /trips/:id) — matches trip_sheets exactly
// post-Task-B1 restructure. service_type/billing_mode are TWO
// INDEPENDENT axes, not one 3-way "type" — see lib/constants/enums.ts's
// comment. Every per-vehicle field (usage, charges, computed totals,
// driver/vehicle identity) moved to the `vehicles` array — this is now
// purely sheet-level identity/customer/lifecycle/PDF-tracking data.
export interface TripSheet {
  id: string;
  tenant_id: string;
  trip_sheet_number: string;
  service_type: TripServiceType;
  billing_mode: TripBillingMode;
  status: TripStatus;
  // Nullable as of the trip-sheets-proforma-pdf migration — a trip may
  // have a real customer, a free-text manual_customer_name, or
  // neither ("no customer specified").
  customer_id: string | null;
  manual_customer_name: string | null;
  // Nullable in step with customer_id above — null only when the trip
  // genuinely has no customer at all (not even a free-text name).
  snapshot_customer_name: string | null;
  snapshot_customer_gstin: string | null;

  trip_date: string;

  // Task B1: 1-10 vehicles, and the sheet-level sum of their
  // net_payable_paise.
  vehicle_count: number;
  total_net_payable_paise: number;

  booked_by: string | null;
  pax_note: string | null;
  remarks: string | null;

  // Proforma PDF tracking — mirrors invoices'/credit_notes' own set
  // exactly (trip-sheets-proforma-pdf migration).
  pdf_url: string | null;
  pdf_generated_at: string | null;
  pdf_template_version: string | null;
  pdf_file_size_bytes: number | null;

  created_by: string | null;
  created_at: string;
  updated_at: string;
  finalized_at: string | null;
  finalized_by: string | null;
  invoiced_at: string | null;
  invoice_id: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;

  vehicles: TripSheetVehicle[];
  tolls: TripToll[];
}

// Narrower projection returned by GET /trips (list) — Task B1: no
// per-vehicle scalars (a sheet can have N vehicles now), so the list
// row carries vehicle_count plus a "first vehicle" summary
// (tripSheet.repository.js#list's own LATERAL join) instead. Full
// per-vehicle detail is GET /trips/:id only.
export interface TripSheetListRow {
  id: string;
  tenant_id: string;
  trip_sheet_number: string;
  service_type: TripServiceType;
  billing_mode: TripBillingMode;
  status: TripStatus;
  customer_id: string | null;
  snapshot_customer_name: string | null;
  snapshot_customer_gstin: string | null;
  trip_date: string;
  vehicle_count: number;
  total_net_payable_paise: number;
  first_vehicle_id: string | null;
  first_vehicle_number: string | null;
  first_vehicle_type: VehicleType | null;
  first_vehicle_pricing_source: PricingSource | null;
  sum_total_km: number;
  finalized_at: string | null;
  cancelled_at: string | null;
  invoice_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TripSheetFilters {
  search?: string;
  status?: TripStatus[];
  service_type?: TripServiceType;
  billing_mode?: TripBillingMode;
  customer_id?: string;
  vehicle_id?: string;
  driver_id?: string;
  from_date?: string;
  to_date?: string;
  includeCancelled?: boolean;
  limit?: number;
  offset?: number;
}

export interface TripSheetListResponse {
  trips: TripSheetListRow[];
  pagination: { total: number; limit: number; offset: number; has_more: boolean };
  aggregates: {
    sum_net_payable_paise: number;
    count_by_status: Record<TripStatus, number>;
    sum_net_payable_rupees: string;
  };
}
