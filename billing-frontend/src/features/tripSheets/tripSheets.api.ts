/**
 * Trip sheet API layer. All responses parse through Zod at the
 * boundary (Rule 4).
 *
 * ─── Contract notes (Part A findings — see tripSheets.schemas.ts's own
 * top comment for the full corrections list) ───
 * - service_type/billing_mode/customer_id/vehicle_id are accepted on
 *   CREATE only — updateTripSheetSchema doesn't even list them (not
 *   just forbidden — genuinely absent), and the shared validate()
 *   middleware's `.unknown(false)` on that schema means sending them on
 *   PATCH gets the whole request rejected, not silently ignored.
 *   toUpdatePayload() strips them accordingly.
 * - tolls[] is a full-array-replace on PATCH: presence of the key at
 *   all (even `tolls: []`) triggers an atomic delete+reinsert
 *   server-side. There is no per-toll id to preserve across an edit.
 * - There is no general CSV export endpoint for the trips list (only
 *   GET /performance-sheet/export.csv, scoped to billing_mode=
 *   PERFORMANCE trips). exportTripSheetsCsv() below builds the CSV
 *   client-side from a full re-fetch of the current filters instead —
 *   see its own comment for the row-cap caveat this implies.
 */
import { apiClient } from "@/lib/api";
import {
  tripSheetDetailResponseSchema,
  tripSheetListResponseSchema,
  type TripSheetFormValues,
} from "@/lib/schemas/tripSheet";
import type { TripSheet, TripSheetFilters, TripSheetListResponse, TripSheetListRow } from "@/types/tripSheet";

const NUMERIC_KEYS = [
  "opening_km",
  "closing_km",
  "total_km",
  "total_hours",
  "total_days",
  "toll_rupees",
  "parking_rupees",
  "permit_rupees",
  "fasttag_rupees",
  "advance_rupees",
  // Manual mode's rate fields (trip-sheets-manual-mode) — create-only,
  // same as manual_vehicle_number/manual_vehicle_type below. Only the
  // active formula's fields are ever non-empty (the form only renders
  // that formula's inputs), so omitEmptyStrings already drops the
  // other two formulas' fields before this conversion runs.
  "base_price_rupees",
  "base_hours",
  "base_km",
  "extra_km_rate_rupees",
  "extra_hr_rate_rupees",
  "slab_rate_rupees",
  "min_km_per_day",
  "driver_batta_per_day_rupees",
  "per_km_rate_rupees",
  "performance_batta_rupees",
] as const;

function omitEmptyStrings<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === "" || value === undefined) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function tollsToWire(tolls: TripSheetFormValues["tolls"]) {
  return tolls
    .filter((t) => t.plaza_name?.trim())
    .map((t) => {
      const wire: Record<string, unknown> = {
        plaza_name: t.plaza_name.trim(),
        amount_rupees: Number(t.amount_rupees),
      };
      if (t.toll_id) wire.toll_id = t.toll_id;
      if (t.crossed_at) wire.crossed_at = new Date(t.crossed_at).toISOString();
      if (t.vehicle_number) wire.vehicle_number = t.vehicle_number;
      if (t.closing_balance_rupees) wire.closing_balance_rupees = Number(t.closing_balance_rupees);
      if (t.notes) wire.notes = t.notes;
      return wire;
    });
}

function toBasePayload(values: TripSheetFormValues) {
  const { tolls, driver_id, ...rest } = values;
  const payload = omitEmptyStrings(rest) as Record<string, unknown>;
  for (const key of NUMERIC_KEYS) {
    if (payload[key] !== undefined) payload[key] = Number(payload[key]);
  }
  // Always present (not omitted-when-empty like the other optional
  // fields above): the driver_id key must explicitly carry `null` to
  // UNASSIGN a driver on PATCH — updateTripSheet only clears it when
  // the key is present at all (`hasOwnProperty`), so omitting it here
  // whenever the field is blank would make "remove the driver" silently
  // impossible from the edit form.
  payload.driver_id = driver_id || null;
  const wireTolls = tollsToWire(tolls);
  if (wireTolls.length > 0) payload.tolls = wireTolls;
  return payload;
}

function toCreatePayload(values: TripSheetFormValues) {
  return toBasePayload(values);
}

const MANUAL_MODE_CREATE_ONLY_KEYS = [
  "manual_vehicle_number",
  "manual_vehicle_type",
  "base_price_rupees",
  "base_hours",
  "base_km",
  "extra_km_rate_rupees",
  "extra_hr_rate_rupees",
  "slab_rate_rupees",
  "min_km_per_day",
  "driver_batta_per_day_rupees",
  "per_km_rate_rupees",
  "performance_batta_rupees",
] as const;

function toUpdatePayload(values: TripSheetFormValues) {
  const payload = toBasePayload(values);
  // Create-only / immutable fields — see this file's top comment.
  // updateTripSheetSchema doesn't declare vehicle/rate fields at all
  // (same immutability as fleet mode's vehicle_id/pricing_rule_id —
  // see tripSheet.repository.js#DRAFT_UPDATABLE_COLUMNS) and has
  // .unknown(false), so sending any of these on PATCH 400s the whole
  // request rather than being silently ignored.
  delete payload.service_type;
  delete payload.billing_mode;
  delete payload.customer_id;
  for (const key of MANUAL_MODE_CREATE_ONLY_KEYS) delete payload[key];
  // updateTripSheetSchema's tolls field has no default([]) — an
  // explicitly empty array still counts as "present" and triggers the
  // replace, which is what we want when the user removed every toll.
  if (!("tolls" in payload)) payload.tolls = [];
  return payload;
}

function filtersToParams(filters: TripSheetFilters) {
  return {
    search: filters.search || undefined,
    status: filters.status && filters.status.length > 0 ? filters.status.join(",") : undefined,
    service_type: filters.service_type || undefined,
    billing_mode: filters.billing_mode || undefined,
    customer_id: filters.customer_id || undefined,
    vehicle_id: filters.vehicle_id || undefined,
    driver_id: filters.driver_id || undefined,
    from_date: filters.from_date || undefined,
    to_date: filters.to_date || undefined,
    includeCancelled: filters.includeCancelled,
    limit: filters.limit,
    offset: filters.offset,
  };
}

export async function listTripSheets(filters: TripSheetFilters): Promise<TripSheetListResponse> {
  const res = await apiClient.get("/trips", { params: filtersToParams(filters) });
  return tripSheetListResponseSchema.parse(res.data) as TripSheetListResponse;
}

export async function getTripSheet(id: string): Promise<TripSheet> {
  const res = await apiClient.get(`/trips/${id}`);
  return tripSheetDetailResponseSchema.parse(res.data).trip as TripSheet;
}

export async function createTripSheet(values: TripSheetFormValues): Promise<TripSheet> {
  const res = await apiClient.post("/trips", toCreatePayload(values));
  return tripSheetDetailResponseSchema.parse(res.data).trip as TripSheet;
}

export async function updateTripSheet(id: string, values: TripSheetFormValues): Promise<TripSheet> {
  const res = await apiClient.patch(`/trips/${id}`, toUpdatePayload(values));
  return tripSheetDetailResponseSchema.parse(res.data).trip as TripSheet;
}

export async function finalizeTripSheet(id: string): Promise<TripSheet> {
  const res = await apiClient.post(`/trips/${id}/finalize`);
  return tripSheetDetailResponseSchema.parse(res.data).trip as TripSheet;
}

export async function cancelTripSheet(id: string, reason: string): Promise<TripSheet> {
  const res = await apiClient.post(`/trips/${id}/cancel`, { reason });
  return tripSheetDetailResponseSchema.parse(res.data).trip as TripSheet;
}

function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

const CSV_COLUMNS: { header: string; get: (row: TripSheetListRow) => unknown }[] = [
  { header: "Trip Number", get: (r) => r.trip_sheet_number },
  { header: "Date", get: (r) => r.trip_date },
  { header: "Service Type", get: (r) => r.service_type },
  { header: "Billing Mode", get: (r) => r.billing_mode },
  { header: "Customer", get: (r) => r.snapshot_customer_name },
  { header: "Vehicle", get: (r) => r.snapshot_vehicle_number },
  { header: "Total KM", get: (r) => r.total_km },
  { header: "Total Hours", get: (r) => r.total_hours },
  { header: "Total Days", get: (r) => r.total_days },
  { header: "Gross (Rs)", get: (r) => (r.gross_paise / 100).toFixed(2) },
  { header: "Net Payable (Rs)", get: (r) => (r.net_payable_paise / 100).toFixed(2) },
  { header: "Status", get: (r) => r.status },
];

// No backend endpoint exists for a general trips-list CSV export (see
// this file's top comment) — built client-side instead, from a FRESH
// fetch of the current filters at the backend's max page size (100,
// same limit Phase 2/3 already accepted rather than building pagination
// UI). A tenant with more than 100 rows matching the current filter
// gets a truncated export; there's no UI signal for that today, which
// is a real limitation worth flagging rather than silently living with
// once trip volume grows.
export async function exportTripSheetsCsv(filters: TripSheetFilters): Promise<{ blob: Blob; filename: string }> {
  const { trips } = await listTripSheets({ ...filters, limit: 100, offset: 0 });
  const lines = [
    CSV_COLUMNS.map((c) => csvEscape(c.header)).join(","),
    ...trips.map((row) => CSV_COLUMNS.map((c) => csvEscape(c.get(row))).join(",")),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const dateStr = new Date().toISOString().slice(0, 10);
  return { blob, filename: `trips-${dateStr}.csv` };
}
