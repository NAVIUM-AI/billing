/**
 * Pricing-rule business logic. Routes call this instead of touching
 * the repository directly.
 *
 * Every create/supersede path follows the service-layer order locked
 * in from the Task 2.3 debrief: normalize -> derive -> validate ->
 * check -> write. See createRule() below for the canonical shape.
 *
 * Only previewCalculation currently consumes the pricing domain
 * (src/domain/pricing/). When trip sheet creation (Module 3) or
 * invoice generation (Module 4) consume it, use the same
 * DomainInputError -> apiError translation shown there.
 */

const pricingRuleRepository = require("../repositories/pricingRule.repository");
const { calculate, DomainInputError } = require("../domain/pricing");
const { rupeesToPaise, formatINR } = require("../utils/money");
const { apiError } = require("../utils/httpError");

const REQUIRED_FIELDS_BY_TYPE = {
  LOCAL_PACKAGE: [
    "base_hours",
    "base_km",
    "base_price_paise",
    "extra_km_rate_paise",
    "extra_hr_rate_paise",
  ],
  OUTSTATION_SLAB: ["slab_rate_paise", "min_km_per_day", "driver_batta_per_day_paise"],
  PERFORMANCE: ["per_km_rate_paise", "performance_batta_paise"],
};

const MISSING_FIELDS_ERROR_CODE = {
  LOCAL_PACKAGE: "LOCAL_FIELDS_MISSING",
  OUTSTATION_SLAB: "OUTSTATION_FIELDS_MISSING",
  PERFORMANCE: "PERFORMANCE_FIELDS_MISSING",
};

/**
 * Step 1 (Normalize): converts every wire-format *_rupees field to its
 * *_paise equivalent, passing integer counts (base_hours, base_km,
 * min_km_per_day) through untouched. Fields the caller didn't send
 * stay `undefined` rather than being defaulted to 0 — Step 3 below
 * needs to tell "not provided" apart from "explicitly zero".
 *
 * @param {object} input
 * @returns {object} rule fields keyed by their *_paise / DB column names
 */
function normalizeRuleFields(input) {
  return {
    base_hours: input.base_hours,
    base_km: input.base_km,
    base_price_paise:
      input.base_price_rupees !== undefined
        ? rupeesToPaise(input.base_price_rupees)
        : undefined,
    extra_km_rate_paise:
      input.extra_km_rate_rupees !== undefined
        ? rupeesToPaise(input.extra_km_rate_rupees)
        : undefined,
    extra_hr_rate_paise:
      input.extra_hr_rate_rupees !== undefined
        ? rupeesToPaise(input.extra_hr_rate_rupees)
        : undefined,
    slab_rate_paise:
      input.slab_rate_rupees !== undefined ? rupeesToPaise(input.slab_rate_rupees) : undefined,
    min_km_per_day: input.min_km_per_day,
    driver_batta_per_day_paise:
      input.driver_batta_per_day_rupees !== undefined
        ? rupeesToPaise(input.driver_batta_per_day_rupees)
        : undefined,
    per_km_rate_paise:
      input.per_km_rate_rupees !== undefined ? rupeesToPaise(input.per_km_rate_rupees) : undefined,
    performance_batta_paise:
      input.performance_batta_rupees !== undefined
        ? rupeesToPaise(input.performance_batta_rupees)
        : undefined,
  };
}

/**
 * Step 3 (Validate per rule_type): the DB CHECK constraints are the
 * safety net, but failing here means the frontend gets a precise
 * "here's what you're missing" error before we ever hit the DB.
 *
 * @param {string} ruleType
 * @param {object} normalized - output of normalizeRuleFields()
 */
function validateRequiredFields(ruleType, normalized) {
  const required = REQUIRED_FIELDS_BY_TYPE[ruleType];
  const missing = required.filter(
    (key) => normalized[key] === undefined || normalized[key] === null,
  );
  if (missing.length > 0) {
    throw apiError(
      400,
      MISSING_FIELDS_ERROR_CODE[ruleType],
      `Missing required fields for ${ruleType}.`,
      { missing_fields: missing },
    );
  }
}

/**
 * @param {string} tenantId
 * @param {object} input - validated createRuleSchema output
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
async function createRule(tenantId, input, actorUserId, db) {
  // Step 1: Normalize.
  const ruleType = input.rule_type.toUpperCase();
  const vehicleType = input.vehicle_type.toUpperCase();
  const normalized = normalizeRuleFields(input);

  // Step 2: Derive. Nothing to derive — an omitted effective_to simply
  // stays null (open-ended); there is no default to compute.

  // Step 3: Validate per rule_type.
  validateRequiredFields(ruleType, normalized);

  // Step 4: Persistence check. Nothing to do here — the exclusion
  // constraint (pricing_rules_no_overlap) is the only pre-check this
  // create needs, and it's enforced by the DB + mapped to a clean 409
  // inside repo.insert().

  // Step 5: Write.
  return db.withTenantContext((client) =>
    pricingRuleRepository.insert(
      tenantId,
      {
        ruleType,
        vehicleType,
        label: input.label,
        basePriceP: normalized.base_price_paise,
        baseHours: normalized.base_hours,
        baseKm: normalized.base_km,
        extraKmRateP: normalized.extra_km_rate_paise,
        extraHrRateP: normalized.extra_hr_rate_paise,
        slabRateP: normalized.slab_rate_paise,
        minKmPerDay: normalized.min_km_per_day,
        driverBattaPerDayP: normalized.driver_batta_per_day_paise,
        perKmRateP: normalized.per_km_rate_paise,
        performanceBattaP: normalized.performance_batta_paise,
        effectiveFrom: input.effective_from,
        effectiveTo: input.effective_to ?? null,
        notes: input.notes,
        createdBy: actorUserId,
      },
      client,
    ),
  );
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
async function getRule(tenantId, id, db) {
  const rule = await db.withTenantContext((client) =>
    pricingRuleRepository.findById(tenantId, id, client),
  );
  if (!rule) {
    throw apiError(404, "PRICING_RULE_NOT_FOUND", "Pricing rule not found.");
  }
  return rule;
}

/**
 * @param {string} tenantId
 * @param {{ limit: number, offset: number, rule_type?: string, vehicle_type?: string, on_date?: string, activeOnly?: boolean }} query
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ rules: object[], pagination: { total: number, limit: number, offset: number } }>}
 */
async function listRules(tenantId, query, db) {
  const {
    limit,
    offset,
    rule_type: ruleType,
    vehicle_type: vehicleType,
    on_date: onDate,
    activeOnly,
  } = query;

  const { rows, total } = await db.withTenantContext((client) =>
    pricingRuleRepository.list(
      tenantId,
      { limit, offset, ruleType, vehicleType, onDate, activeOnly },
      client,
    ),
  );

  return { rules: rows, pagination: { total, limit, offset } };
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {{ label?: string, notes?: string, effective_to?: string }} patch - validated updateRuleSchema output (label/notes/effective_to only)
 * @param {string} actorUserId - unused today but threaded through so the
 *   audit-log hook below has it once it ships.
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
// eslint-disable-next-line no-unused-vars
async function updateRule(tenantId, id, patch, actorUserId, db) {
  return db.withTenantContext(async (client) => {
    const existing = await pricingRuleRepository.findById(tenantId, id, client);
    if (!existing) {
      throw apiError(404, "PRICING_RULE_NOT_FOUND", "Pricing rule not found.");
    }

    const updated = await pricingRuleRepository.updatePatchable(tenantId, id, patch, client);

    // TODO: emit audit_log entry when audit module ships in Task 3.x.

    return updated;
  });
}

/**
 * @param {string} tenantId
 * @param {string} id - the rule being superseded
 * @param {object} newInput - validated supersedeSchema output
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ superseded: object, new_rule: object }>}
 */
async function supersedeRule(tenantId, id, newInput, actorUserId, db) {
  return db.withTenantContext(async (client) => {
    // rule_type isn't in newInput (see supersedeSchema) — it's
    // inherited from the rule being superseded, so we need to look
    // that up before Step 3 can validate the new rate fields against
    // the right required-fields set. This read and the update+insert
    // pair below all run on the same client/transaction, so there's no
    // staleness window between them.
    const existing = await pricingRuleRepository.findById(tenantId, id, client);
    if (!existing) {
      throw apiError(404, "PRICING_RULE_NOT_FOUND", "Pricing rule not found.");
    }

    const ruleType = existing.rule_type;

    // Steps 1 & 3: Normalize + validate, same as createRule.
    const normalized = normalizeRuleFields(newInput);
    validateRequiredFields(ruleType, normalized);

    // Step 5: Write (Step 4 persistence check is the exclusion
    // constraint again, enforced inside repo.supersede's insert).
    const { supersededRow, newRow } = await pricingRuleRepository.supersede(
      tenantId,
      id,
      {
        label: newInput.label,
        basePriceP: normalized.base_price_paise,
        baseHours: normalized.base_hours,
        baseKm: normalized.base_km,
        extraKmRateP: normalized.extra_km_rate_paise,
        extraHrRateP: normalized.extra_hr_rate_paise,
        slabRateP: normalized.slab_rate_paise,
        minKmPerDay: normalized.min_km_per_day,
        driverBattaPerDayP: normalized.driver_batta_per_day_paise,
        perKmRateP: normalized.per_km_rate_paise,
        performanceBattaP: normalized.performance_batta_paise,
        effectiveFrom: newInput.effective_from,
        notes: newInput.notes,
        createdBy: actorUserId,
      },
      client,
    );

    return { superseded: supersededRow, new_rule: newRow };
  });
}

/**
 * @param {string} tenantId
 * @param {{ ruleType: string, vehicleType: string, onDate?: string }} params - onDate defaults to today (computed fresh per call, not at schema-definition time) when omitted
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
async function getApplicableRule(tenantId, { ruleType, vehicleType, onDate }, db) {
  const effectiveOnDate = onDate || new Date().toISOString().slice(0, 10);
  const rule = await db.withTenantContext((client) =>
    pricingRuleRepository.findApplicable(
      tenantId,
      { ruleType, vehicleType, onDate: effectiveOnDate },
      client,
    ),
  );
  if (!rule) {
    throw apiError(
      404,
      "NO_APPLICABLE_RULE",
      "No pricing rule found for the given vehicle_type + rule_type on the given date.",
      { rule_type: ruleType, vehicle_type: vehicleType, on_date: effectiveOnDate },
    );
  }
  return rule;
}

/**
 * Converts every wire-format *_rupees key in a usage object to its
 * *_paise equivalent; plain counts (total_km, total_hours, total_days,
 * running_km) pass through untouched since they're not money. Generic
 * over key name so it doesn't need updating every time a calculator
 * gains a new pass-through cost field (toll, parking, permit,
 * fasttag, advance, ...).
 *
 * @param {Record<string, unknown>} usage
 * @returns {Record<string, unknown>}
 */
function normalizeUsage(usage) {
  const normalized = {};
  for (const [key, val] of Object.entries(usage)) {
    if (key.endsWith("_rupees")) {
      normalized[key.replace(/_rupees$/, "_paise")] = rupeesToPaise(val);
    } else {
      normalized[key] = val;
    }
  }
  return normalized;
}

/**
 * Adds a `_rupees`-suffixed, human-formatted string alongside every
 * top-level `_paise` field in a calculator result, e.g.
 * `total_paise: 483800` -> also `total_rupees: '₹4,838.00'`.
 *
 * @param {Record<string, unknown>} result
 * @returns {Record<string, string>}
 */
function buildFormatted(result) {
  const formatted = {};
  for (const [key, val] of Object.entries(result)) {
    if (key.endsWith("_paise") && typeof val === "number") {
      formatted[key.replace(/_paise$/, "_rupees")] = formatINR(val);
    }
  }
  return formatted;
}

/**
 * @param {string} tenantId
 * @param {{ ruleType: string, vehicleType: string, onDate?: string, usage: object }} params
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ rule: object, usage: object, result: object }>}
 */
async function previewCalculation(tenantId, { ruleType, vehicleType, onDate, usage }, db) {
  // getApplicableRule defaults onDate to today when omitted.
  const rule = await getApplicableRule(tenantId, { ruleType, vehicleType, onDate }, db);

  const normalizedUsage = normalizeUsage(usage);

  // Pure calculators throw DomainInputError for bad input. Translate to
  // a clean 400 here rather than letting it fall through to the global
  // handler as 500. See ADR-006 and Standing Rule 5.
  let result;
  try {
    result = calculate(rule, normalizedUsage);
  } catch (err) {
    if (err instanceof DomainInputError) {
      throw apiError(400, "INVALID_CALCULATION_INPUT", err.message, {
        field: err.field,
        reason: err.reason,
        rule_type: rule.rule_type,
        rule_id: rule.id,
      });
    }
    throw err; // truly unexpected -> 500 is correct
  }

  return {
    rule: {
      id: rule.id,
      rule_type: rule.rule_type,
      vehicle_type: rule.vehicle_type,
      label: rule.label,
      effective_from: rule.effective_from,
      effective_to: rule.effective_to,
    },
    usage: normalizedUsage,
    result: { ...result, formatted: buildFormatted(result) },
  };
}

module.exports = {
  createRule,
  getRule,
  listRules,
  updateRule,
  supersedeRule,
  getApplicableRule,
  previewCalculation,
};
