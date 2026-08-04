import { z } from "zod";

import { AGING_BUCKET_NAMES } from "@/types/aging";

const agingEntrySchema = z.object({
  invoice_id: z.string().uuid(),
  invoice_number: z.string().nullable(),
  customer_id: z.string().uuid(),
  customer_name: z.string().nullable(),
  due_date: z.string(),
  net_payable_paise: z.number(),
  paid_paise: z.number(),
  outstanding_paise: z.number(),
  days_overdue: z.number(),
});

const agingBucketSchema = z.object({
  count: z.number(),
  total_paise: z.number(),
  entries: z.array(agingEntrySchema),
});

const bucketNameEnum = z.enum(AGING_BUCKET_NAMES);

export const agingReportResponseSchema = z.object({
  as_of_date: z.string(),
  summary: z.object({
    total_outstanding_paise: z.number(),
    total_invoices: z.number(),
    buckets_summary: z.record(bucketNameEnum, z.object({ count: z.number(), total_paise: z.number() })),
  }),
  buckets: z.record(bucketNameEnum, agingBucketSchema),
});
