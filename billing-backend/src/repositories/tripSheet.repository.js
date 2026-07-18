/**
 * SQL for the `trip_sheets` table. Has FORCE ROW LEVEL SECURITY (see
 * the trip_sheets migration), so every query here MUST run on a client
 * that already has `app.current_tenant_id` set for this transaction —
 * same convention as the Module 2 repositories (vehicles/drivers/
 * customers/pricing_rules). No `pool` fallback; `client` is always a
 * client obtained via req.db.withTenantContext().
 *
 * Every enum and date column parameter gets an explicit cast
 * ($n::trip_service_type_enum, $n::trip_billing_mode_enum,
 * $n::vehicle_type_enum, $n::date) — Postgres has no implicit cast from
 * text to a custom enum type (Task 2.3 debrief).
 *
 * Every WHERE clause still includes tenant_id alongside id, even though
 * RLS already enforces it — belt and suspenders (established
 * convention since Task 1.4).
 */

const { apiError } = require("../utils/httpError");

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

/**
 * @param {string} tenantId
 * @param {object} params
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object>}
 */
async function insert(
  tenantId,
  {
    tripSheetNumber,
    serviceType,
    billingMode,
    customerId,
    vehicleId,
    driverId,
    pricingRuleId,
    snapshotVehicleNumber,
    snapshotVehicleType,
    snapshotCustomerName,
    snapshotCustomerGstin,
    snap,
    tripDate,
    startDatetime,
    endDatetime,
    openingKm,
    closingKm,
    totalKm,
    totalHours,
    totalDays,
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
    breakdown,
    bookedBy,
    paxNote,
    remarks,
    createdBy,
  },
  client,
) {
  try {
    const result = await client.query(
      `INSERT INTO trip_sheets (
         tenant_id, trip_sheet_number, service_type, billing_mode,
         customer_id, vehicle_id, driver_id, pricing_rule_id,
         snapshot_vehicle_number, snapshot_vehicle_type,
         snapshot_customer_name, snapshot_customer_gstin,
         snap_base_hours, snap_base_km, snap_base_price_paise,
         snap_extra_km_rate_paise, snap_extra_hr_rate_paise,
         snap_slab_rate_paise, snap_min_km_per_day,
         snap_driver_batta_per_day_paise, snap_per_km_rate_paise,
         snap_performance_batta_paise,
         trip_date, start_datetime, end_datetime,
         opening_km, closing_km, total_km, total_hours, total_days,
         toll_paise, parking_paise, permit_paise, fasttag_paise, advance_paise,
         base_amount_paise, extras_amount_paise, driver_batta_paise,
         subtotal_paise, gross_paise, net_payable_paise,
         breakdown, booked_by, pax_note, remarks, created_by
       )
       VALUES (
         $1, $2, $3::trip_service_type_enum, $4::trip_billing_mode_enum,
         $5, $6, $7, $8,
         $9, $10::vehicle_type_enum,
         $11, $12,
         $13, $14, $15,
         $16, $17,
         $18, $19,
         $20, $21,
         $22,
         $23::date, $24, $25,
         $26, $27, $28, $29, $30,
         $31, $32, $33, $34, $35,
         $36, $37, $38,
         $39, $40, $41,
         $42, $43, $44, $45, $46
       )
       RETURNING *`,
      [
        tenantId,
        tripSheetNumber,
        serviceType,
        billingMode,
        customerId,
        vehicleId,
        driverId || null,
        pricingRuleId || null,
        snapshotVehicleNumber,
        snapshotVehicleType,
        snapshotCustomerName,
        snapshotCustomerGstin || null,
        snap.baseHours ?? null,
        snap.baseKm ?? null,
        snap.basePricePaise ?? null,
        snap.extraKmRatePaise ?? null,
        snap.extraHrRatePaise ?? null,
        snap.slabRatePaise ?? null,
        snap.minKmPerDay ?? null,
        snap.driverBattaPerDayPaise ?? null,
        snap.perKmRatePaise ?? null,
        snap.performanceBattaPaise ?? null,
        tripDate,
        startDatetime || null,
        endDatetime || null,
        openingKm ?? null,
        closingKm ?? null,
        totalKm,
        totalHours,
        totalDays,
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
        JSON.stringify(breakdown),
        bookedBy || null,
        paxNote || null,
        remarks || null,
        createdBy || null,
      ],
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION && err.constraint === "trip_sheets_number_per_tenant_unique") {
      // Should never happen if sequence allocation works correctly —
      // this indicates a bug, not routine contention, so it's
      // surfaced clearly rather than silently retried.
      throw apiError(
        409,
        "TRIP_NUMBER_COLLISION",
        "Trip sheet number already in use. Retry.",
        { trip_sheet_number: tripSheetNumber },
      );
    }
    if (err.code === CHECK_VIOLATION) {
      if (err.constraint === "trip_sheets_km_range") {
        throw apiError(400, "INVALID_KM_RANGE", "closing_km must be >= opening_km");
      }
      if (err.constraint === "trip_sheets_datetime_range") {
        throw apiError(
          400,
          "INVALID_DATETIME_RANGE",
          "end_datetime must be >= start_datetime",
        );
      }
    }
    throw err;
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
    "SELECT * FROM trip_sheets WHERE id = $1 AND tenant_id = $2",
    [id, tenantId],
  );
  return result.rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {string} tripSheetNumber
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function findByNumber(tenantId, tripSheetNumber, client) {
  const result = await client.query(
    "SELECT * FROM trip_sheets WHERE tenant_id = $1 AND trip_sheet_number = $2",
    [tenantId, tripSheetNumber],
  );
  return result.rows[0] || null;
}

module.exports = { insert, findById, findByNumber };
