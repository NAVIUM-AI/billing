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
// created/removed toll ids across an edit.
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

// Full single-trip shape (GET /trips/:id) — matches trip_sheets
// exactly (Task 3.1 migration). service_type/billing_mode are TWO
// INDEPENDENT axes, not one 3-way "type" — see lib/constants/enums.ts's
// comment.
export interface TripSheet {
  id: string;
  tenant_id: string;
  trip_sheet_number: string;
  service_type: TripServiceType;
  billing_mode: TripBillingMode;
  status: TripStatus;
  customer_id: string;
  // Nullable for MANUAL-mode trips (trip-sheets-manual-mode migration
  // dropped the NOT NULL constraint) — always non-null for FLEET.
  vehicle_id: string | null;
  driver_id: string | null;
  pricing_rule_id: string | null;
  pricing_source: PricingSource;

  snapshot_vehicle_number: string;
  snapshot_vehicle_type: VehicleType;
  snapshot_customer_name: string;
  snapshot_customer_gstin: string | null;

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

  trip_date: string;
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

  booked_by: string | null;
  pax_note: string | null;
  remarks: string | null;

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

  tolls: TripToll[];
}

// Narrower projection returned by GET /trips (list) — deliberately
// omits breakdown/snap_*/tolls (tripSheet.repository.js#list's own
// comment: "keeping the list payload small"). Do NOT assume list rows
// have the fields only the detail response carries.
export interface TripSheetListRow {
  id: string;
  tenant_id: string;
  trip_sheet_number: string;
  service_type: TripServiceType;
  billing_mode: TripBillingMode;
  status: TripStatus;
  customer_id: string;
  vehicle_id: string | null;
  driver_id: string | null;
  pricing_source: PricingSource;
  snapshot_vehicle_number: string;
  snapshot_vehicle_type: VehicleType;
  snapshot_customer_name: string;
  snapshot_customer_gstin: string | null;
  trip_date: string;
  total_km: number;
  total_hours: number;
  total_days: number;
  subtotal_paise: number;
  gross_paise: number;
  net_payable_paise: number;
  advance_paise: number;
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
    sum_gross_paise: number;
    count_by_status: Record<TripStatus, number>;
    sum_net_payable_rupees: string;
    sum_gross_rupees: string;
  };
}
