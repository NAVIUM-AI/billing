// Mirrors billing-backend/src/utils/gstin.js exactly: numeric GST
// state code (GSTIN's first 2 digits) -> the same 2-letter state_code
// this app stores. Manual copy (no shared package between the two
// apps) — used ONLY for the client-side "does this GSTIN's state match
// the selected state?" pre-check (Part G). The backend re-derives and
// re-validates this itself on save (GSTIN_STATE_MISMATCH), so this is
// a fast-fail UX nicety, not the source of truth.
const GST_STATE_MAP: Record<string, string> = {
  "01": "JK",
  "02": "HP",
  "03": "PB",
  "04": "CH",
  "05": "UK",
  "06": "HR",
  "07": "DL",
  "08": "RJ",
  "09": "UP",
  "10": "BR",
  "11": "SK",
  "12": "AR",
  "13": "NL",
  "14": "MN",
  "15": "MZ",
  "16": "TR",
  "17": "ML",
  "18": "AS",
  "19": "WB",
  "20": "JH",
  "21": "OR",
  "22": "CG",
  "23": "MP",
  "24": "GJ",
  "25": "DD",
  "26": "DN",
  "27": "MH",
  "28": "AP",
  "29": "KA",
  "30": "GA",
  "31": "LD",
  "32": "KL",
  "33": "TN",
  "34": "PY",
  "35": "AN",
  "36": "TG",
  "37": "AD",
  "38": "LA",
};

const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

export function isGstinFormatValid(canonical: string): boolean {
  return GSTIN_FORMAT.test(canonical);
}

export function stateFromGstin(canonical: string): string | null {
  if (!isGstinFormatValid(canonical)) return null;
  return GST_STATE_MAP[canonical.slice(0, 2)] || null;
}
