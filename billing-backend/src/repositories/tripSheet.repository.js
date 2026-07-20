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
 * Task 4.3: reverses an invoice-issue trip transition — INVOICED back
 * to FINALIZED, on invoice cancellation. Deliberately NOT built on top
 * of transitionStatus: that function's invoiced_at/invoice_id columns
 * use COALESCE (`COALESCE($9::timestamptz, invoiced_at)`), which can
 * only ever ADD a value, never CLEAR one back to null — passing null
 * there is indistinguishable from "leave it alone". Reversal is the one
 * case that genuinely needs to erase both fields, so it gets its own
 * guarded statement rather than overloading transitionStatus's
 * contract (and risking a regression in every other caller that
 * correctly relies on COALESCE's "don't touch what you didn't pass"
 * behavior).
 *
 * @param {string} tenantId
 * @param {string} id
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function reverseInvoiced(tenantId, id, client) {
  const result = await client.query(
    `UPDATE trip_sheets
     SET status = 'FINALIZED'::trip_status_enum,
         invoiced_at = NULL,
         invoice_id = NULL
     WHERE id = $1::uuid
       AND tenant_id = $2::uuid
       AND status = 'INVOICED'::trip_status_enum
     RETURNING *`,
    [id, tenantId],
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

// Sort column whitelist — hardcoded here as defense in depth on top of
// the validator's own `.valid(...)` whitelist (tripSheet.validator.js's
// listTripsQuerySchema). No user input is ever interpolated into SQL;
// only these pre-validated literal strings are.
const SORT_WHITELIST = {
  trip_date: "trip_date",
  created_at: "created_at",
  total_km: "total_km",
  net_payable_paise: "net_payable_paise",
};

/**
 * Composes WHERE dynamically from pre-validated service inputs. All enum
 * params get explicit casts (Rule 1). Sort column is whitelisted at both
 * the validator (Rule 6, fail early) AND here in the repo (defense in
 * depth) — never interpolate user strings into ORDER BY.
 *
 * @param {string} tenantId
 * @param {{ limit: number, offset: number, customerId: ?string, vehicleId: ?string, driverId: ?string, fromDate: ?string, toDate: ?string, statusIn: ?string[], serviceType: ?string, billingMode: ?string, searchOriginal: ?string, sortBy: string, sortDir: string, includeCancelled: boolean }} params
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{ rows: object[], total_count: number, aggregates: object }>}
 */
async function list(
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
) {
  const wheres = ["tenant_id = $1::uuid"];
  const params = [tenantId];
  let i = 2;

  if (customerId) {
    wheres.push(`customer_id = $${i}::uuid`);
    params.push(customerId);
    i++;
  }
  if (vehicleId) {
    wheres.push(`vehicle_id = $${i}::uuid`);
    params.push(vehicleId);
    i++;
  }
  if (driverId) {
    wheres.push(`driver_id = $${i}::uuid`);
    params.push(driverId);
    i++;
  }
  if (fromDate) {
    wheres.push(`trip_date >= $${i}::date`);
    params.push(fromDate);
    i++;
  }
  if (toDate) {
    wheres.push(`trip_date <= $${i}::date`);
    params.push(toDate);
    i++;
  }

  // Status handling — explicit multi-value filter overrides the
  // includeCancelled default; otherwise fall back to excluding CANCELLED
  // unless the caller asked to includeCancelled.
  if (statusIn && statusIn.length > 0) {
    wheres.push(`status = ANY($${i}::trip_status_enum[])`);
    params.push(statusIn);
    i++;
  } else if (!includeCancelled) {
    wheres.push(`status <> 'CANCELLED'::trip_status_enum`);
  }

  if (serviceType) {
    wheres.push(`service_type = $${i}::trip_service_type_enum`);
    params.push(serviceType);
    i++;
  }
  if (billingMode) {
    wheres.push(`billing_mode = $${i}::trip_billing_mode_enum`);
    params.push(billingMode);
    i++;
  }

  // Search: substring match on trip_sheet_number and the snapshot
  // customer name column. snapshot_customer_gstin is intentionally NOT
  // searched here — GSTIN search belongs in the customers list, not
  // trips list. Only one $ placeholder needed since the same parameter
  // is reused twice in the OR.
  if (searchOriginal) {
    wheres.push(
      `(trip_sheet_number ILIKE '%' || $${i} || '%' OR snapshot_customer_name ILIKE '%' || $${i} || '%')`,
    );
    params.push(searchOriginal);
    i++;
  }

  const whereClause = wheres.join(" AND ");

  const orderCol = SORT_WHITELIST[sortBy];
  if (!orderCol) {
    // Reaching here means the validator's whitelist was bypassed
    // somehow — a bug, not user input, so a plain Error (not apiError)
    // is correct: this should 500, loudly, not be treated as a 4xx.
    throw new Error(`Unsupported sortBy column: ${sortBy}`);
  }
  if (sortDir !== "asc" && sortDir !== "desc") {
    throw new Error(`Unsupported sortDir: ${sortDir}`);
  }
  const orderDir = sortDir.toUpperCase() === "ASC" ? "ASC" : "DESC";
  // Secondary sort by id ensures stable ordering when the primary sort
  // has ties (multiple trips on the same date, for example).
  const orderBy = `ORDER BY ${orderCol} ${orderDir}, id ASC`;

  // (A) Data query — same WHERE, with sort + paging. Deliberately omits
  // breakdown (large JSONB), snap_* fields, and tolls — those are
  // single-trip GET only, keeping the list payload small.
  const dataParams = [...params, limit, offset];
  const dataResult = await client.query(
    `SELECT
       id, tenant_id, trip_sheet_number,
       service_type, billing_mode, status,
       customer_id, vehicle_id, driver_id,
       snapshot_vehicle_number,
       snapshot_vehicle_type,
       snapshot_customer_name,
       snapshot_customer_gstin,
       trip_date, total_km, total_hours,
       total_days,
       subtotal_paise, gross_paise,
       net_payable_paise,
       advance_paise,
       finalized_at, cancelled_at,
       invoice_id,
       created_at, updated_at
     FROM trip_sheets
     WHERE ${whereClause}
     ${orderBy}
     LIMIT $${i} OFFSET $${i + 1}`,
    dataParams,
  );

  // (B) Aggregates query — same WHERE array (trimmed to the pre-LIMIT
  // params), no sort/paging. Reusing `wheres`/`params` rather than a
  // second hand-written WHERE clause is deliberate: copy-pasting the
  // clause into two strings creates drift the moment a new filter is
  // added to one but not the other.
  const aggResult = await client.query(
    `SELECT
       COUNT(*)::bigint AS total_count,
       COALESCE(SUM(net_payable_paise), 0)::bigint AS sum_net_payable_paise,
       COALESCE(SUM(gross_paise), 0)::bigint AS sum_gross_paise,
       COALESCE(COUNT(*) FILTER (WHERE status = 'DRAFT'::trip_status_enum), 0)::bigint AS count_draft,
       COALESCE(COUNT(*) FILTER (WHERE status = 'FINALIZED'::trip_status_enum), 0)::bigint AS count_finalized,
       COALESCE(COUNT(*) FILTER (WHERE status = 'INVOICED'::trip_status_enum), 0)::bigint AS count_invoiced,
       COALESCE(COUNT(*) FILTER (WHERE status = 'CANCELLED'::trip_status_enum), 0)::bigint AS count_cancelled
     FROM trip_sheets
     WHERE ${whereClause}`,
    params,
  );
  const agg = aggResult.rows[0];

  return {
    rows: dataResult.rows,
    total_count: Number(agg.total_count),
    aggregates: {
      sum_net_payable_paise: Number(agg.sum_net_payable_paise),
      sum_gross_paise: Number(agg.sum_gross_paise),
      count_by_status: {
        DRAFT: Number(agg.count_draft),
        FINALIZED: Number(agg.count_finalized),
        INVOICED: Number(agg.count_invoiced),
        CANCELLED: Number(agg.count_cancelled),
      },
    },
  };
}

// Sort whitelist for the performance sheet — deliberately a SUBSET of
// list()'s SORT_WHITELIST (no created_at): the sheet is date-sequenced,
// not a general ledger view. Mirrors performanceSheetQuerySchema's own
// PERF_SORT_BY_VALUES whitelist (defense in depth, same pattern as
// list()/SORT_WHITELIST above).
const PERF_SORT_WHITELIST = {
  trip_date: "trip_date",
  total_km: "total_km",
  net_payable_paise: "net_payable_paise",
};

/**
 * Performance-sheet projection query: the Blue UI table over
 * billing_mode='PERFORMANCE' trips, joined to customers for the
 * CURRENT display name (this is a display sheet, not an invoice — an
 * up-to-date name is more useful for ops than the trip's frozen
 * snapshot name). Repo does NO grouping and NO CSV formatting — both
 * are the service's job (performanceSheet.service.js); this function
 * stays pure SQL composition, same convention as list() above.
 *
 * billing_mode = 'PERFORMANCE' is ALWAYS applied and cannot be
 * overridden by any caller-supplied filter — it's the fixed definition
 * of what a performance sheet is.
 *
 * @param {string} tenantId
 * @param {{ customerId: ?string, vehicleId: ?string, driverId: ?string, fromDate: ?string, toDate: ?string, serviceType: ?string, statusIn: ?string[], includeCancelled: boolean, sortBy: string, sortDir: string, maxRows: number }} params
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{ rows: object[], truncated: boolean }>}
 */
async function listPerformanceRows(
  tenantId,
  { customerId, vehicleId, driverId, fromDate, toDate, serviceType, statusIn, includeCancelled, sortBy, sortDir, maxRows },
  client,
) {
  const wheres = ["t.tenant_id = $1::uuid", "t.billing_mode = 'PERFORMANCE'::trip_billing_mode_enum"];
  const params = [tenantId];
  let i = 2;

  if (customerId) {
    wheres.push(`t.customer_id = $${i}::uuid`);
    params.push(customerId);
    i++;
  }
  if (vehicleId) {
    wheres.push(`t.vehicle_id = $${i}::uuid`);
    params.push(vehicleId);
    i++;
  }
  if (driverId) {
    wheres.push(`t.driver_id = $${i}::uuid`);
    params.push(driverId);
    i++;
  }
  if (fromDate) {
    wheres.push(`t.trip_date >= $${i}::date`);
    params.push(fromDate);
    i++;
  }
  if (toDate) {
    wheres.push(`t.trip_date <= $${i}::date`);
    params.push(toDate);
    i++;
  }

  if (statusIn && statusIn.length > 0) {
    wheres.push(`t.status = ANY($${i}::trip_status_enum[])`);
    params.push(statusIn);
    i++;
  } else if (!includeCancelled) {
    wheres.push(`t.status <> 'CANCELLED'::trip_status_enum`);
  }

  if (serviceType) {
    wheres.push(`t.service_type = $${i}::trip_service_type_enum`);
    params.push(serviceType);
    i++;
  }

  const whereClause = wheres.join(" AND ");

  const orderCol = PERF_SORT_WHITELIST[sortBy];
  if (!orderCol) {
    throw new Error(`Unsupported sortBy column: ${sortBy}`);
  }
  if (sortDir !== "asc" && sortDir !== "desc") {
    throw new Error(`Unsupported sortDir: ${sortDir}`);
  }
  const orderDir = sortDir.toUpperCase() === "ASC" ? "ASC" : "DESC";
  // Secondary sort by customer_display_name keeps group boundaries
  // stable when the primary sort ties (same trip_date across two
  // customers always sorts predictably); tertiary by id breaks any
  // remaining tie deterministically.
  const orderBy = `ORDER BY t.${orderCol} ${orderDir}, customer_display_name ASC, t.id ASC`;

  // Fetch maxRows + 1 so we can detect truncation without a second
  // COUNT(*) round-trip: if we get back maxRows+1 rows, there were more
  // than maxRows matches and the extra row is dropped before returning.
  params.push(maxRows + 1);
  const result = await client.query(
    `SELECT
       t.id                       AS trip_id,
       t.trip_date                AS trip_date,
       t.snapshot_vehicle_type    AS vehicle_type,
       t.snapshot_vehicle_number  AS vehicle_number,
       t.total_km                 AS total_running_km,
       COALESCE(t.snap_per_km_rate_paise, 0) AS per_km_rate_paise,
       t.base_amount_paise        AS running_cost_paise,
       t.driver_batta_paise       AS batta_paise,
       t.toll_paise               AS toll_paise,
       t.net_payable_paise        AS total_paise,
       t.status                   AS status,
       t.customer_id              AS customer_id,
       COALESCE(c.company_name, c.name, '') AS customer_display_name,
       c.customer_type            AS customer_type
     FROM trip_sheets t
     LEFT JOIN customers c
       ON c.id = t.customer_id
       AND c.tenant_id = t.tenant_id
     WHERE ${whereClause}
     ${orderBy}
     LIMIT $${i}`,
    params,
  );

  const truncated = result.rows.length > maxRows;
  return {
    rows: truncated ? result.rows.slice(0, maxRows) : result.rows,
    truncated,
  };
}

/**
 * Task 4.1: trips eligible to be added to an invoice — FINALIZED and
 * either unheld or already held by the SAME draft being edited.
 * `excludeInvoiceId` lets PATCH re-fetch a draft's own currently-held
 * trips alongside newly-requested ones (pass null on initial create,
 * when no invoice exists yet to exempt).
 *
 * @param {string} tenantId
 * @param {string[]} tripIds
 * @param {?string} excludeInvoiceId
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object[]>}
 */
async function findFinalizedAndUnheld(tenantId, tripIds, excludeInvoiceId, client) {
  const result = await client.query(
    `SELECT * FROM trip_sheets
     WHERE tenant_id = $1::uuid
       AND id = ANY($2::uuid[])
       AND status = 'FINALIZED'::trip_status_enum
       AND (held_by_invoice_id IS NULL OR held_by_invoice_id = $3::uuid)`,
    [tenantId, tripIds, excludeInvoiceId || null],
  );
  return result.rows;
}

/**
 * @param {string} tenantId
 * @param {string[]} tripIds
 * @param {string} invoiceId
 * @param {import('pg').PoolClient} client
 * @returns {Promise<void>}
 */
async function setHold(tenantId, tripIds, invoiceId, client) {
  await client.query(
    `UPDATE trip_sheets
     SET held_by_invoice_id = $3::uuid
     WHERE tenant_id = $1::uuid
       AND id = ANY($2::uuid[])
       AND status = 'FINALIZED'::trip_status_enum`,
    [tenantId, tripIds, invoiceId],
  );
}

/**
 * @param {string} tenantId
 * @param {string} invoiceId
 * @param {import('pg').PoolClient} client
 * @returns {Promise<void>}
 */
async function releaseHold(tenantId, invoiceId, client) {
  await client.query(
    `UPDATE trip_sheets
     SET held_by_invoice_id = NULL
     WHERE tenant_id = $1::uuid
       AND held_by_invoice_id = $2::uuid`,
    [tenantId, invoiceId],
  );
}

/**
 * Task 4.2: lean picker view for "which of this customer's trips can I
 * invoice right now" — FINALIZED and either unheld or held by the
 * invoice currently being edited (same `excludeInvoiceId` convention as
 * findFinalizedAndUnheld). Ordered chronologically ascending, not by
 * relevance — this is a checklist an ops person scans month by month,
 * not a search result.
 *
 * @param {string} tenantId
 * @param {string} customerId
 * @param {?string} excludeInvoiceId
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object[]>}
 */
async function findInvoiceableForCustomer(tenantId, customerId, excludeInvoiceId, client) {
  const result = await client.query(
    `SELECT
       id, trip_sheet_number, service_type, billing_mode, trip_date,
       snapshot_vehicle_number, snapshot_vehicle_type,
       total_km, total_hours, total_days,
       base_amount_paise, extras_amount_paise, driver_batta_paise,
       toll_paise, parking_paise, permit_paise, fasttag_paise,
       advance_paise,
       subtotal_paise, gross_paise, net_payable_paise,
       held_by_invoice_id,
       created_at
     FROM trip_sheets
     WHERE tenant_id = $1::uuid
       AND customer_id = $2::uuid
       AND status = 'FINALIZED'::trip_status_enum
       AND (held_by_invoice_id IS NULL OR held_by_invoice_id = $3::uuid)
     ORDER BY trip_date ASC, id ASC`,
    [tenantId, customerId, excludeInvoiceId || null],
  );
  return result.rows;
}

/**
 * Sums each reimbursement column across a set of trips — the data
 * source for invoice.service.js#computeEffectiveReimbursements'
 * auto-sum. Deliberately does NOT validate that the trips are
 * FINALIZED/unheld/belong to this customer — that's
 * resolveTripsForInvoice's job; this is a pure aggregate over whatever
 * ids it's given, safe to call even mid-validation since a bad id just
 * contributes 0.
 *
 * @param {string} tenantId
 * @param {string[]} tripIds
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{ toll_paise: number, parking_paise: number, permit_paise: number, fasttag_paise: number }>}
 */
async function summarizeReimbursements(tenantId, tripIds, client) {
  const result = await client.query(
    `SELECT
       COALESCE(SUM(toll_paise), 0)    AS toll_paise,
       COALESCE(SUM(parking_paise), 0) AS parking_paise,
       COALESCE(SUM(permit_paise), 0)  AS permit_paise,
       COALESCE(SUM(fasttag_paise), 0) AS fasttag_paise
     FROM trip_sheets
     WHERE tenant_id = $1::uuid
       AND id = ANY($2::uuid[])`,
    [tenantId, tripIds],
  );
  const row = result.rows[0];
  return {
    toll_paise: Number(row.toll_paise) || 0,
    parking_paise: Number(row.parking_paise) || 0,
    permit_paise: Number(row.permit_paise) || 0,
    fasttag_paise: Number(row.fasttag_paise) || 0,
  };
}

module.exports = {
  insert,
  findById,
  findByNumber,
  findByIdForUpdate,
  transitionStatus,
  updateDraft,
  list,
  listPerformanceRows,
  findFinalizedAndUnheld,
  setHold,
  releaseHold,
  findInvoiceableForCustomer,
  summarizeReimbursements,
  reverseInvoiced,
};
