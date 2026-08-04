import { useNavigate } from "react-router-dom";

import { useInvoices } from "@/features/invoices/invoices.hooks";
import { getThisMonthRange } from "@/lib/dateRanges";
import { formatPaiseAsRupees } from "@/lib/money";

// invoice.validator.js#listInvoicesQuerySchema's `status` filter is a
// single-value equality, not a comma-list like trips' — there is no
// one call that returns "ISSUED,PAID" together (Part A finding). This
// month's revenue is genuinely ISSUED + PAID invoices, so two parallel
// requests are fetched and summed client-side rather than one.
// limit=200 (Joi's own max) is assumed to comfortably cover a single
// month's invoice volume for this launch client; a busier tenant down
// the line would need real pagination here, not a bigger limit.
export function RevenueThisMonthWidget() {
  const navigate = useNavigate();
  const { from, to, monthName } = getThisMonthRange();

  const issued = useInvoices({ status: "ISSUED", date_from: from, date_to: to, limit: 200, offset: 0 });
  const paid = useInvoices({ status: "PAID", date_from: from, date_to: to, limit: 200, offset: 0 });

  const isLoading = issued.isLoading || paid.isLoading;
  const invoices = [...(issued.data?.invoices ?? []), ...(paid.data?.invoices ?? [])];
  const totalPaise = invoices.reduce((sum, i) => sum + i.gross_amount_paise, 0);
  const count = invoices.length;

  function handleClick() {
    navigate("/invoices", { state: { date_from: from, date_to: to } });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex w-full flex-col items-start rounded-lg border border-green-200 bg-white p-6 text-left shadow-sm transition-colors hover:bg-green-50/40"
    >
      <span className="text-xs font-medium uppercase tracking-wide text-gray-400">Revenue this month</span>

      {isLoading ? (
        <div className="mt-2 h-10 w-40 animate-pulse rounded bg-gray-200" />
      ) : (
        <span className="mt-1 text-4xl font-bold text-primary-600">{formatPaiseAsRupees(totalPaise)}</span>
      )}

      <span className="mt-2 text-sm text-gray-500">
        {isLoading
          ? " "
          : count > 0
            ? `${count} invoice${count === 1 ? "" : "s"} issued since ${monthName} 1`
            : "No invoices this month yet"}
      </span>
    </button>
  );
}
