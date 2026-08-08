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
const { isValidTransition, allowedTransitions } = require("../domain/tripLifecycle");
const { rupeesToPaise, formatINR } = require("../utils/money");
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

// undefined (field not sent — irrelevant to this trip's formula) stays
// null, matching a fleet-mode pricing_rules row's own NULL-for-
// irrelevant-fields shape (this function's two callers below both
// mirror that same convention). rupeesToPaise itself throws on
// undefined, so this guard is required, not just tidy.
function rupeesOrNull(rupees) {
  return rupees != null ? rupeesToPaise(rupees) : null;
}

/**
 * Manual mode's rate fields reshaped into the same snake_case,
 * paise-denominated shape a real pricing_rules row has — this is what
 * lets computeTripTotals/the pure calculator run identically for
 * fleet and manual trips (see resolveRuleForRecompute's own
 * snapshot-fallback object for the shape this mirrors).
 *
 * @param {object} input - validated createTripSheetSchema output
 * @returns {object}
 */
function buildManualRuleForCalc(input) {
  return {
    base_hours: input.base_hours ?? null,
    base_km: input.base_km ?? null,
    base_price_paise: rupeesOrNull(input.base_price_rupees),
    extra_km_rate_paise: rupeesOrNull(input.extra_km_rate_rupees),
    extra_hr_rate_paise: rupeesOrNull(input.extra_hr_rate_rupees),
    slab_rate_paise: rupeesOrNull(input.slab_rate_rupees),
    min_km_per_day: input.min_km_per_day ?? null,
    driver_batta_per_day_paise: rupeesOrNull(input.driver_batta_per_day_rupees),
    per_km_rate_paise: rupeesOrNull(input.per_km_rate_rupees),
    performance_batta_paise: rupeesOrNull(input.performance_batta_rupees),
  };
}

/**
 * Same data as buildManualRuleForCalc, camelCased for
 * tripSheet.repository.js#insert's `snap` param — the trip's own
 * immutable audit-trail columns. Two parallel mappings from the same
 * source, not one generic converter, mirroring how the fleet-mode
 * branch below also builds ruleForCalc (snake_case, straight off the
 * DB row) and snap (camelCase) as two separate object literals from
 * the same `rule`.
 *
 * @param {object} input - validated createTripSheetSchema output
 * @returns {object}
 */
function buildManualSnap(input) {
  return {
    baseHours: input.base_hours ?? null,
    baseKm: input.base_km ?? null,
    basePricePaise: rupeesOrNull(input.base_price_rupees),
    extraKmRatePaise: rupeesOrNull(input.extra_km_rate_rupees),
    extraHrRatePaise: rupeesOrNull(input.extra_hr_rate_rupees),
    slabRatePaise: rupeesOrNull(input.slab_rate_rupees),
    minKmPerDay: input.min_km_per_day ?? null,
    driverBattaPerDayPaise: rupeesOrNull(input.driver_batta_per_day_rupees),
    perKmRatePaise: rupeesOrNull(input.per_km_rate_rupees),
    performanceBattaPaise: rupeesOrNull(input.performance_batta_rupees),
  };
}

/**
 * Guard: assert that a trip's current status permits a transition to
 * `toStatus`. Throws a clean 409 with the state machine's own
 * `allowed_transitions` list attached, rather than a generic
 * "something went wrong" — a client (or another developer reading a
 * failed request in a log) can tell from `error.details` alone what
 * transitions WOULD have worked, without having to know the state
 * machine's shape ahead of time.
 *
 * @param {{ status: string }} trip
 * @param {string} toStatus
 */
function assertTransition(trip, toStatus) {
  if (!isValidTransition(trip.status, toStatus)) {
    throw apiError(
      409,
      "INVALID_STATE_TRANSITION",
      `Trip in status '${trip.status}' cannot transition to '${toStatus}'.`,
      {
        current_status: trip.status,
        requested_status: toStatus,
        allowed_transitions: allowedTransitions(trip.status),
      },
    );
  }
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

  // Manual mode detection: the validator's own cross-field .custom()
  // check already guarantees exactly one of vehicle_id / manual_vehicle_*
  // is present on a valid request — this just reads which one.
  const isManual = input.manual_vehicle_number !== undefined;

  // Steps 4 + 5: Check (DB state) + Write, as one transaction.
  return db.withTenantContext(async (client) => {
    // (a) Customer.
    const customer = await custRepo.findById(tenantId, input.customer_id, client);
    if (!customer || !customer.is_active) {
      throw apiError(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    }

    // (c) Driver, if provided. Inactive drivers are allowed — a trip
    // may be backfilled against a driver who has since been archived.
    // Unchanged by manual mode — driver stays optional either way (the
    // frontend just hides the field in manual mode; the backend keeps
    // full support for it, per this task's own instruction).
    let driverId = null;
    if (input.driver_id) {
      const driver = await drvRepo.findById(tenantId, input.driver_id, client);
      if (!driver) {
        throw apiError(404, "DRIVER_NOT_FOUND", "Driver not found.");
      }
      driverId = driver.id;
    }

    const ruleType = deriveRuleType(serviceType, billingMode);

    let vehicleId;
    let pricingRuleId;
    let snapshotVehicleNumber;
    let snapshotVehicleType;
    let ruleForCalc;
    let snap;

    if (isManual) {
      // (b)+(d) skipped entirely — no fleet vehicle lookup, no pricing
      // rule lookup. The manual rate fields ARE the rule, built
      // straight from validated request input instead of a DB row.
      vehicleId = null;
      pricingRuleId = null;
      snapshotVehicleNumber = input.manual_vehicle_number;
      snapshotVehicleType = input.manual_vehicle_type;
      ruleForCalc = { rule_type: ruleType, ...buildManualRuleForCalc(input) };
      snap = buildManualSnap(input);
    } else {
      // (b) Vehicle.
      const vehicle = await vehRepo.findById(tenantId, input.vehicle_id, client);
      if (!vehicle || !vehicle.is_active) {
        throw apiError(404, "VEHICLE_NOT_FOUND", "Vehicle not found.");
      }

      // (d) Resolve the applicable pricing rule.
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

      vehicleId = vehicle.id;
      pricingRuleId = rule.id;
      snapshotVehicleNumber = vehicle.vehicle_number;
      snapshotVehicleType = vehicle.vehicle_type;
      ruleForCalc = { rule_type: rule.rule_type, ...rule };
      // Snapshot rule fields. The rule row already carries NULL for
      // every field not relevant to its own rule_type (enforced by the
      // pricing_rules per-type CHECK constraints), so copying the
      // whole set of rate columns straight across is correct for
      // every rule_type without branching here.
      snap = {
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
    }

    // (e) Compute pricing via the pure calculator, and (f) derive
    // computed totals from the result — shared with updateTripSheet's
    // recompute so the two can never drift apart. Identical for both
    // modes: ruleForCalc is either a real pricing_rules row (fleet) or
    // the manual rate fields reshaped into the same rule-shaped object
    // (manual) — the calculator itself has no idea which one it got.
    const { calcResult, totals } = computeTripTotals(ruleForCalc, ruleType, serviceType, billingMode, {
      totalKm: input.total_km,
      totalHours: input.total_hours,
      totalDays: input.total_days,
      tollPaise,
      parkingPaise,
      permitPaise,
      fasttagPaise,
      advancePaise,
    });
    const { baseAmountPaise, extrasAmountPaise, driverBattaPaise, subtotalPaise, grossPaise, netPayablePaise } =
      totals;

    // (g) Allocate the trip sheet number.
    const tenant = await tenantRepo.findById(tenantId, client);
    const seq = await seqRepo.allocateSeq(tenantId, fiscalYear, client);
    const tripSheetNumber = tsn.format(tenant.trip_sheet_prefix, seq, tripDateObj);

    // (i) Insert the trip, then its itemized tolls (if any) in the same
    // transaction — either both land or neither does.
    const trip = await tripRepo.insert(
      tenantId,
      {
        tripSheetNumber,
        serviceType,
        billingMode,
        customerId: customer.id,
        vehicleId,
        driverId,
        pricingRuleId,
        pricingSource: isManual ? "MANUAL" : "FLEET",
        snapshotVehicleNumber,
        snapshotVehicleType,
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

/**
 * Recomputes pricing for the effective (patch merged onto existing
 * trip) usage values, using the SAME rule the trip was originally
 * priced against — via `trip.pricing_rule_id` if that rule still
 * exists, falling back to the trip's own immutable snapshot fields
 * otherwise. This deliberately never calls ruleRepo.findApplicable():
 * doing so could silently pick up a newer rule that has since
 * superseded the original (a rule's rate columns are themselves
 * immutable — supersede only ever touches the OLD row's effective_to,
 * never its rates — so findById on the original id is guaranteed to
 * return the same numbers as the snapshot; this is belt-and-suspenders
 * consistency between the two, not a case where they could diverge).
 *
 * @param {string} tenantId
 * @param {object} trip - current trip_sheets row
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object>} a rule-shaped object usable by calculate()
 */
async function resolveRuleForRecompute(tenantId, trip, client) {
  if (trip.pricing_rule_id) {
    const ruleRow = await ruleRepo.findById(tenantId, trip.pricing_rule_id, client);
    if (ruleRow) {
      return { rule_type: ruleRow.rule_type, ...ruleRow };
    }
  }
  // Rule was hard-deleted or never linked — the snapshot IS the truth
  // (ADR-005).
  return {
    rule_type: deriveRuleType(trip.service_type, trip.billing_mode),
    base_hours: trip.snap_base_hours,
    base_km: trip.snap_base_km,
    base_price_paise: trip.snap_base_price_paise,
    extra_km_rate_paise: trip.snap_extra_km_rate_paise,
    extra_hr_rate_paise: trip.snap_extra_hr_rate_paise,
    slab_rate_paise: trip.snap_slab_rate_paise,
    min_km_per_day: trip.snap_min_km_per_day,
    driver_batta_per_day_paise: trip.snap_driver_batta_per_day_paise,
    per_km_rate_paise: trip.snap_per_km_rate_paise,
    performance_batta_paise: trip.snap_performance_batta_paise,
  };
}

/**
 * Runs the pure calculator for a trip's (possibly patch-merged) usage
 * values and derives the same base/extras/batta/subtotal/gross/net
 * breakdown createTripSheet computes — shared so PATCH's recompute and
 * create's initial compute can never drift apart.
 *
 * @param {object} ruleForCalc
 * @param {string} ruleType
 * @param {string} serviceType
 * @param {string} billingMode
 * @param {{ totalKm: number, totalHours: number, totalDays: number, tollPaise: number, parkingPaise: number, permitPaise: number, fasttagPaise: number, advancePaise: number }} effective
 * @returns {{ calcResult: object, totals: object }}
 */
function computeTripTotals(ruleForCalc, ruleType, serviceType, billingMode, effective) {
  let usage;
  if (billingMode === "PERFORMANCE") {
    usage = { running_km: effective.totalKm, toll_paise: effective.tollPaise };
  } else if (serviceType === "OUTSTATION") {
    usage = {
      total_km: effective.totalKm,
      total_days: effective.totalDays,
      toll_paise: effective.tollPaise,
      parking_paise: effective.parkingPaise,
      permit_paise: effective.permitPaise,
      fasttag_paise: effective.fasttagPaise,
      advance_paise: effective.advancePaise,
    };
  } else {
    usage = { total_km: effective.totalKm, total_hours: effective.totalHours, toll_paise: effective.tollPaise };
  }

  let calcResult;
  try {
    calcResult = calculate(ruleForCalc, usage);
  } catch (err) {
    if (err instanceof DomainInputError) {
      throw apiError(400, "INVALID_CALCULATION_INPUT", err.message, {
        field: err.field,
        reason: err.reason,
        rule_type: ruleForCalc.rule_type,
      });
    }
    throw err; // truly unexpected -> 500 is correct
  }

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
    grossPaise = subtotalPaise;
    netPayablePaise = grossPaise;
  } else if (ruleType === "OUTSTATION_SLAB") {
    baseAmountPaise = calcResult.slab_paise;
    extrasAmountPaise = calcResult.parking_paise + calcResult.permit_paise + calcResult.fasttag_paise;
    driverBattaPaise = calcResult.batta_paise;
    subtotalPaise = calcResult.gross_paise;
    grossPaise = calcResult.gross_paise;
    netPayablePaise = calcResult.net_payable_paise;
  } else {
    // PERFORMANCE
    baseAmountPaise = calcResult.km_paise;
    extrasAmountPaise = 0;
    driverBattaPaise = calcResult.batta_paise;
    subtotalPaise = calcResult.total_paise;
    grossPaise = subtotalPaise;
    netPayablePaise = grossPaise;
  }

  return {
    calcResult,
    totals: { baseAmountPaise, extrasAmountPaise, driverBattaPaise, subtotalPaise, grossPaise, netPayablePaise },
  };
}

/**
 * PATCH /trips/:tripId — editable only while a trip is DRAFT. Every
 * charge/usage field is optional; whatever's present in `patch`
 * overrides the trip's current value, and derived totals
 * (base/extras/batta/subtotal/gross/net/breakdown) are ALWAYS
 * recomputed as a group via the pricing engine — never patched
 * independently — so they can never drift out of sync with the
 * usage fields that produced them.
 *
 * @param {string} tenantId
 * @param {string} id
 * @param {object} patch - validated updateTripSheetSchema output
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
async function updateTripSheet(tenantId, id, patch, actorUserId, db) {
  // Step 1: Normalize.
  const tollsInPatch = Object.prototype.hasOwnProperty.call(patch, "tolls");
  const normalizedTolls = tollsInPatch ? normalizeTolls(patch.tolls) : null;

  const explicitTollPaiseInPatch = patch.toll_rupees !== undefined ? rupeesToPaise(patch.toll_rupees) : undefined;
  const parkingPaiseInPatch = patch.parking_rupees !== undefined ? rupeesToPaise(patch.parking_rupees) : undefined;
  const permitPaiseInPatch = patch.permit_rupees !== undefined ? rupeesToPaise(patch.permit_rupees) : undefined;
  const fasttagPaiseInPatch = patch.fasttag_rupees !== undefined ? rupeesToPaise(patch.fasttag_rupees) : undefined;
  const advancePaiseInPatch = patch.advance_rupees !== undefined ? rupeesToPaise(patch.advance_rupees) : undefined;

  // Step 2: Derive. Nothing new — FY/numbering are set once at create
  // and never revisited.

  // Step 3: Validate.
  if (
    patch.opening_km !== undefined &&
    patch.closing_km !== undefined &&
    patch.closing_km < patch.opening_km
  ) {
    throw apiError(400, "INVALID_KM_RANGE", "closing_km must be >= opening_km");
  }

  // Same sum-vs-array mutex as createTripSheet, adapted for PATCH: only
  // a genuinely non-empty itemized array conflicts with a genuinely
  // nonzero lump sum. An explicitly-empty `tolls: []` alongside a new
  // `toll_rupees` is NOT a conflict — that's "switch from itemized to
  // lump-sum in one request", a legitimate edit, not an ambiguous one.
  if (tollsInPatch && normalizedTolls.length > 0 && (explicitTollPaiseInPatch ?? 0) > 0) {
    throw apiError(
      400,
      "TOLL_INPUT_CONFLICT",
      "Provide either a lump-sum toll_rupees OR an itemized tolls array — not both.",
      { toll_rupees: patch.toll_rupees, tolls_count: normalizedTolls.length },
    );
  }

  // Steps 4 + 5: Check (DB state) + Write, as one transaction.
  return db.withTenantContext(async (client) => {
    // (a) Row-lock. Concurrency safety net — a concurrent finalize/
    // cancel/PATCH on the same trip blocks here until this transaction
    // commits or rolls back.
    const trip = await tripRepo.findByIdForUpdate(tenantId, id, client);
    if (!trip) {
      throw apiError(404, "TRIP_NOT_FOUND", "Trip sheet not found.");
    }

    // (b) Guard status.
    if (trip.status !== "DRAFT") {
      throw apiError(
        409,
        "TRIP_NOT_EDITABLE",
        `Trip is in status '${trip.status}'. Only DRAFT trips can be edited.`,
        { current_status: trip.status },
      );
    }

    // (c) driver_id, if touched. null unlinks the driver; a nonzero id
    // must resolve to a real driver (inactive is fine — same
    // reasoning as createTripSheet).
    if (Object.prototype.hasOwnProperty.call(patch, "driver_id") && patch.driver_id) {
      const driver = await drvRepo.findById(tenantId, patch.driver_id, client);
      if (!driver) {
        throw apiError(404, "DRIVER_NOT_FOUND", "Driver not found.");
      }
    }

    // (d) Recompute derived totals via the pricing engine, using the
    // SAME rule the trip already carries (never an implicit lookup —
    // see resolveRuleForRecompute's comment).
    const ruleType = deriveRuleType(trip.service_type, trip.billing_mode);
    const ruleForCalc = await resolveRuleForRecompute(tenantId, trip, client);

    const effectiveTotalKm = patch.total_km ?? trip.total_km;
    const effectiveTotalHours = patch.total_hours ?? trip.total_hours;
    const effectiveTotalDays = patch.total_days ?? trip.total_days;

    // Toll: itemized array wins if present in patch (summed, or 0 if
    // cleared to [] with no accompanying lump value); else patch's
    // lump toll_rupees; else the trip's existing toll_paise.
    let effectiveTollPaise;
    if (tollsInPatch) {
      effectiveTollPaise =
        normalizedTolls.length > 0
          ? normalizedTolls.reduce((sum, t) => sum + t.amountPaise, 0)
          : (explicitTollPaiseInPatch ?? 0);
    } else if (explicitTollPaiseInPatch !== undefined) {
      effectiveTollPaise = explicitTollPaiseInPatch;
    } else {
      effectiveTollPaise = trip.toll_paise;
    }

    const effectiveParkingPaise = parkingPaiseInPatch !== undefined ? parkingPaiseInPatch : trip.parking_paise;
    const effectivePermitPaise = permitPaiseInPatch !== undefined ? permitPaiseInPatch : trip.permit_paise;
    const effectiveFasttagPaise = fasttagPaiseInPatch !== undefined ? fasttagPaiseInPatch : trip.fasttag_paise;
    const effectiveAdvancePaise = advancePaiseInPatch !== undefined ? advancePaiseInPatch : trip.advance_paise;

    const { calcResult, totals } = computeTripTotals(ruleForCalc, ruleType, trip.service_type, trip.billing_mode, {
      totalKm: effectiveTotalKm,
      totalHours: effectiveTotalHours,
      totalDays: effectiveTotalDays,
      tollPaise: effectiveTollPaise,
      parkingPaise: effectiveParkingPaise,
      permitPaise: effectivePermitPaise,
      fasttagPaise: effectiveFasttagPaise,
      advancePaise: effectiveAdvancePaise,
    });

    // (f) Build the whitelisted repo patch. Derived totals are always
    // included (Step 1's note: recomputed as a group on every PATCH).
    const patchToDb = {
      base_amount_paise: totals.baseAmountPaise,
      extras_amount_paise: totals.extrasAmountPaise,
      driver_batta_paise: totals.driverBattaPaise,
      subtotal_paise: totals.subtotalPaise,
      gross_paise: totals.grossPaise,
      net_payable_paise: totals.netPayablePaise,
      breakdown: calcResult.breakdown,
      toll_paise: effectiveTollPaise,
      parking_paise: effectiveParkingPaise,
      permit_paise: effectivePermitPaise,
      fasttag_paise: effectiveFasttagPaise,
      advance_paise: effectiveAdvancePaise,
    };
    if (patch.trip_date !== undefined) patchToDb.trip_date = patch.trip_date;
    if (patch.start_datetime !== undefined) patchToDb.start_datetime = patch.start_datetime;
    if (patch.end_datetime !== undefined) patchToDb.end_datetime = patch.end_datetime;
    if (patch.opening_km !== undefined) patchToDb.opening_km = patch.opening_km;
    if (patch.closing_km !== undefined) patchToDb.closing_km = patch.closing_km;
    if (patch.total_km !== undefined) patchToDb.total_km = patch.total_km;
    if (patch.total_hours !== undefined) patchToDb.total_hours = patch.total_hours;
    if (patch.total_days !== undefined) patchToDb.total_days = patch.total_days;
    if (patch.booked_by !== undefined) patchToDb.booked_by = patch.booked_by;
    if (patch.pax_note !== undefined) patchToDb.pax_note = patch.pax_note;
    if (patch.remarks !== undefined) patchToDb.remarks = patch.remarks;
    if (Object.prototype.hasOwnProperty.call(patch, "driver_id")) patchToDb.driver_id = patch.driver_id;

    // (g) Write.
    const updated = await tripRepo.updateDraft(tenantId, id, patchToDb, client);
    if (!updated) {
      // Shouldn't happen — findByIdForUpdate already holds the row
      // lock for this whole transaction — but defensive in case a
      // lock was somehow released mid-transaction.
      throw apiError(
        409,
        "TRIP_STATUS_CHANGED_DURING_UPDATE",
        "Trip status changed while updating. Reload and retry.",
        { trip_id: id },
      );
    }

    // (h) Tolls: atomic delete-then-reinsert only if the patch
    // explicitly touched the array; otherwise leave the existing
    // toll rows alone and just read them back.
    let tolls;
    if (tollsInPatch) {
      await tollRepo.deleteByTrip(tenantId, id, client);
      tolls = normalizedTolls.length > 0 ? await tollRepo.insertBatch(tenantId, id, normalizedTolls, client) : [];
    } else {
      tolls = await tollRepo.listByTrip(tenantId, id, client);
    }

    // (i) Return.
    return { ...updated, tolls };
  });
}

/**
 * POST /trips/:tripId/finalize — DRAFT -> FINALIZED. A pure state
 * transition: no inputs beyond the trip id, no recomputation.
 *
 * @param {string} tenantId
 * @param {string} id
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
async function finalizeTripSheet(tenantId, id, actorUserId, db) {
  return db.withTenantContext(async (client) => {
    const trip = await tripRepo.findByIdForUpdate(tenantId, id, client);
    if (!trip) {
      throw apiError(404, "TRIP_NOT_FOUND", "Trip sheet not found.");
    }

    // Throws INVALID_STATE_TRANSITION if trip isn't DRAFT — distinct
    // from updateTripSheet's TRIP_NOT_EDITABLE: that one tells the
    // caller "edit isn't the right action here", this one is literally
    // the state machine's own complaint. Both are 409; the codes
    // differ by semantic intent.
    assertTransition(trip, "FINALIZED");

    const updated = await tripRepo.transitionStatus(
      tenantId,
      id,
      trip.status,
      "FINALIZED",
      { finalizedAt: new Date(), finalizedBy: actorUserId },
      client,
    );
    if (!updated) {
      // Someone else transitioned between findByIdForUpdate and the
      // UPDATE. Shouldn't happen under the row lock — defensive
      // belt-and-suspenders.
      throw apiError(409, "TRIP_STATUS_CHANGED", "Trip status changed. Reload and retry.", { trip_id: id });
    }

    const tolls = await tollRepo.listByTrip(tenantId, id, client);
    return { ...updated, tolls };
  });
}

/**
 * POST /trips/:tripId/cancel — DRAFT|FINALIZED -> CANCELLED. Requires
 * a reason (Joi enforces min-length; trimmed here). Tolls are left
 * untouched — they remain part of the audit trail even on a cancelled
 * trip.
 *
 * @param {string} tenantId
 * @param {string} id
 * @param {{ reason: string }} input - validated cancelTripSchema output
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
async function cancelTripSheet(tenantId, id, { reason }, actorUserId, db) {
  // Step 1: Normalize.
  const trimmedReason = reason.trim();

  return db.withTenantContext(async (client) => {
    const trip = await tripRepo.findByIdForUpdate(tenantId, id, client);
    if (!trip) {
      throw apiError(404, "TRIP_NOT_FOUND", "Trip sheet not found.");
    }

    // Rejects an already-CANCELLED trip and an INVOICED one (which
    // needs a credit-note reversal instead) with INVALID_STATE_TRANSITION.
    assertTransition(trip, "CANCELLED");

    const updated = await tripRepo.transitionStatus(
      tenantId,
      id,
      // `from` is the trip's OWN current status (DRAFT or FINALIZED),
      // not hardcoded — both are valid cancellation sources.
      trip.status,
      "CANCELLED",
      { cancelledAt: new Date(), cancelledBy: actorUserId, cancellationReason: trimmedReason },
      client,
    );
    if (!updated) {
      throw apiError(409, "TRIP_STATUS_CHANGED", "Trip status changed. Reload and retry.", { trip_id: id });
    }

    const tolls = await tollRepo.listByTrip(tenantId, id, client);
    return { ...updated, tolls };
  });
}

/**
 * Task 4.3: Module 4's invoice-issue flow calls this from WITHIN its
 * own transaction, threading its own `client` through rather than
 * opening a second `withTenantContext` — this is the fix the Task 3.3
 * stub this function replaces (`markTripInvoiced`, `db`-based, never
 * exposed as an API endpoint) had already flagged as needed once the
 * integration was actually built: an invoice's status change and its
 * trips' FINALIZED -> INVOICED transitions must commit or roll back
 * together as one unit, which is only possible if they share a
 * connection/transaction. `client` is REQUIRED, never defaulted.
 *
 * @param {string} tenantId
 * @param {string[]} tripIds
 * @param {string} invoiceId
 * @param {string} actorUserId - unused today; kept in the signature in
 *   case invoice-issue audit logging is added later.
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object[]>}
 */
// eslint-disable-next-line no-unused-vars
async function markTripsInvoiced(tenantId, tripIds, invoiceId, actorUserId, client) {
  const updatedTrips = [];
  for (const id of tripIds) {
    const trip = await tripRepo.findByIdForUpdate(tenantId, id, client);
    if (!trip) {
      throw apiError(404, "TRIP_NOT_FOUND", "Trip sheet not found.", { trip_id: id });
    }

    assertTransition(trip, "INVOICED");

    const updated = await tripRepo.transitionStatus(
      tenantId,
      id,
      trip.status,
      "INVOICED",
      { invoicedAt: new Date(), invoiceId },
      client,
    );
    if (!updated) {
      throw apiError(409, "TRIP_STATUS_CHANGED", "Trip status changed. Reload and retry.", { trip_id: id });
    }
    updatedTrips.push(updated);
  }
  return updatedTrips;
}

/**
 * Task 4.3: reverses markTripsInvoiced — INVOICED back to FINALIZED,
 * called from invoice.service.js#cancelInvoice when reversing an
 * ISSUED/PAID invoice's trips back to a re-invoiceable state. Same
 * client-threading discipline as markTripsInvoiced (required, caller's
 * own transaction). Uses tripRepo.reverseInvoiced rather than
 * transitionStatus, since transitionStatus's invoiced_at/invoice_id
 * columns are COALESCE-based and can only ADD a value, never clear one
 * — see that repo function's own comment.
 *
 * @param {string} tenantId
 * @param {string[]} tripIds
 * @param {string} actorUserId - unused today; kept in the signature in
 *   case invoice-cancel audit logging is added later.
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object[]>}
 */
// eslint-disable-next-line no-unused-vars
async function reverseTripInvoiced(tenantId, tripIds, actorUserId, client) {
  const updatedTrips = [];
  for (const id of tripIds) {
    const trip = await tripRepo.findByIdForUpdate(tenantId, id, client);
    if (!trip) {
      throw apiError(404, "TRIP_NOT_FOUND", "Trip sheet not found.", { trip_id: id });
    }

    assertTransition(trip, "FINALIZED");

    const updated = await tripRepo.reverseInvoiced(tenantId, id, client);
    if (!updated) {
      throw apiError(409, "TRIP_STATUS_CHANGED", "Trip status changed. Reload and retry.", { trip_id: id });
    }
    updatedTrips.push(updated);
  }
  return updatedTrips;
}

/**
 * GET /trips — filtered, sorted, paginated list plus aggregates for the
 * filtered set (not just the current page). Read-only: no transaction
 * needed beyond the tenant-context session-var setter that
 * withTenantContext already provides.
 *
 * @param {string} tenantId
 * @param {object} query - validated listTripsQuerySchema output
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ trips: object[], pagination: object, aggregates: object }>}
 */
async function listTrips(tenantId, query, db) {
  // Step 1: Normalize.
  const searchOriginal = query.search?.trim() || null;
  const customerId = query.customer_id ?? null;
  const vehicleId = query.vehicle_id ?? null;
  const driverId = query.driver_id ?? null;
  const fromDate = query.from_date ?? null;
  const toDate = query.to_date ?? null;
  // Joi already validated each token (listTripsQuerySchema); normalize
  // again defensively rather than trust the wire value verbatim.
  const statusIn = query.status
    ? query.status
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    : null;
  const serviceType = query.service_type ?? null;
  const billingMode = query.billing_mode ?? null;
  const sortBy = query.sort_by ?? "trip_date";
  const sortDir = query.sort_dir ?? "desc";
  const includeCancelled = query.includeCancelled ?? false;
  const limit = query.limit ?? 25;
  const offset = query.offset ?? 0;

  // Steps 2-3: Derive/Validate. Nothing service-level — Joi handles shape.

  // Steps 4-5: Read (no transaction needed — read-only).
  const result = await db.withTenantContext(async (client) => {
    return tripRepo.list(
      tenantId,
      {
        limit,
        offset,
        customerId,
        vehicleId,
        driverId,
        fromDate,
        toDate,
        statusIn,
        serviceType,
        billingMode,
        searchOriginal,
        sortBy,
        sortDir,
        includeCancelled,
      },
      client,
    );
  });

  return {
    trips: result.rows,
    pagination: {
      total: result.total_count,
      limit,
      offset,
      has_more: offset + result.rows.length < result.total_count,
    },
    aggregates: {
      sum_net_payable_paise: result.aggregates.sum_net_payable_paise,
      sum_gross_paise: result.aggregates.sum_gross_paise,
      count_by_status: result.aggregates.count_by_status,
      sum_net_payable_rupees: formatINR(result.aggregates.sum_net_payable_paise),
      sum_gross_rupees: formatINR(result.aggregates.sum_gross_paise),
    },
  };
}

module.exports = {
  createTripSheet,
  getTripSheet,
  updateTripSheet,
  finalizeTripSheet,
  cancelTripSheet,
  markTripsInvoiced,
  reverseTripInvoiced,
  listTrips,
};
