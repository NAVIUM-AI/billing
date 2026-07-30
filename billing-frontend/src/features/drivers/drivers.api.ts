/**
 * Driver API layer. All responses parse through Zod at the boundary
 * (Rule 4). Soft delete is POST /drivers/:id/archive (+ /unarchive),
 * returning { driver }, not DELETE/204 — same pattern as customers and
 * vehicles. Unlike vehicles, every driver field (including phone and
 * license) is editable — driver.validator.js's own comment: "a
 * driver's phone/license genuinely change over time," no immutable
 * identity field here.
 */
import { apiClient } from "@/lib/api";
import {
  driverDetailResponseSchema,
  listDriversResponseSchema,
  type DriverFormValues,
} from "@/lib/schemas/driver";
import type { Driver, DriverFilters, DriverListResponse } from "@/types/driver";

function omitEmptyStrings<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === "" || value === undefined) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export async function listDrivers(filters: DriverFilters): Promise<DriverListResponse> {
  const res = await apiClient.get("/drivers", {
    params: {
      search: filters.search || undefined,
      limit: filters.limit,
      offset: filters.offset,
      includeArchived: filters.includeArchived,
    },
  });
  return listDriversResponseSchema.parse(res.data) as DriverListResponse;
}

export async function getDriver(id: string): Promise<Driver> {
  const res = await apiClient.get(`/drivers/${id}`);
  return driverDetailResponseSchema.parse(res.data).driver as Driver;
}

export async function createDriver(values: DriverFormValues): Promise<Driver> {
  const res = await apiClient.post("/drivers", omitEmptyStrings(values));
  return driverDetailResponseSchema.parse(res.data).driver as Driver;
}

export async function updateDriver(id: string, values: DriverFormValues): Promise<Driver> {
  const res = await apiClient.patch(`/drivers/${id}`, omitEmptyStrings(values));
  return driverDetailResponseSchema.parse(res.data).driver as Driver;
}

export async function archiveDriver(id: string): Promise<Driver> {
  const res = await apiClient.post(`/drivers/${id}/archive`);
  return driverDetailResponseSchema.parse(res.data).driver as Driver;
}

export async function unarchiveDriver(id: string): Promise<Driver> {
  const res = await apiClient.post(`/drivers/${id}/unarchive`);
  return driverDetailResponseSchema.parse(res.data).driver as Driver;
}
