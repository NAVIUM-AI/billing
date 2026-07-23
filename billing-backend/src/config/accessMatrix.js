/**
 * Single source of truth for role permissions. Add new permission keys
 * here, then reference them via requirePermission() in routes. Do NOT
 * scatter role checks inline in handlers.
 *
 * Format: permission key -> array of roles allowed to perform it. Roles
 * come from the `users_role_check` DB constraint (Task 1.1):
 * 'owner', 'admin', 'accountant', 'staff', 'viewer'.
 *
 * Keep this file and the table in README.md ("Access matrix") in sync —
 * the README table is a copy of this object for onboarding purposes.
 */

module.exports = Object.freeze({
  // ─── Settings ───
  "settings:read": ["owner", "admin", "accountant", "staff", "viewer"],
  "settings:update": ["owner", "admin"],

  // ─── Users ───
  "users:list": ["owner", "admin", "accountant", "viewer"],
  "users:create": ["owner", "admin"],
  "users:update_role": ["owner", "admin"],
  "users:deactivate": ["owner", "admin"],

  // ─── Placeholders for Module 2+ ───
  // (defined here now so future tasks don't have to scatter role logic)
  "customers:read": ["owner", "admin", "accountant", "staff", "viewer"],
  "customers:write": ["owner", "admin", "accountant", "staff"],
  "vehicles:read": ["owner", "admin", "accountant", "staff", "viewer"],
  "vehicles:write": ["owner", "admin", "accountant", "staff"],
  "drivers:read": ["owner", "admin", "accountant", "staff", "viewer"],
  "drivers:write": ["owner", "admin", "accountant", "staff"],
  // pricing:write is deliberately narrower than the other :write keys
  // above — rates are commercially sensitive, and unlike a vehicle or
  // driver record, an accidental staff edit here changes what every
  // future invoice charges. Only owner + admin, never staff.
  "pricing:read": ["owner", "admin", "accountant", "staff", "viewer"],
  "pricing:write": ["owner", "admin"],
  "trips:read": ["owner", "admin", "accountant", "staff", "viewer"],
  "trips:write": ["owner", "admin", "accountant", "staff"],
  "trips:finalize": ["owner", "admin", "accountant"],
  // Cancel destroys billable history, so it's a higher-privilege
  // operation than write/finalize — staff can create, edit, and
  // finalize trips, but only accountant/admin/owner can cancel one.
  "trips:cancel": ["owner", "admin", "accountant"],
  // Read includes staff (fixed in Task 4.1): staff can draft (create)
  // invoices below, so they must also be able to read back what they
  // created — the pre-4.1 set silently omitted staff from read while
  // granting them draft, which would have 403'd their own POST /invoices
  // follow-up GET.
  "invoices:read": ["owner", "admin", "accountant", "staff", "viewer"],
  "invoices:draft": ["owner", "admin", "accountant", "staff"],
  "invoices:issue": ["owner", "admin", "accountant"],
  "invoices:cancel": ["owner", "admin"],
  // Record includes staff (Task 4.4) — same reasoning as
  // invoices:draft: staff take payments at the front desk. Cancel is
  // narrower (no staff) since reversing a recorded payment is a
  // higher-privilege correction, same relationship as trips:write vs
  // trips:cancel.
  "payments:record": ["owner", "admin", "accountant", "staff"],
  "payments:cancel": ["owner", "admin", "accountant"],
  "payments:read": ["owner", "admin", "accountant", "staff", "viewer"],
  // Narrower than the pre-Task-4.4 placeholder (no staff, per the Task
  // 4.4 spec) — receivables/aging data is financial reporting, not an
  // operational read like trips:read or payments:read. Widened to
  // include viewer in Task 4.6: viewer is this system's read-only role
  // by design, and the aging report is a pure read — there was no
  // reason to exclude it. staff remains excluded: staff is
  // operational (front-desk data entry), not analytical, in the
  // current role model.
  "reports:read": ["owner", "admin", "accountant", "viewer"],
});
