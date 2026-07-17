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
  "trips:read": ["owner", "admin", "accountant", "staff", "viewer"],
  "trips:write": ["owner", "admin", "accountant", "staff"],
  "trips:finalize": ["owner", "admin", "accountant"],
  "invoices:read": ["owner", "admin", "accountant", "viewer"],
  "invoices:draft": ["owner", "admin", "accountant", "staff"],
  "invoices:issue": ["owner", "admin", "accountant"],
  "invoices:cancel": ["owner", "admin"],
  "payments:read": ["owner", "admin", "accountant", "viewer"],
  "payments:record": ["owner", "admin", "accountant"],
  "reports:read": ["owner", "admin", "accountant", "viewer"],
});
