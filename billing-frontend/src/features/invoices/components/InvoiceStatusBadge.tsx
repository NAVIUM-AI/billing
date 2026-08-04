import { cn } from "@/lib/utils";
import type { InvoiceStatus } from "@/types/invoice";

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <span
      className={cn(
        "rounded px-2 py-1 text-xs font-medium",
        status === "DRAFT" && "bg-gray-200 text-gray-700",
        status === "ISSUED" && "bg-blue-100 text-blue-700",
        status === "PAID" && "bg-green-100 text-green-700",
        status === "CANCELLED" && "bg-red-100 text-red-700",
      )}
    >
      {status}
    </span>
  );
}
