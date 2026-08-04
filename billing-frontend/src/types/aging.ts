// Mirrors payment.service.js#getReceivablesAging exactly — 5 buckets
// (CURRENT + 4 overdue bands), invoice-level entries, NOT the
// pre-aggregated-per-customer 4-bucket shape ('0-30'/'31-60'/'61-90'/
// '90+') an earlier draft of this task assumed. The per-customer table
// AgingReportScreen shows is built by aggregating these invoice-level
// entries client-side (see aggregateByCustomer in reports.api.ts).
export const AGING_BUCKET_NAMES = ["CURRENT", "DAYS_1_30", "DAYS_31_60", "DAYS_61_90", "DAYS_90_PLUS"] as const;
export type AgingBucketName = (typeof AGING_BUCKET_NAMES)[number];

export const AGING_BUCKET_LABELS: Record<AgingBucketName, string> = {
  CURRENT: "Current",
  DAYS_1_30: "1-30 Days",
  DAYS_31_60: "31-60 Days",
  DAYS_61_90: "61-90 Days",
  DAYS_90_PLUS: "90+ Days",
};

export interface AgingEntry {
  invoice_id: string;
  invoice_number: string | null;
  customer_id: string;
  customer_name: string | null;
  due_date: string;
  net_payable_paise: number;
  paid_paise: number;
  outstanding_paise: number;
  days_overdue: number;
}

export interface AgingBucket {
  count: number;
  total_paise: number;
  entries: AgingEntry[];
}

export interface AgingReport {
  as_of_date: string;
  summary: {
    total_outstanding_paise: number;
    total_invoices: number;
    buckets_summary: Record<AgingBucketName, { count: number; total_paise: number }>;
  };
  buckets: Record<AgingBucketName, AgingBucket>;
}

// Client-side aggregation row for the per-customer table (Part D2).
export interface CustomerAgingRow {
  customer_id: string;
  customer_name: string | null;
  byBucket: Record<AgingBucketName, number>;
  total_paise: number;
}
