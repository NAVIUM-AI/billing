// Mirrors billing-backend/src/constants/gstStateCodes.js#STATE_NAMES
// exactly (2-letter state_code -> display name). There's no shared
// package between the two apps yet, so this is a manual copy, not an
// import — if the backend's list ever changes, this file needs the
// same edit. Do NOT invent/reorder entries independently.
export const STATE_NAMES: Record<string, string> = {
  JK: "Jammu and Kashmir",
  HP: "Himachal Pradesh",
  PB: "Punjab",
  CH: "Chandigarh",
  UK: "Uttarakhand",
  HR: "Haryana",
  DL: "Delhi",
  RJ: "Rajasthan",
  UP: "Uttar Pradesh",
  BR: "Bihar",
  SK: "Sikkim",
  AR: "Arunachal Pradesh",
  NL: "Nagaland",
  MN: "Manipur",
  MZ: "Mizoram",
  TR: "Tripura",
  ML: "Meghalaya",
  AS: "Assam",
  WB: "West Bengal",
  JH: "Jharkhand",
  OR: "Odisha",
  CG: "Chhattisgarh",
  MP: "Madhya Pradesh",
  GJ: "Gujarat",
  DD: "Daman and Diu",
  DN: "Dadra and Nagar Haveli",
  MH: "Maharashtra",
  AP: "Andhra Pradesh",
  KA: "Karnataka",
  GA: "Goa",
  LD: "Lakshadweep",
  KL: "Kerala",
  TN: "Tamil Nadu",
  PY: "Puducherry",
  AN: "Andaman and Nicobar Islands",
  TG: "Telangana",
  AD: "Andhra Pradesh (New)",
  LA: "Ladakh",
};

export function stateNameForCode(stateCode: string | null | undefined): string | null {
  if (!stateCode) return null;
  return STATE_NAMES[stateCode.toUpperCase()] || null;
}

// Sorted for a <select> dropdown.
export const STATE_OPTIONS = Object.entries(STATE_NAMES)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));
