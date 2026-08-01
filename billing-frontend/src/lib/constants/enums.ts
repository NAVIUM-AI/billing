// Mirrors billing-backend/src/validators/vehicle.validator.js#VEHICLE_TYPES
// and pricingRule.validator.js#RULE_TYPES exactly (manual copy, no
// shared package between the two apps — same convention as
// gstStateCodes.ts/gstin.ts from Phase 2). These aren't exposed by any
// endpoint, so mirroring the validator's literal arrays is the only
// option; do NOT invent/reorder/rename values independently.
export const VEHICLE_TYPES = [
  "SEDAN",
  "SUV",
  "HATCHBACK",
  "INNOVA",
  "KIA_CARNIVAL",
  "TEMPO_TRAVELLER",
  "MINI_BUS",
  "BUS_50_SEATER",
  "OTHER",
] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  SEDAN: "Sedan",
  SUV: "SUV",
  HATCHBACK: "Hatchback",
  INNOVA: "Innova",
  KIA_CARNIVAL: "KIA Carnival",
  TEMPO_TRAVELLER: "Tempo Traveller",
  MINI_BUS: "Mini Bus",
  BUS_50_SEATER: "Bus (50-Seater)",
  OTHER: "Other",
};

export const FUEL_TYPES = ["PETROL", "DIESEL", "CNG", "ELECTRIC", "HYBRID"] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

export const RULE_TYPES = ["LOCAL_PACKAGE", "OUTSTATION_SLAB", "PERFORMANCE"] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const RULE_TYPE_LABELS: Record<RuleType, string> = {
  LOCAL_PACKAGE: "Local Package",
  OUTSTATION_SLAB: "Outstation Slab",
  PERFORMANCE: "Performance",
};

// Mirrors billing-backend/src/validators/tripSheet.validator.js exactly.
// IMPORTANT: there is no third "PERFORMANCE" service_type — that was an
// incorrect assumption in an earlier draft of the F3 task spec.
// service_type (LOCAL | OUTSTATION) and billing_mode (GST | PERFORMANCE)
// are two INDEPENDENT axes on the same trip; PERFORMANCE is a billing
// mode that applies to EITHER service type, not a service type itself.
// See tripSheet.service.js#deriveRuleType for the authoritative mapping
// (mirrored below in tripPricingCalc.ts).
export const TRIP_SERVICE_TYPES = ["LOCAL", "OUTSTATION"] as const;
export type TripServiceType = (typeof TRIP_SERVICE_TYPES)[number];

export const TRIP_SERVICE_TYPE_LABELS: Record<TripServiceType, string> = {
  LOCAL: "Local",
  OUTSTATION: "Outstation",
};

export const TRIP_BILLING_MODES = ["GST", "PERFORMANCE"] as const;
export type TripBillingMode = (typeof TRIP_BILLING_MODES)[number];

export const TRIP_BILLING_MODE_LABELS: Record<TripBillingMode, string> = {
  GST: "GST (Tax)",
  PERFORMANCE: "Performance (Internal Cost)",
};

export const TRIP_STATUSES = ["DRAFT", "FINALIZED", "INVOICED", "CANCELLED"] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

export const TRIP_STATUS_LABELS: Record<TripStatus, string> = {
  DRAFT: "Draft",
  FINALIZED: "Finalized",
  INVOICED: "Invoiced",
  CANCELLED: "Cancelled",
};
