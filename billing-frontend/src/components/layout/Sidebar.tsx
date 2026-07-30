import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  FileText,
  Receipt,
  Users,
  Car,
  Settings,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  enabled: boolean;
}

// Trip Sheets/Invoices/Vehicles/Settings are still placeholders — their
// screens ship in F3/F4. Disabled rather than omitted so the full
// future nav shape is visible from F1 onward (Rule: lock in
// architecture once). Customers enabled in F2 Phase 2.
const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", to: "/dashboard", icon: LayoutDashboard, enabled: true },
  { label: "Trip Sheets", to: "/trips", icon: FileText, enabled: false },
  { label: "Invoices", to: "/invoices", icon: Receipt, enabled: false },
  { label: "Customers", to: "/customers", icon: Users, enabled: true },
  { label: "Vehicles", to: "/vehicles", icon: Car, enabled: false },
  { label: "Settings", to: "/settings", icon: Settings, enabled: false },
];

export function Sidebar() {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-white">
      <div className="flex h-14 items-center border-b px-4">
        <span className="text-lg font-bold text-primary-600">Navium Billing</span>
      </div>
      <nav className="flex flex-col gap-1 p-3">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          if (!item.enabled) {
            return (
              <div
                key={item.to}
                className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm text-gray-500 opacity-50"
                aria-disabled="true"
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </div>
            );
          }
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary-50 text-primary-700"
                    : "text-gray-700 hover:bg-accent-50",
                )
              }
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
