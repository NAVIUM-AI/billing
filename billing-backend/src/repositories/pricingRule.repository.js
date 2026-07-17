/**
 * SQL for the `pricing_rules` table. Has FORCE ROW LEVEL SECURITY (see
 * the pricing_rules migration), so every query here MUST run on a
 * client that already has `app.current_tenant_id` set for this
 * transaction — same convention as vehicle/driver/customer
 * repositories (Tasks 2.1-2.3). No `pool` fallback; `client` is always
 * a client obtained via req.db.withTenantContext().
 *
 * Every enum and date column parameter gets an explicit cast
 * ($n::pricing_rule_type_enum, $n::vehicle_type_enum, $n::date) —
 * Postgres has no implicit cast from text to a custom enum type (see
 * the Task 2.3 debrief: comparing an enum column to a bare text
 * parameter fails outright with "operator does not exist").
 */

const { apiError } = require("../utils/httpError");

const EXCLUSION_VIOLATION = "23P01";
const CHECK_VIOLATION = "23514";

const PATCHABLE_COLUMNS = ["label", "notes", "effective_to"];

/**
 * Shared by insert() and updatePatchable(): both can hit
 * pricing_rules_no_overlap (insert only, in practice — a patch never
 * touches vehicle_type/rule_type/effective_from) and the per-rule-type
 * CHECK constraints (insert) or pricing_effective_range (either, since
 * updatePatchable can move effective_to).
 *
 * @param {Error & { code?: string, constraint?: string }} err
 * @param {{ vehicleType?: string, ruleType?: string }} context
 */
function mapConstraintError(err, { vehicleType, ruleType } = {}) {
  if (err.code === EXCLUSION_VIOLATION) {
    throw apiError(
      409,
      "PRICING_RULE_OVERLAP",
      "A rule for this vehicle_type + rule_type already exists in the requested date range.",
      { vehicle_type: vehicleType, rule_type: ruleType },
    );
  }

  if (err.code === CHECK_VIOLATION) {
    if (err.constraint === "pricing_local_required_fields") {
      throw apiError(
        400,
        "LOCAL_FIELDS_MISSING",
        "Missing required fields for LOCAL_PACKAGE.",
      );
    }
    if (err.constraint === "pricing_outstation_required_fields") {
      throw apiError(
        400,
        "OUTSTATION_FIELDS_MISSING",
        "Missing required fields for OUTSTATION_SLAB.",
      );
    }
    if (err.constraint === "pricing_performance_required_fields") {
      throw apiError(
        400,
        "PERFORMANCE_FIELDS_MISSING",
        "Missing required fields for PERFORMANCE.",
      );
    }
    if (err.constraint === "pricing_effective_range") {
      throw apiError(
        400,
        "INVALID_DATE_RANGE",
        "effective_to must be after effective_from.",
      );
    }
  }

  throw err;
}

/**
 * @param {string} tenantId
 * @param {object} params
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object>}
 */
async function insert(
  tenantId,
  {
    ruleType,
    vehicleType,
    label,
    basePriceP,
    baseHours,
    baseKm,
    extraKmRateP,
    extraHrRateP,
    slabRateP,
    minKmPerDay,
    driverBattaPerDayP,
    perKmRateP,
    performanceBattaP,
    effectiveFrom,
    effectiveTo,
    notes,
    createdBy,
  },
  client,
) {
  try {
    const result = await client.query(
      `INSERT INTO pricing_rules (
         tenant_id, rule_type, vehicle_type, label,
         base_hours, base_km, base_price_paise,
         extra_km_rate_paise, extra_hr_rate_paise,
         slab_rate_paise, min_km_per_day, driver_batta_per_day_paise,
         per_km_rate_paise, performance_batta_paise,
         effective_from, effective_to, notes, created_by
       )
       VALUES (
         $1, $2::pricing_rule_type_enum, $3::vehicle_type_enum, $4,
         $5, $6, $7,
         $8, $9,
         $10, $11, $12,
         $13, $14,
         $15::date, $16::date, $17, $18
       )
       RETURNING *`,
      [
        tenantId,
        ruleType,
        vehicleType,
        label,
        baseHours ?? null,
        baseKm ?? null,
        basePriceP ?? null,
        extraKmRateP ?? null,
        extraHrRateP ?? null,
        slabRateP ?? null,
        minKmPerDay ?? null,
        driverBattaPerDayP ?? null,
        perKmRateP ?? null,
        performanceBattaP ?? null,
        effectiveFrom,
        effectiveTo ?? null,
        notes ?? null,
        createdBy ?? null,
      ],
    );
    return result.rows[0];
  } catch (err) {
    mapConstraintError(err, { vehicleType, ruleType });
  }
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function findById(tenantId, id, client) {
  const result = await client.query(
    "SELECT * FROM pricing_rules WHERE id = $1 AND tenant_id = $2",
    [id, tenantId],
  );
  return result.rows[0] || null;
}

/**
 * The pricing_rules_no_overlap exclusion constraint guarantees at
 * most one matching row exists, so LIMIT 1 is a formality, not a
 * safety net.
 *
 * @param {string} tenantId
 * @param {{ ruleType: string, vehicleType: string, onDate: string }} params
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function findApplicable(tenantId, { ruleType, vehicleType, onDate }, client) {
  const result = await client.query(
    `SELECT *
     FROM pricing_rules
     WHERE tenant_id    = $1
       AND rule_type    = $2::pricing_rule_type_enum
       AND vehicle_type = $3::vehicle_type_enum
       AND effective_from <= $4::date
       AND (effective_to IS NULL OR effective_to > $4::date)
     LIMIT 1`,
    [tenantId, ruleType, vehicleType, onDate],
  );
  return result.rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {{ limit: number, offset: number, ruleType?: string, vehicleType?: string, onDate?: string, activeOnly?: boolean }} options
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{ rows: object[], total: number }>}
 */
async function list(
  tenantId,
  { limit, offset, ruleType, vehicleType, onDate, activeOnly },
  client,
) {
  const conditions = ["tenant_id = $1"];
  const values = [tenantId];

  if (ruleType) {
    values.push(ruleType);
    conditions.push(`rule_type = $${values.length}::pricing_rule_type_enum`);
  }
  if (vehicleType) {
    values.push(vehicleType);
    conditions.push(`vehicle_type = $${values.length}::vehicle_type_enum`);
  }
  if (onDate) {
    values.push(onDate);
    const idx = values.length;
    conditions.push(
      `effective_from <= $${idx}::date AND (effective_to IS NULL OR effective_to > $${idx}::date)`,
    );
  }
  if (activeOnly) {
    conditions.push("(effective_to IS NULL OR effective_to > CURRENT_DATE)");
  }

  const whereClause = conditions.join(" AND ");

  // Two separate queries (list page + total count) rather than a
  // COUNT(*) OVER() window, so pagination.total reflects the full
  // matching set even when the requested page is empty.
  const listResult = await client.query(
    `SELECT * FROM pricing_rules
     WHERE ${whereClause}
     ORDER BY effective_from DESC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset],
  );

  const countResult = await client.query(
    `SELECT COUNT(*) FROM pricing_rules WHERE ${whereClause}`,
    values,
  );

  return { rows: listResult.rows, total: Number(countResult.rows[0].count) };
}

/**
 * Whitelist ONLY: label, notes, effective_to. Rate fields, rule_type,
 * vehicle_type, and effective_from never reach this function — the
 * validator already rejects them at the API boundary (see
 * pricingRule.validator.js's updateRuleSchema), so silently dropping
 * anything else here is just a second layer of the same guarantee.
 *
 * @param {string} tenantId
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object>}
 */
async function updatePatchable(tenantId, id, patch, client) {
  const keys = Object.keys(patch).filter((key) => PATCHABLE_COLUMNS.includes(key));
  if (keys.length === 0) {
    throw apiError(400, "EMPTY_PATCH", "No valid fields to update.");
  }

  // $1 = id, $2 = tenantId, so column placeholders start at $3.
  const setClause = keys
    .map((key, i) => {
      const placeholder = `$${i + 3}`;
      return key === "effective_to" ? `${key} = ${placeholder}::date` : `${key} = ${placeholder}`;
    })
    .join(", ");
  const values = keys.map((key) => patch[key]);

  try {
    const result = await client.query(
      `UPDATE pricing_rules SET ${setClause} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, ...values],
    );
    return result.rows[0];
  } catch (err) {
    mapConstraintError(err, {});
  }
}

/**
 * Atomically closes the existing rule's effective_to at the new rule's
 * effective_from, then inserts the new rule as the open-ended
 * (effective_to = NULL) current version. Both statements run on the
 * same `client`, so the caller (service) is expected to have opened a
 * transaction via db.withTenantContext.
 *
 * @param {string} tenantId
 * @param {string} existingId
 * @param {object} newRuleData - same shape as insert()'s params, minus ruleType/vehicleType (inherited from the existing row) and effectiveTo (always NULL for a supersede)
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{ supersededRow: object, newRow: object }>}
 */
async function supersede(tenantId, existingId, newRuleData, client) {
  const existing = await findById(tenantId, existingId, client);
  if (!existing) {
    throw apiError(404, "PRICING_RULE_NOT_FOUND", "Pricing rule not found.");
  }

  // The existing row already has a closed effective_to at or before
  // where this new version would start — meaning it was already
  // superseded by some other rule for this date. Extending THIS
  // (already-closed) branch further is not what supersede means;
  // supersede the rule that's actually open (effective_to IS NULL) at
  // that date instead.
  if (existing.effective_to !== null && existing.effective_to <= newRuleData.effectiveFrom) {
    throw apiError(
      400,
      "ALREADY_SUPERSEDED",
      "This rule has already been superseded by a later version.",
    );
  }

  await client.query(
    "UPDATE pricing_rules SET effective_to = $3::date WHERE id = $1 AND tenant_id = $2",
    [existingId, tenantId, newRuleData.effectiveFrom],
  );

  const newRow = await insert(
    tenantId,
    {
      ruleType: existing.rule_type,
      vehicleType: existing.vehicle_type,
      label: newRuleData.label,
      basePriceP: newRuleData.basePriceP,
      baseHours: newRuleData.baseHours,
      baseKm: newRuleData.baseKm,
      extraKmRateP: newRuleData.extraKmRateP,
      extraHrRateP: newRuleData.extraHrRateP,
      slabRateP: newRuleData.slabRateP,
      minKmPerDay: newRuleData.minKmPerDay,
      driverBattaPerDayP: newRuleData.driverBattaPerDayP,
      perKmRateP: newRuleData.perKmRateP,
      performanceBattaP: newRuleData.performanceBattaP,
      effectiveFrom: newRuleData.effectiveFrom,
      effectiveTo: null,
      notes: newRuleData.notes,
      createdBy: newRuleData.createdBy,
    },
    client,
  );

  const supersededRow = await findById(tenantId, existingId, client);

  return { supersededRow, newRow };
}

module.exports = {
  insert,
  findById,
  findApplicable,
  list,
  updatePatchable,
  supersede,
};
