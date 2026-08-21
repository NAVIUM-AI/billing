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
const vehicleLineRepo = require("../repositories/tripSheetVehicle.repository");
const tollRepo = require("../repositories/tripToll.repository");
const seqRepo = require("../repositories/tripSheetSequence.repository");
const custRepo = require("../repositories/customer.repository");
const vehRepo = require("../repositories/vehicle.repository");
const drvRepo = require("../repositories/driver.repository");
const ruleRepo = require("../repositories/pricingRule.repository");
const tenantRepo = require("../repositories/tenant.repository");
const { MANUAL_RATE_FIELDS_BY_FORMULA, findVehicleItemError } = require("../validators/tripSheet.validator");
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
 * Resolves one vehicle-array item into the full insert-ready shape
 * tripSheetVehicle.repository.js#insertBatch expects (camelCase,
 * `snap` object, computed totals) — the per-vehicle equivalent of what
 * createTripSheet used to do inline for its single vehicle. Runs the
 * SAME fleet/manual lookup + pure-calculator sequence Task A already
 * established; only the caller now loops this once per vehicle instead
 * of running it once for the whole trip.
 *
 * @param {string} tenantId
 * @param {object} v - one validated vehicleItemSchema item
 * @param {number} lineNumber - 1-based position in the sheet
 * @param {string} serviceType
 * @param {string} billingMode
 * @param {string} ruleType
 * @param {string} tripDateIso
 * @param {number} effectiveTollPaise - resolved by the caller (itemized-tolls-sum override for a lone vehicle, or this vehicle's own toll_rupees)
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object>}
 */
async function resolveAndComputeVehicle(
  tenantId,
  v,
  lineNumber,
  serviceType,
  billingMode,
  ruleType,
  tripDateIso,
  effectiveTollPaise,
  client,
) {
  const isManual = v.manual_vehicle_number !== undefined;

  let vehicleId;
  let driverId = null;
  let pricingRuleId;
  let snapshotVehicleNumber;
  let snapshotVehicleType;
  let ruleForCalc;
  let snap;

  if (v.driver_id) {
    const driver = await drvRepo.findById(tenantId, v.driver_id, client);
    if (!driver) {
      throw apiError(404, "DRIVER_NOT_FOUND", "Driver not found.", { vehicle_index: lineNumber });
    }
    driverId = driver.id;
  }

  if (isManual) {
    vehicleId = null;
    pricingRuleId = null;
    snapshotVehicleNumber = v.manual_vehicle_number;
    snapshotVehicleType = v.manual_vehicle_type;
    ruleForCalc = { rule_type: ruleType, ...buildManualRuleForCalc(v) };
    snap = buildManualSnap(v);
  } else {
    const vehicle = await vehRepo.findById(tenantId, v.vehicle_id, client);
    if (!vehicle || !vehicle.is_active) {
      throw apiError(404, "VEHICLE_NOT_FOUND", "Vehicle not found.", { vehicle_index: lineNumber });
    }

    const rule = await ruleRepo.findApplicable(
      tenantId,
      { ruleType, vehicleType: vehicle.vehicle_type, onDate: tripDateIso },
      client,
    );
    if (!rule) {
      throw apiError(
        400,
        "NO_APPLICABLE_PRICING_RULE",
        "No pricing rule found for this vehicle_type + rule_type on the trip date. Configure a rule in Settings → Pricing.",
        { vehicle_type: vehicle.vehicle_type, rule_type: ruleType, on_date: tripDateIso, vehicle_index: lineNumber },
      );
    }

    vehicleId = vehicle.id;
    pricingRuleId = rule.id;
    snapshotVehicleNumber = vehicle.vehicle_number;
    snapshotVehicleType = vehicle.vehicle_type;
    ruleForCalc = { rule_type: rule.rule_type, ...rule };
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

  const parkingPaise = rupeesToPaise(v.parking_rupees);
  const permitPaise = rupeesToPaise(v.permit_rupees);
  const fasttagPaise = rupeesToPaise(v.fasttag_rupees);
  const advancePaise = rupeesToPaise(v.advance_rupees);

  const { calcResult, totals } = computeTripTotals(ruleForCalc, ruleType, serviceType, billingMode, {
    totalKm: v.total_km,
    totalHours: v.total_hours,
    totalDays: v.total_days,
    tollPaise: effectiveTollPaise,
    parkingPaise,
    permitPaise,
    fasttagPaise,
    advancePaise,
  });

  return {
    lineNumber,
    vehicleId,
    driverId,
    pricingRuleId,
    pricingSource: isManual ? "MANUAL" : "FLEET",
    snapshotVehicleNumber,
    snapshotVehicleType,
    snap,
    startDatetime: v.start_datetime,
    endDatetime: v.end_datetime,
    openingKm: v.opening_km,
    closingKm: v.closing_km,
    totalKm: v.total_km,
    totalHours: v.total_hours,
    totalDays: v.total_days,
    tollPaise: effectiveTollPaise,
    parkingPaise,
    permitPaise,
    fasttagPaise,
    advancePaise,
    baseAmountPaise: totals.baseAmountPaise,
    extrasAmountPaise: totals.extrasAmountPaise,
    driverBattaPaise: totals.driverBattaPaise,
    subtotalPaise: totals.subtotalPaise,
    grossPaise: totals.grossPaise,
    netPayablePaise: totals.netPayablePaise,
    breakdown: calcResult.breakdown,
  };
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
  const tripDateObj = parseCalendarDateLocal(input.trip_date);
  const normalizedTolls = normalizeTolls(input.tolls);
  const normalizedTollsSum = normalizedTolls.reduce((sum, t) => sum + t.amountPaise, 0);

  // Step 2: Derive.
  const fiscalYear = toIndianFY(tripDateObj);
  const ruleType = deriveRuleType(serviceType, billingMode);

  // Step 3: Validate. Per-vehicle km-range/datetime-range checks (Task
  // B1 moved these fields off trip_sheets onto trip_sheet_vehicles,
  // where the same CHECK constraints now live — this loop is the
  // service-level mirror of them, same "specific apiError code beats
  // Joi's generic wrapping" reasoning the original single-vehicle
  // version of this check documented).
  input.vehicles.forEach((v, idx) => {
    if (v.opening_km !== undefined && v.closing_km !== undefined && v.closing_km < v.opening_km) {
      throw apiError(400, "INVALID_KM_RANGE", "closing_km must be >= opening_km", { vehicle_index: idx + 1 });
    }
  });

  // Sum-vs-array cross-field rule (Task 3.2), scoped to a lone vehicle
  // (the validator's own tolls.multiVehicleUnsupported check already
  // guarantees normalizedTolls is empty whenever vehicles.length > 1) —
  // see tripSheet.validator.js's createTripSheetSchema tolls comment.
  if (input.vehicles.length === 1) {
    const explicitTollPaise = rupeesToPaise(input.vehicles[0].toll_rupees);
    if (serviceType === "OUTSTATION" && normalizedTolls.length > 0 && explicitTollPaise > 0) {
      throw apiError(
        400,
        "TOLL_INPUT_CONFLICT",
        "Provide either a lump-sum toll_rupees OR an itemized tolls array — not both.",
        { toll_rupees: input.vehicles[0].toll_rupees, tolls_count: normalizedTolls.length },
      );
    }
  }

  // Steps 4 + 5: Check (DB state) + Write, as one transaction.
  return db.withTenantContext(async (client) => {
    // (a) Customer — optional as of the trip-sheets-proforma-pdf
    // migration. Three states: a real customer_id (existing path,
    // unchanged below), a free-text manual_customer_name (no lookup,
    // no GSTIN — there's no real customer record behind it), or
    // neither (both snapshot fields stay null). The validator's own
    // cross-field .custom() already resolved the "both sent" case by
    // dropping manual_customer_name in favor of customer_id, so at
    // most one of these two inputs is ever present here.
    let customerId = null;
    let snapshotCustomerName = null;
    let snapshotCustomerGstin = null;
    let manualCustomerName = null;
    if (input.customer_id) {
      const customer = await custRepo.findById(tenantId, input.customer_id, client);
      if (!customer || !customer.is_active) {
        throw apiError(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
      }
      customerId = customer.id;
      snapshotCustomerName = customer.company_name || customer.name;
      snapshotCustomerGstin = customer.gstin;
    } else if (input.manual_customer_name) {
      snapshotCustomerName = input.manual_customer_name;
      manualCustomerName = input.manual_customer_name;
    }

    // (b) Resolve + compute every vehicle in order. Each is fully
    // independent (own fleet/manual lookup, own calculator run) — a
    // failure on vehicle #3 rolls back the whole transaction, so
    // vehicles #1-2's resolution work is never partially committed.
    const resolvedVehicles = [];
    for (let idx = 0; idx < input.vehicles.length; idx++) {
      const v = input.vehicles[idx];
      const effectiveTollPaise =
        idx === 0 && input.vehicles.length === 1 && normalizedTolls.length > 0
          ? normalizedTollsSum
          : rupeesToPaise(v.toll_rupees);
      const resolved = await resolveAndComputeVehicle(
        tenantId,
        v,
        idx + 1,
        serviceType,
        billingMode,
        ruleType,
        input.trip_date,
        effectiveTollPaise,
        client,
      );
      resolvedVehicles.push(resolved);
    }

    const totalNetPayablePaise = resolvedVehicles.reduce((sum, rv) => sum + rv.netPayablePaise, 0);

    // (g) Allocate the trip sheet number.
    const tenant = await tenantRepo.findById(tenantId, client);
    const seq = await seqRepo.allocateSeq(tenantId, fiscalYear, client);
    const tripSheetNumber = tsn.format(tenant.trip_sheet_prefix, seq, tripDateObj);

    // (i) Insert the sheet, then its vehicles, then its itemized tolls
    // (if any) — all in the same transaction, so either everything
    // lands or none of it does.
    const trip = await tripRepo.insert(
      tenantId,
      {
        tripSheetNumber,
        serviceType,
        billingMode,
        customerId,
        manualCustomerName,
        snapshotCustomerName,
        snapshotCustomerGstin,
        tripDate: input.trip_date,
        bookedBy: input.booked_by,
        paxNote: input.pax_note,
        remarks: input.remarks,
        createdBy: actorUserId,
        vehicleCount: resolvedVehicles.length,
        totalNetPayablePaise,
      },
      client,
    );

    const vehicles = await vehicleLineRepo.insertBatch(tenantId, trip.id, resolvedVehicles, client);
    const tolls = await tollRepo.insertBatch(tenantId, trip.id, normalizedTolls, client);

    return { ...trip, vehicles, tolls };
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
    const vehicles = await vehicleLineRepo.listBySheet(tenantId, id, client);
    const tolls = await tollRepo.listByTrip(tenantId, id, client);
    return { ...found, vehicles, tolls };
  });
  if (!trip) {
    throw apiError(404, "TRIP_NOT_FOUND", "Trip sheet not found.");
  }
  return trip;
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
 * PATCH /trips/:tripId — editable only while a trip is DRAFT. Sheet-
 * level fields (trip_date, booked_by, pax_note, remarks) patch
 * individually as before. `vehicles`, if present, REPLACES the whole
 * array — Task B1 made each vehicle "fully self-contained", so editing
 * one means resending the full desired set; the service deletes the
 * old rows and re-resolves + recomputes every vehicle fresh (same
 * fleet/manual lookup + pure-calculator sequence createTripSheet uses),
 * not a partial merge against the old rows. `tolls` may only be patched
 * TOGETHER with `vehicles` in the same request (see the explicit check
 * below) — the itemized toll log's sum only has a defined home (a
 * SPECIFIC vehicle's toll_paise) once that vehicle set is being
 * recomputed anyway, and there's no well-defined "which existing
 * vehicle does this apply to" otherwise.
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
  const vehiclesInPatch = Object.prototype.hasOwnProperty.call(patch, "vehicles");

  // Step 2: Derive. Nothing new — FY/numbering are set once at create
  // and never revisited.

  // Step 3: Validate. Per-vehicle km-range check, mirroring
  // createTripSheet's own loop — only meaningful when vehicles are
  // actually part of this patch.
  if (vehiclesInPatch) {
    patch.vehicles.forEach((v, idx) => {
      if (v.opening_km !== undefined && v.closing_km !== undefined && v.closing_km < v.opening_km) {
        throw apiError(400, "INVALID_KM_RANGE", "closing_km must be >= opening_km", { vehicle_index: idx + 1 });
      }
    });
  }

  // Editing the itemized toll log requires knowing which vehicle its
  // sum applies to, which is only well-defined when that vehicle set is
  // being recomputed in the SAME request — see this function's own doc
  // comment.
  if (tollsInPatch && !vehiclesInPatch) {
    throw apiError(
      400,
      "TOLLS_REQUIRE_VEHICLES_PATCH",
      "Editing tolls requires resending the full vehicles array in the same request.",
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

    // Same sum-vs-array mutex as createTripSheet, scoped to a lone
    // vehicle — the effective vehicle count after this patch is
    // patch.vehicles.length whenever vehicles is being replaced
    // (tollsInPatch guarantees vehiclesInPatch is also true, per the
    // pre-transaction check above).
    if (tollsInPatch && normalizedTolls.length > 0 && patch.vehicles.length > 1) {
      throw apiError(
        400,
        "TOLLS_MULTI_VEHICLE_UNSUPPORTED",
        "Itemized toll receipts (tolls[]) are only supported for single-vehicle trips — use each vehicle's own toll_rupees instead.",
      );
    }

    // (c) Vehicles: fleet-vs-manual + per-formula rate-fields-required
    // check, using the trip's own immutable service_type/billing_mode
    // (only known now that the row is read — see
    // tripSheet.validator.js#updateTripSheetSchema's own comment on why
    // this half of the check couldn't run in Joi).
    const ruleType = deriveRuleType(trip.service_type, trip.billing_mode);
    if (vehiclesInPatch) {
      const vehicleError = findVehicleItemError(patch.vehicles, ruleType);
      if (vehicleError) {
        const messages = {
          "manual.conflict": "provide either vehicle_id (fleet) OR manual_vehicle_number/manual_vehicle_type (manual) — not both.",
          "manual.missing": "provide either vehicle_id (fleet) OR manual_vehicle_number + manual_vehicle_type (manual).",
          "manual.incomplete": "manual mode requires both manual_vehicle_number and manual_vehicle_type.",
          "manual.rateFieldsMissing": `manual mode for this service_type/billing_mode (${vehicleError.formula}) requires: ${vehicleError.missing}.`,
        };
        throw apiError(400, "INVALID_VEHICLE_ITEM", `Vehicle #${vehicleError.index + 1}: ${messages[vehicleError.code]}`, {
          vehicle_index: vehicleError.index + 1,
        });
      }
    }

    // (d) Resolve + recompute every vehicle fresh (delete-then-reinsert
    // — Part D.3's own "simpler and safe within the txn" choice), only
    // when the patch actually touches the array.
    let vehicleCountForPatch;
    let totalNetPayablePaiseForPatch;
    let newVehicleRows = null;
    if (vehiclesInPatch) {
      const normalizedTollsSum = tollsInPatch ? normalizedTolls.reduce((sum, t) => sum + t.amountPaise, 0) : 0;
      const effectiveTripDate = patch.trip_date ?? trip.trip_date;
      const resolvedVehicles = [];
      for (let idx = 0; idx < patch.vehicles.length; idx++) {
        const v = patch.vehicles[idx];
        const effectiveTollPaise =
          idx === 0 && patch.vehicles.length === 1 && tollsInPatch && normalizedTolls.length > 0
            ? normalizedTollsSum
            : rupeesToPaise(v.toll_rupees);
        const resolved = await resolveAndComputeVehicle(
          tenantId,
          v,
          idx + 1,
          trip.service_type,
          trip.billing_mode,
          ruleType,
          effectiveTripDate,
          effectiveTollPaise,
          client,
        );
        resolvedVehicles.push(resolved);
      }
      await vehicleLineRepo.deleteBySheet(tenantId, id, client);
      newVehicleRows = await vehicleLineRepo.insertBatch(tenantId, id, resolvedVehicles, client);
      vehicleCountForPatch = resolvedVehicles.length;
      totalNetPayablePaiseForPatch = resolvedVehicles.reduce((sum, rv) => sum + rv.netPayablePaise, 0);
    }

    // (e) Build the whitelisted repo patch — only genuinely-touched
    // sheet-level fields, plus vehicle_count/total_net_payable_paise as
    // a pair whenever the vehicle set was replaced.
    const patchToDb = {};
    if (patch.trip_date !== undefined) patchToDb.trip_date = patch.trip_date;
    if (patch.booked_by !== undefined) patchToDb.booked_by = patch.booked_by;
    if (patch.pax_note !== undefined) patchToDb.pax_note = patch.pax_note;
    if (patch.remarks !== undefined) patchToDb.remarks = patch.remarks;
    if (vehiclesInPatch) {
      patchToDb.vehicle_count = vehicleCountForPatch;
      patchToDb.total_net_payable_paise = totalNetPayablePaiseForPatch;
    }

    // (f) Write.
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

    // (g) Tolls: atomic delete-then-reinsert only if the patch
    // explicitly touched the array; otherwise leave the existing
    // toll rows alone and just read them back.
    let tolls;
    if (tollsInPatch) {
      await tollRepo.deleteByTrip(tenantId, id, client);
      tolls = normalizedTolls.length > 0 ? await tollRepo.insertBatch(tenantId, id, normalizedTolls, client) : [];
    } else {
      tolls = await tollRepo.listByTrip(tenantId, id, client);
    }

    // (h) Vehicles: re-read whenever this patch didn't touch them, so
    // the response always reflects the sheet's current full vehicle set.
    const vehicles = newVehicleRows ?? (await vehicleLineRepo.listBySheet(tenantId, id, client));

    // (i) Return.
    return { ...updated, vehicles, tolls };
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

    const vehicles = await vehicleLineRepo.listBySheet(tenantId, id, client);
    const tolls = await tollRepo.listByTrip(tenantId, id, client);
    return { ...updated, vehicles, tolls };
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

    const vehicles = await vehicleLineRepo.listBySheet(tenantId, id, client);
    const tolls = await tollRepo.listByTrip(tenantId, id, client);
    return { ...updated, vehicles, tolls };
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
      count_by_status: result.aggregates.count_by_status,
      sum_net_payable_rupees: formatINR(result.aggregates.sum_net_payable_paise),
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
