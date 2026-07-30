// Paise<->rupee helpers for pricing-rule display. The backend's own
// create/supersede endpoints accept *_rupees fields directly and do
// the rupees->paise conversion server-side (pricingRule.service.js's
// normalizeRuleFields) — the frontend never sends paise. These helpers
// exist only for DISPLAYING already-stored *_paise values (rate
// summaries, pre-filling a "new version" form from the current one).
export function paiseToRupees(paise: number | null | undefined): number | "" {
  if (paise == null) return "";
  return paise / 100;
}

export function formatPaiseAsRupees(paise: number | null | undefined): string {
  if (paise == null) return "—";
  return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
