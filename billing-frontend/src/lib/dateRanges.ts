import { format, startOfMonth } from "date-fns";

// "This month" for the dashboard's revenue/activity widgets. No tenant
// timezone config exists anywhere in this app (Rule 10 — nothing to
// read); the browser's local time is used directly, which is IST for
// the Pravasi launch's actual users.
export interface ThisMonthRange {
  from: string;
  to: string;
  monthName: string;
  monthNumber: number;
}

export function getThisMonthRange(): ThisMonthRange {
  const now = new Date();
  return {
    from: format(startOfMonth(now), "yyyy-MM-dd"),
    to: format(now, "yyyy-MM-dd"),
    monthName: format(now, "MMMM"),
    monthNumber: now.getMonth() + 1,
  };
}
