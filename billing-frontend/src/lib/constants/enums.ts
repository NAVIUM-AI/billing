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
