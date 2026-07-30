import type { FuelType, VehicleType } from "@/lib/constants/enums";

// Field names match the real `vehicles` table exactly (Task 2.1
// migration) — vehicle_number (canonical) + vehicle_number_display,
// seating_capacity (not "capacity_pax"), is_active (not a
// status enum).
export interface Vehicle {
  id: string;
  tenant_id: string;
  vehicle_number: string;
  vehicle_number_display: string | null;
  vehicle_type: VehicleType;
  make_model: string | null;
  registration_state: string | null;
  seating_capacity: number | null;
  fuel_type: FuelType | null;
  year_of_manufacture: number | null;
  notes: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface VehicleFilters {
  search?: string;
  type?: VehicleType;
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
}

export interface VehicleListResponse {
  vehicles: Vehicle[];
  pagination: { total: number; limit: number; offset: number };
}
