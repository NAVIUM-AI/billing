// Field names mirror the backend's actual `user.repository.js` PUBLIC_COLUMNS
// row shape exactly (snake_case, a raw DB row minus password_hash) —
// there is no camelCase transformation layer on the backend, so this
// type does not invent one either (Rule 4: normalize once at the API
// boundary, not by wishing the wire shape were different).
export type Role = "owner" | "admin" | "accountant" | "staff" | "viewer";

export interface User {
  id: string;
  tenant_id: string;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
}
