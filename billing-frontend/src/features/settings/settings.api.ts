/**
 * Minimal settings API surface — just enough for F4a's invoice wizard
 * to read the tenant's real GST rate (Task 4.9 exposed gst_rate via
 * GET /settings/business). The full settings screen is out of scope
 * until F5 (Sidebar's Settings link stays disabled); this file is not
 * a stand-in for that feature.
 */
import { z } from "zod";

import { apiClient } from "@/lib/api";

const businessProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  gstin: z.string().nullable(),
  state_code: z.string().nullable(),
  invoice_prefix: z.string(),
  // Task 4.9 — read-only here (see settings.service.js#toProfile's own
  // comment); the invoice wizard needs this for its live GST preview.
  gst_rate: z.number(),
});
export type BusinessProfile = z.infer<typeof businessProfileSchema>;

export async function getBusinessProfile(): Promise<BusinessProfile> {
  const res = await apiClient.get("/settings/business");
  return businessProfileSchema.parse(res.data);
}
