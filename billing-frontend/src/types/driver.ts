// Field names match the real `drivers` table exactly (Task 2.2
// migration). emergency_contact stores ONLY the canonical phone value
// — there's no emergency_contact_display column (unlike phone/
// phone_display), confirmed by driver.repository.js's INSERT column
// list.
export interface Driver {
  id: string;
  tenant_id: string;
  full_name: string;
  phone: string | null;
  phone_display: string | null;
  license_number: string | null;
  license_expiry_date: string | null;
  address_line: string | null;
  emergency_contact: string | null;
  notes: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DriverFilters {
  search?: string;
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
}

export interface DriverListResponse {
  drivers: Driver[];
  pagination: { total: number; limit: number; offset: number };
}
