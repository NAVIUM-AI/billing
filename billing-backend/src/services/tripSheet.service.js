/**
 * Trip sheet business logic. Routes call this instead of touching any
 * repository directly.
 *
 * createTripSheet follows the service-layer order locked in from the
 * Task 2.3 debrief: normalize -> derive -> validate -> check -> write.
 * "Check" and "write" happen together inside a single
 * db.withTenantContext transaction (Part H(4)+(5) of the Task 3.1
 * spec) because every check from here on needs DB state (does the
 * customer/vehicle/driver/pricing rule actually exist right now?) and
 * all of it — including trip-number allocation — must succeed or fail
 * as one atomic unit: a failed insert must not burn a sequence number,
 * and a sequence number must never be allocated for a trip that didn't
 * actually get created.
 *
 * Only createTripSheet currently consumes the pricing domain
 * (src/domain/pricing/) outside of pricingRule.service.js — same
 * DomainInputError -> apiError translation shown there (ADR-006,
 * Standing Rule 5).
 */

const { calculate, DomainInputError } = require("../domain/pricing");
const { rupeesToPaise } = require("../utils/money");
const { toIndianFY } = require("../utils/fiscalYear");
const tsn = require("../utils/tripSheetNumber");
const tripRepo = require("../repositories/tripSheet.repository");
const tollRepo = require("../repositories/tripToll.repository");
const seqRepo = require("../repositories/tripSheetSequence.repository");
const custRepo = require("../repositories/customer.repository");
const vehRepo = require("../repositories/vehicle.repository");
const drvRepo = require("../repositories/driver.repository");
const ruleRepo = require("../repositories/pricingRule.repository");
const tenantRepo = require("../repositories/tenant.repository");
const { apiError } = require("../utils/httpError");

/**
 * Maps the two independent axes (service_type, billing_mode) to the
 * pricing_rule_type_enum value that governs the calculation. Only the
 * LOCAL branches are reachable in this task — OUTSTATION is rejected
 * in Step 3 below before this is ever called with an OUTSTATION
 * service_type — but the table is written in full (not just the LOCAL
 * rows) since it's the actual, permanent shape of the mapping, not a
 * Task-3.1-scoped subset.
 *
 * @param {string} serviceType
 * @param {string} billingMode
 * @returns {string}
 */
function deriveRuleType(serviceType, billingMode) {
  if (serviceType === "LOCAL" && billingMode === "GST") return "LOCAL_PACKAGE";
  if (serviceType === "LOCAL" && billingMode === "PERFORMANCE") return "PERFORMANCE";
  if (serviceType === "OUTSTATION" && billingMode === "GST") return "OUTSTATION_SLAB";
  if (serviceType === "OUTSTATION" && billingMode === "PERFORMANCE") return "PERFORMANCE";
  /* istanbul ignore next -- Joi's .valid() already constrains both
   * inputs to their two allowed values each, so all four combinations
   * are covered above; this is unreachable in practice. */
  throw new Error(`Unhandled service_type/billing_mode combination: ${serviceType}/${billingMode}`);
}

/**
 * Normalizes the wire-shape `tolls` array (Task 3.2) into the
 * repository's camelCase param shape, assigning line_number
 * sequentially in request order.
 *
 * @param {Array<object>} tollsInput - validated tollReceiptSchema items
 * @returns {Array<object>}
 */
function normalizeTolls(tollsInput) {
  return tollsInput.map((t, i) => ({
    plazaName: t.plaza_name.trim(),
    tollId: t.toll_id?.trim() || null,
    amountPaise: rupeesToPaise(t.amount_rupees),
    crossedAt: t.crossed_at || null,
    vehicleNumber: t.vehicle_number?.trim() || null,
    closingBalancePaise: t.closing_balance_rupees != null ? rupeesToPaise(t.closing_balance_rupees) : null,
    notes: t.notes?.trim() || null,
    lineNumber: i + 1,
  }));
}

/**
 * Parses a 'YYYY-MM-DD' string into a Date at LOCAL midnight (via the
 * y/m/d numeric constructor, not `new Date(str)`), matching
 * fiscalYear.js#toIndianFY's use of the local-time getFullYear()/
 * getMonth() accessors. `new Date('2026-07-08')` would parse as UTC
 * midnight instead, which round-trips through the FY calculation
 * correctly only when the server's UTC offset happens to be >= 0 — the
 * same class of local-midnight/UTC-midnight mismatch documented for
 * DATE columns in Task 2.2's timezone bug and worked around in
 * pricingRule.validator.js's isoDateField. Constructing directly from
 * numeric components sidesteps it entirely.
 *
 * @param {string} isoDateStr
 * @returns {Date}
 */
function parseCalendarDateLocal(isoDateStr) {
  const [y, m, d] = isoDateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * @param {string} tenantId
 * @param {object} input - validated createTripSheetSchema output
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db - req.db
 * @returns {Promise<object>}
 */
async function createTripSheet(tenantId, input, actorUserId, db) {
  // Step 1: Normalize.
  const serviceType = input.service_type.toUpperCase();
  const billingMode = input.billing_mode.toUpperCase();
  const explicitTollPaise = rupeesToPaise(input.toll_rupees);
  const parkingPaise = rupeesToPaise(input.parking_rupees);
  const permitPaise = rupeesToPaise(input.permit_rupees);
  const fasttagPaise = rupeesToPaise(input.fasttag_rupees);
  const advancePaise = rupeesToPaise(input.advance_rupees);
  const tripDateObj = parseCalendarDateLocal(input.trip_date);
  const normalizedTolls = normalizeTolls(input.tolls);

  // Step 2: Derive.
  const fiscalYear = toIndianFY(tripDateObj);

  // Step 3: Validate.
  if (
    input.opening_km !== undefined &&
    input.closing_km !== undefined &&
    input.closing_km < input.opening_km
  ) {
    throw apiError(400, "INVALID_KM_RANGE", "closing_km must be >= opening_km");
  }

  // Sum-vs-array cross-field rule (Task 3.2): the wire contract must
  // not accept both a lump-sum toll_rupees AND an itemized tolls array
  // on the same request — see tripSheet.validator.js's top-of-file
  // comment on tollReceiptSchema for why this lives here, not in Joi.
  if (serviceType === "OUTSTATION" && normalizedTolls.length > 0 && explicitTollPaise > 0) {
    throw apiError(
      400,
      "TOLL_INPUT_CONFLICT",
      "Provide either a lump-sum toll_rupees OR an itemized tolls array — not both.",
      { toll_rupees: input.toll_rupees, tolls_count: normalizedTolls.length },
    );
  }

  // Effective toll: sum of itemized receipts when present, otherwise
  // the lump-sum value. The conflict check above guarantees these two
  // sources are never both nonzero, so there's no ambiguity in which
  // one "wins".
  const tollPaise =
    normalizedTolls.length > 0
      ? normalizedTolls.reduce((sum, t) => sum + t.amountPaise, 0)
      : explicitTollPaise;

  // Steps 4 + 5: Check (DB state) + Write, as one transaction.
  return db.withTenantContext(async (client) => {
    // (a) Customer.
    const customer = await custRepo.findById(tenantId, input.customer_id, client);
    if (!customer || !customer.is_active) {
      throw apiError(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    }

    // (b) Vehicle.
    const vehicle = await vehRepo.findById(tenantId, input.vehicle_id, client);
    if (!vehicle || !vehicle.is_active) {
      throw apiError(404, "VEHICLE_NOT_FOUND", "Vehicle not found.");
    }

    // (c) Driver, if provided. Inactive drivers are allowed — a trip
    // may be backfilled against a driver who has since been archived.
    let driverId = null;
    if (input.driver_id) {
      const driver = await drvRepo.findById(tenantId, input.driver_id, client);
      if (!driver) {
        throw apiError(404, "DRIVER_NOT_FOUND", "Driver not found.");
      }
      driverId = driver.id;
    }

    // (d) Resolve the applicable pricing rule.
    const ruleType = deriveRuleType(serviceType, billingMode);
    const rule = await ruleRepo.findApplicable(
      tenantId,
      { ruleType, vehicleType: vehicle.vehicle_type, onDate: input.trip_date },
      client,
    );
    if (!rule) {
      throw apiError(
        400,
        "NO_APPLICABLE_PRICING_RULE",
        "No pricing rule found for this vehicle_type + rule_type on the trip date. Configure a rule in Settings → Pricing.",
        { vehicle_type: vehicle.vehicle_type, rule_type: ruleType, on_date: input.trip_date },
      );
    }

    // (e) Compute pricing via the pure calculator.
    const ruleForCalc = { rule_type: rule.rule_type, ...rule };
    let usage;
    if (billingMode === "PERFORMANCE") {
      // Same shape for LOCAL and OUTSTATION performance — sum km with
      // batta and toll. Service_type doesn't affect this branch at all.
      usage = { running_km: input.total_km, toll_paise: tollPaise };
    } else if (serviceType === "OUTSTATION") {
      // OUTSTATION GST (slab-based).
      usage = {
        total_km: input.total_km,
        total_days: input.total_days,
        toll_paise: tollPaise,
        parking_paise: parkingPaise,
        permit_paise: permitPaise,
        fasttag_paise: fasttagPaise,
        advance_paise: advancePaise,
      };
    } else {
      // LOCAL GST — unchanged from Task 3.1.
      usage = { total_km: input.total_km, total_hours: input.total_hours, toll_paise: tollPaise };
    }

    let calcResult;
    try {
      calcResult = calculate(ruleForCalc, usage);
    } catch (err) {
      if (err instanceof DomainInputError) {
        throw apiError(400, "INVALID_CALCULATION_INPUT", err.message, {
          field: err.field,
          reason: err.reason,
          rule_type: rule.rule_type,
        });
      }
      throw err; // truly unexpected -> 500 is correct
    }

    // (f) Derive computed totals from the calculator result.
    let baseAmountPaise;
    let extrasAmountPaise;
    let driverBattaPaise;
    let subtotalPaise;
    let grossPaise;
    let netPayablePaise;
    if (ruleType === "LOCAL_PACKAGE") {
      baseAmountPaise = calcResult.base_paise;
      extrasAmountPaise = calcResult.extra_km_paise + calcResult.extra_hours_paise;
      driverBattaPaise = 0;
      subtotalPaise = calcResult.subtotal_paise;
      // Advance is intentionally NOT applied to LOCAL trips at trip
      // level — see the outstation advance-at-invoice note below.
      // gross === net for LOCAL_PACKAGE.
      grossPaise = subtotalPaise;
      netPayablePaise = grossPaise;
    } else if (ruleType === "OUTSTATION_SLAB") {
      baseAmountPaise = calcResult.slab_paise;
      // toll_paise is tracked in its own trip_sheets column (like
      // LOCAL_PACKAGE), so it's deliberately excluded here — extras is
      // parking + permit + fasttag only.
      extrasAmountPaise = calcResult.parking_paise + calcResult.permit_paise + calcResult.fasttag_paise;
      driverBattaPaise = calcResult.batta_paise;
      subtotalPaise = calcResult.gross_paise;
      grossPaise = calcResult.gross_paise;
      // Unlike LOCAL, advance IS deducted here: net_payable = gross -
      // advance for OUTSTATION (the Niriksha CI-1905 reference).
      // Invoice-level advance handling for combined B2B billing is
      // Module 4's concern, not this trip-level figure.
      netPayablePaise = calcResult.net_payable_paise;
    } else {
      // PERFORMANCE — identical calculator output shape regardless of
      // service_type (LOCAL or OUTSTATION), so one branch covers both.
      baseAmountPaise = calcResult.km_paise;
      extrasAmountPaise = 0;
      driverBattaPaise = calcResult.batta_paise;
      subtotalPaise = calcResult.total_paise;
      grossPaise = subtotalPaise;
      netPayablePaise = grossPaise;
    }

    // (g) Allocate the trip sheet number.
    const tenant = await tenantRepo.findById(tenantId, client);
    const seq = await seqRepo.allocateSeq(tenantId, fiscalYear, client);
    const tripSheetNumber = tsn.format(tenant.trip_sheet_prefix, seq, tripDateObj);

    // (h) Snapshot rule fields. The rule row already carries NULL for
    // every field not relevant to its own rule_type (enforced by the
    // pricing_rules per-type CHECK constraints), so copying the whole
    // set of rate columns straight across is correct for every
    // rule_type without branching here.
    const snap = {
      baseHours: rule.base_hours,
      baseKm: rule.base_km,
      basePricePaise: rule.base_price_paise,
      extraKmRatePaise: rule.extra_km_rate_paise,
      extraHrRatePaise: rule.extra_hr_rate_paise,
      slabRatePaise: rule.slab_rate_paise,
      minKmPerDay: rule.min_km_per_day,
      driverBattaPerDayPaise: rule.driver_batta_per_day_paise,
      perKmRatePaise: rule.per_km_rate_paise,
      performanceBattaPaise: rule.performance_batta_paise,
    };

    // (i) Insert the trip, then its itemized tolls (if any) in the same
    // transaction — either both land or neither does.
    const trip = await tripRepo.insert(
      tenantId,
      {
        tripSheetNumber,
        serviceType,
        billingMode,
        customerId: customer.id,
        vehicleId: vehicle.id,
        driverId,
        pricingRuleId: rule.id,
        snapshotVehicleNumber: vehicle.vehicle_number,
        snapshotVehicleType: vehicle.vehicle_type,
        snapshotCustomerName: customer.company_name || customer.name,
        snapshotCustomerGstin: customer.gstin,
        snap,
        tripDate: input.trip_date,
        startDatetime: input.start_datetime,
        endDatetime: input.end_datetime,
        openingKm: input.opening_km,
        closingKm: input.closing_km,
        totalKm: input.total_km,
        totalHours: input.total_hours,
        totalDays: input.total_days,
        tollPaise,
        parkingPaise,
        permitPaise,
        fasttagPaise,
        advancePaise,
        baseAmountPaise,
        extrasAmountPaise,
        driverBattaPaise,
        subtotalPaise,
        grossPaise,
        netPayablePaise,
        breakdown: calcResult.breakdown,
        bookedBy: input.booked_by,
        paxNote: input.pax_note,
        remarks: input.remarks,
        createdBy: actorUserId,
      },
      client,
    );

    const tolls = await tollRepo.insertBatch(tenantId, trip.id, normalizedTolls, client);

    return { ...trip, tolls };
  });
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
async function getTripSheet(tenantId, id, db) {
  const trip = await db.withTenantContext(async (client) => {
    const found = await tripRepo.findById(tenantId, id, client);
    if (!found) {
      return null;
    }
    const tolls = await tollRepo.listByTrip(tenantId, id, client);
    return { ...found, tolls };
  });
  if (!trip) {
    throw apiError(404, "TRIP_NOT_FOUND", "Trip sheet not found.");
  }
  return trip;
}

module.exports = { createTripSheet, getTripSheet };
