/**
 * Vehicle API layer. All responses parse through Zod at the boundary
 * (Rule 4).
 *
 * ─── Flagged spec deviations (Rule 10) ───
 * - Soft delete is POST /vehicles/:id/archive (+ /unarchive), returning
 *   { vehicle }, not a DELETE/204 — same pattern Phase 2 found for
 *   customers.
 * - vehicle_number is immutable after creation (see
 *   vehicle.validator.js's own comment) — updateVehicle() below strips
 *   it from the payload the same way Phase 2 had to strip
 *   customer_type.
 */
import { apiClient } from "@/lib/api";
import {
  listVehiclesResponseSchema,
  vehicleDetailResponseSchema,
  type VehicleFormValues,
} from "@/lib/schemas/vehicle";
import type { Vehicle, VehicleFilters, VehicleListResponse } from "@/types/vehicle";

function omitEmptyStrings<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === "" || value === undefined) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

// seating_capacity/year_of_manufacture travel through the form as
// strings (native number inputs, kept simple — see vehicle.ts
// schema's numericStringField) and need converting to real numbers
// before the wire; registration_state gets uppercased to match the
// backend's own .uppercase() Joi transform (sending lowercase would
// otherwise be rejected as not matching the enum-like state code set).
function toWirePayload(values: Record<string, unknown>) {
  const payload = omitEmptyStrings(values) as Record<string, unknown>;
  if (payload.seating_capacity !== undefined) payload.seating_capacity = Number(payload.seating_capacity);
  if (payload.year_of_manufacture !== undefined) payload.year_of_manufacture = Number(payload.year_of_manufacture);
  if (payload.registration_state) payload.registration_state = String(payload.registration_state).toUpperCase();
  return payload;
}

export async function listVehicles(filters: VehicleFilters): Promise<VehicleListResponse> {
  const res = await apiClient.get("/vehicles", {
    params: {
      search: filters.search || undefined,
      type: filters.type || undefined,
      limit: filters.limit,
      offset: filters.offset,
      includeArchived: filters.includeArchived,
    },
  });
  return listVehiclesResponseSchema.parse(res.data) as VehicleListResponse;
}

export async function getVehicle(id: string): Promise<Vehicle> {
  const res = await apiClient.get(`/vehicles/${id}`);
  return vehicleDetailResponseSchema.parse(res.data).vehicle as Vehicle;
}

export async function createVehicle(values: VehicleFormValues): Promise<Vehicle> {
  const res = await apiClient.post("/vehicles", toWirePayload(values));
  return vehicleDetailResponseSchema.parse(res.data).vehicle as Vehicle;
}

export async function updateVehicle(id: string, values: VehicleFormValues): Promise<Vehicle> {
  const payload = toWirePayload(values);
  delete payload.vehicle_number; // immutable — see this file's top comment
  const res = await apiClient.patch(`/vehicles/${id}`, payload);
  return vehicleDetailResponseSchema.parse(res.data).vehicle as Vehicle;
}

export async function archiveVehicle(id: string): Promise<Vehicle> {
  const res = await apiClient.post(`/vehicles/${id}/archive`);
  return vehicleDetailResponseSchema.parse(res.data).vehicle as Vehicle;
}

export async function unarchiveVehicle(id: string): Promise<Vehicle> {
  const res = await apiClient.post(`/vehicles/${id}/unarchive`);
  return vehicleDetailResponseSchema.parse(res.data).vehicle as Vehicle;
}
