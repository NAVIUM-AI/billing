import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { DataTable, type DataTableColumn } from "@/components/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { SearchInput } from "@/components/SearchInput";
import { CreditNoteDetailModal } from "@/features/creditNotes/CreditNoteDetailModal";
import { useCreditNotes } from "@/features/creditNotes/creditNotes.hooks";
import { useInvoices } from "@/features/invoices/invoices.hooks";
import { formatPaiseAsRupees } from "@/lib/money";
import type { CreditNote } from "@/types/creditNote";

export function CreditNotesListScreen() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  // GET /credit-notes has no server-side filters at all (Part A) —
  // search/date range both applied client-side over one fetched page.
  const { data, isLoading } = useCreditNotes(100);
  const { data: invoicesData } = useInvoices({ limit: 200, offset: 0 });
  const invoiceMap = new Map((invoicesData?.invoices ?? []).map((i) => [i.id, i.invoice_number]));

  const rows = (data?.credit_notes ?? []).filter((cn) => {
    if (search && !cn.credit_note_number.toLowerCase().includes(search.toLowerCase())) return false;
    if (dateFrom && cn.credit_note_date < dateFrom) return false;
    if (dateTo && cn.credit_note_date > dateTo) return false;
    return true;
  });

  const columns: DataTableColumn<CreditNote>[] = [
    {
      key: "credit_note_number",
      label: "CN Number",
      render: (cn) => (
        <button
          type="button"
          onClick={() => setOpenId(cn.id)}
          className="font-medium text-gray-900 hover:text-primary-600 hover:underline"
        >
          {cn.credit_note_number}
        </button>
      ),
    },
    { key: "credit_note_date", label: "Date" },
    {
      key: "original_invoice_id",
      label: "Original Invoice #",
      render: (cn) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/invoices/${cn.original_invoice_id}`);
          }}
          className="text-gray-700 hover:text-primary-600 hover:underline"
        >
          {invoiceMap.get(cn.original_invoice_id) || "—"}
        </button>
      ),
    },
    {
      key: "customer",
      label: "Customer",
      render: (cn) => cn.customer_snapshot.company_name || cn.customer_snapshot.name || "—",
    },
    { key: "net_payable_paise", label: "Amount", render: (cn) => formatPaiseAsRupees(cn.net_payable_paise) },
    { key: "reason", label: "Reason", render: (cn) => <span className="text-gray-600">{cn.reason}</span> },
  ];

  return (
    <div>
      <PageHeader title="Credit Notes" description="Reversals issued for cancelled invoices" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput placeholder="Search by CN number..." onDebouncedChange={setSearch} className="w-64" />
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="From date"
        />
        <span className="text-sm text-gray-400">to</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="To date"
        />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(cn) => cn.id}
        loading={isLoading}
        onRowClick={(cn) => setOpenId(cn.id)}
        emptyMessage="No credit notes yet"
        emptyDescription="Credit notes appear here when an issued invoice is cancelled."
      />

      <CreditNoteDetailModal open={Boolean(openId)} onOpenChange={(open) => !open && setOpenId(null)} creditNoteId={openId} />
    </div>
  );
}
