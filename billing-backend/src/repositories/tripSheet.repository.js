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

// Columns editable while a trip is DRAFT (Task 3.3#updateDraft below).
// Deliberately excludes identity/audit columns — trip_sheet_number,
// service_type, billing_mode, customer_id, vehicle_id, pricing_rule_id,
// every snapshot_*/snap_* field, tenant_id, status, and every audit
// column (created_by, created_at, finalized_*, cancelled_*,
// cancellation_reason, invoiced_at, invoice_id) can never reach this
// function no matter what a caller passes in — rate immutability
// (ADR-005) and the trip's core identity are preserved even during
// DRAFT editing. base/extras/subtotal/gross/net are listed together
// because the service always rewrites them as a group on every PATCH
// (it recomputes via the pricing engine, never patches them
// independently).
const DRAFT_UPDATABLE_COLUMNS = [
  "trip_date",
  "start_datetime",
  "end_datetime",
  "opening_km",
  "closing_km",
  "total_km",
  "total_hours",
  "total_days",
  "toll_paise",
  "parking_paise",
  "permit_paise",
  "fasttag_paise",
  "advance_paise",
  "base_amount_paise",
  "extras_amount_paise",
  "driver_batta_paise",
  "subtotal_paise",
  "gross_paise",
  "net_payable_paise",
  "breakdown",
  "booked_by",
  "pax_note",
  "remarks",
  "driver_id",
];

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

/**
 * Locks the row for the duration of the caller's transaction — the
 * concurrency-safety primitive every lifecycle transition (PATCH,
 * finalize, cancel) builds on. A concurrent transition on the same
 * trip blocks on this SELECT until the first transaction commits or
 * rolls back, so two racing requests can never both read the same
 * "current" status and both believe their transition is valid.
 *
 * `client` is REQUIRED (never defaulted) — `FOR UPDATE` outside an
 * explicit transaction holds the lock for only the instant of the
 * SELECT itself, which defeats the entire purpose of taking it.
 *
 * @param {string} tenantId
 * @param {string} id
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function findByIdForUpdate(tenantId, id, client) {
  if (!client) {
    throw new Error("findByIdForUpdate requires a client — FOR UPDATE must run inside a transaction.");
  }
  const result = await client.query(
    "SELECT * FROM trip_sheets WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
    [id, tenantId],
  );
  return result.rows[0] || null;
}

/**
 * Guarded status transition: the `AND status = $11` clause in the
 * WHERE is what makes this safe even without the caller having taken
 * a row lock first (belt-and-suspenders on top of
 * findByIdForUpdate) — if some other transaction already moved the
 * row off `fromStatus`, this UPDATE matches zero rows instead of
 * clobbering a transition it didn't know about. Callers treat a
 * `null` return (rowCount 0) as a stale-transition case, not a crash.
 *
 * @param {string} tenantId
 * @param {string} id
 * @param {string} fromStatus
 * @param {string} toStatus
 * @param {{ finalizedAt?: Date, finalizedBy?: string, cancelledAt?: Date, cancelledBy?: string, cancellationReason?: string, invoicedAt?: Date, invoiceId?: string }} auditFields
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function transitionStatus(tenantId, id, fromStatus, toStatus, auditFields, client) {
  const {
    finalizedAt,
    finalizedBy,
    cancelledAt,
    cancelledBy,
    cancellationReason,
    invoicedAt,
    invoiceId,
  } = auditFields;

  const result = await client.query(
    `UPDATE trip_sheets
     SET status = $3::trip_status_enum,
         finalized_at = COALESCE($4::timestamptz, finalized_at),
         finalized_by = COALESCE($5::uuid, finalized_by),
         cancelled_at = COALESCE($6::timestamptz, cancelled_at),
         cancelled_by = COALESCE($7::uuid, cancelled_by),
         cancellation_reason = COALESCE($8::text, cancellation_reason),
         invoiced_at = COALESCE($9::timestamptz, invoiced_at),
         invoice_id = COALESCE($10::uuid, invoice_id)
     WHERE id = $1::uuid
       AND tenant_id = $2::uuid
       AND status = $11::trip_status_enum
     RETURNING *`,
    [
      id,
      tenantId,
      toStatus,
      finalizedAt ?? null,
      finalizedBy ?? null,
      cancelledAt ?? null,
      cancelledBy ?? null,
      cancellationReason ?? null,
      invoicedAt ?? null,
      invoiceId ?? null,
      fromStatus,
    ],
  );
  return result.rows[0] || null;
}

/**
 * Updates only the whitelisted, present keys of `patch`, guarded by
 * `status = 'DRAFT'` in the WHERE — the same "guard in the WHERE, not
 * a separate check" pattern as transitionStatus above. A `null`
 * return (rowCount 0) means either the trip doesn't exist for this
 * tenant or it's no longer DRAFT; the service disambiguates those two
 * cases with its own findByIdForUpdate read earlier in the same
 * transaction; this function alone can't tell them apart.
 *
 * @param {string} tenantId
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function updateDraft(tenantId, id, patch, client) {
  const keys = Object.keys(patch).filter((key) => DRAFT_UPDATABLE_COLUMNS.includes(key));
  if (keys.length === 0) {
    throw apiError(400, "EMPTY_PATCH", "No valid fields to update.");
  }

  // $1 = id, $2 = tenantId, so column placeholders start at $3.
  const setClause = keys
    .map((key, i) => {
      const placeholder = `$${i + 3}`;
      if (key === "trip_date") return `${key} = ${placeholder}::date`;
      if (key === "start_datetime" || key === "end_datetime") return `${key} = ${placeholder}::timestamptz`;
      if (key === "breakdown") return `${key} = ${placeholder}::jsonb`;
      if (key === "driver_id") return `${key} = ${placeholder}::uuid`;
      return `${key} = ${placeholder}`;
    })
    .join(", ");
  const values = keys.map((key) => (key === "breakdown" ? JSON.stringify(patch[key]) : patch[key]));

  try {
    const result = await client.query(
      `UPDATE trip_sheets SET ${setClause}
       WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT'::trip_status_enum
       RETURNING *`,
      [id, tenantId, ...values],
    );
    return result.rows[0] || null;
  } catch (err) {
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

module.exports = {
  insert,
  findById,
  findByNumber,
  findByIdForUpdate,
  transitionStatus,
  updateDraft,
};
