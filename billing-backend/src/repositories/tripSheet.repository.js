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

// Columns editable while a trip is DRAFT (Task 3.3#updateDraft below).
// Task B1 (multi-vehicle restructure) moved every per-vehicle field
// (usage, charges, computed totals, driver_id) off this table onto
// trip_sheet_vehicles — those are now edited via
// tripSheetVehicle.repository.js#deleteBySheet + insertBatch
// (delete-then-reinsert the whole array), not through this whitelist.
// What's left here is genuinely sheet-level: trip_date, booked_by,
// pax_note, remarks (user-editable), plus vehicle_count and
// total_net_payable_paise (written by the service as a pair, alongside
// the vehicle-array replace, never independently). Deliberately still
// excludes identity/audit columns — trip_sheet_number, service_type,
// billing_mode, customer_id, tenant_id, status, and every audit column
// — same immutability guarantee as before (ADR-005).
const DRAFT_UPDATABLE_COLUMNS = [
  "trip_date",
  "booked_by",
  "pax_note",
  "remarks",
  "vehicle_count",
  "total_net_payable_paise",
];

/**
 * Sheet-level insert only (Task B1) — the per-vehicle fields this
 * function used to take now go through
 * tripSheetVehicle.repository.js#insertBatch, called separately by the
 * service within the same transaction. `vehicleCount`/
 * `totalNetPayablePaise` are derived by the service from the vehicle
 * array it's about to insert alongside this row.
 *
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
    manualCustomerName,
    snapshotCustomerName,
    snapshotCustomerGstin,
    tripDate,
    bookedBy,
    paxNote,
    remarks,
    createdBy,
    vehicleCount,
    totalNetPayablePaise,
  },
  client,
) {
  try {
    const result = await client.query(
      `INSERT INTO trip_sheets (
         tenant_id, trip_sheet_number, service_type, billing_mode,
         customer_id, manual_customer_name,
         snapshot_customer_name, snapshot_customer_gstin,
         trip_date, booked_by, pax_note, remarks, created_by,
         vehicle_count, total_net_payable_paise
       )
       VALUES (
         $1, $2, $3::trip_service_type_enum, $4::trip_billing_mode_enum,
         $5, $6,
         $7, $8,
         $9::date, $10, $11, $12, $13,
         $14, $15
       )
       RETURNING *`,
      [
        tenantId,
        tripSheetNumber,
        serviceType,
        billingMode,
        customerId,
        manualCustomerName || null,
        snapshotCustomerName,
        snapshotCustomerGstin || null,
        tripDate,
        bookedBy || null,
        paxNote || null,
        remarks || null,
        createdBy || null,
        vehicleCount,
        totalNetPayablePaise,
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

  // $1 = id, $2 = tenantId, so column placeholders start at $3. The
  // km-range/datetime-range CHECK constraints moved to
  // trip_sheet_vehicles with the fields they guard (Task B1) — a DRAFT
  // patch to THIS table can no longer violate them, so there's nothing
  // left to catch here.
  const setClause = keys
    .map((key, i) => {
      const placeholder = `$${i + 3}`;
      if (key === "trip_date") return `${key} = ${placeholder}::date`;
      return `${key} = ${placeholder}`;
    })
    .join(", ");
  const values = keys.map((key) => patch[key]);

  const result = await client.query(
    `UPDATE trip_sheets SET ${setClause}
     WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT'::trip_status_enum
     RETURNING *`,
    [id, tenantId, ...values],
  );
  return result.rows[0] || null;
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
  // vehicle_id/driver_id moved to trip_sheet_vehicles (Task B1) — a
  // sheet matches if ANY of its vehicles has this id, expressed as an
  // EXISTS rather than a JOIN so a sheet with N matching vehicles still
  // appears exactly once.
  if (vehicleId) {
    wheres.push(
      `EXISTS (SELECT 1 FROM trip_sheet_vehicles tsv WHERE tsv.trip_sheet_id = trip_sheets.id AND tsv.vehicle_id = $${i}::uuid)`,
    );
    params.push(vehicleId);
    i++;
  }
  if (driverId) {
    wheres.push(
      `EXISTS (SELECT 1 FROM trip_sheet_vehicles tsv WHERE tsv.trip_sheet_id = trip_sheets.id AND tsv.driver_id = $${i}::uuid)`,
    );
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
  // single-trip GET only, keeping the list payload small. Per-vehicle
  // detail is no longer a sheet-level scalar (Task B1); the list row
  // gets vehicle_count plus a LATERAL-joined summary of vehicle #1
  // (line_number = 1) — "count + first vehicle" is the Part B.2
  // decision for the list screen (full per-vehicle detail is
  // GET /trips/:id only). sum_total_km sums across every vehicle on the
  // sheet, for parity with the pre-restructure single-vehicle total_km
  // column.
  const dataParams = [...params, limit, offset];
  const dataResult = await client.query(
    `SELECT
       trip_sheets.id, trip_sheets.tenant_id, trip_sheets.trip_sheet_number,
       trip_sheets.service_type, trip_sheets.billing_mode, trip_sheets.status,
       trip_sheets.customer_id,
       trip_sheets.snapshot_customer_name,
       trip_sheets.snapshot_customer_gstin,
       trip_sheets.trip_date,
       trip_sheets.vehicle_count,
       trip_sheets.total_net_payable_paise,
       trip_sheets.finalized_at, trip_sheets.cancelled_at,
       trip_sheets.invoice_id,
       trip_sheets.created_at, trip_sheets.updated_at,
       fv.vehicle_id       AS first_vehicle_id,
       fv.vehicle_number   AS first_vehicle_number,
       fv.vehicle_type     AS first_vehicle_type,
       fv.pricing_source   AS first_vehicle_pricing_source,
       COALESCE(agg.sum_total_km, 0)::integer AS sum_total_km
     FROM trip_sheets
     LEFT JOIN LATERAL (
       SELECT tsv.vehicle_id, tsv.snapshot_vehicle_number AS vehicle_number,
              tsv.snapshot_vehicle_type AS vehicle_type, tsv.pricing_source
       FROM trip_sheet_vehicles tsv
       WHERE tsv.trip_sheet_id = trip_sheets.id AND tsv.line_number = 1
     ) fv ON true
     LEFT JOIN LATERAL (
       SELECT SUM(tsv2.total_km) AS sum_total_km
       FROM trip_sheet_vehicles tsv2
       WHERE tsv2.trip_sheet_id = trip_sheets.id
     ) agg ON true
     WHERE ${whereClause}
     ${orderBy}
     LIMIT $${i} OFFSET $${i + 1}`,
    dataParams,
  );

  // (B) Aggregates query — same WHERE array (trimmed to the pre-LIMIT
  // params), no sort/paging. Reusing `wheres`/`params` rather than a
  // second hand-written WHERE clause is deliberate: copy-pasting the
  // clause into two strings creates drift the moment a new filter is
  // added to one but not the other. gross_paise had no sheet-level
  // equivalent after the restructure (it was always per-vehicle) — its
  // aggregate is dropped rather than fabricated; sum_net_payable_paise
  // now sums the sheet-level total_net_payable_paise column.
  const aggResult = await client.query(
    `SELECT
       COUNT(*)::bigint AS total_count,
       COALESCE(SUM(total_net_payable_paise), 0)::bigint AS sum_net_payable_paise,
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
  trip_date: "t.trip_date",
  total_km: "tsv.total_km",
  net_payable_paise: "tsv.net_payable_paise",
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
 * Task B1: now joins trip_sheet_vehicles (INNER — a trip sheet always
 * has >=1 vehicle) instead of reading vehicle/usage/cost columns
 * straight off trip_sheets. This means a multi-vehicle PERFORMANCE trip
 * now contributes ONE ROW PER VEHICLE, each with its own vehicle/cost
 * detail and the SAME trip_id repeated across its rows — the correct
 * behavior for a cost ledger (each vehicle's running cost is a real,
 * distinct line), and performanceSheet.service.js's own grouping/sum
 * logic is already generic over `row.*` fields, so it needs no changes
 * to handle multiple rows sharing a trip_id.
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
    wheres.push(`tsv.vehicle_id = $${i}::uuid`);
    params.push(vehicleId);
    i++;
  }
  if (driverId) {
    wheres.push(`tsv.driver_id = $${i}::uuid`);
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
  // customers always sorts predictably); tertiary by (t.id, tsv.line_number)
  // breaks any remaining tie deterministically, including between the
  // multiple rows a single multi-vehicle trip now contributes.
  const orderBy = `ORDER BY ${orderCol} ${orderDir}, customer_display_name ASC, t.id ASC, tsv.line_number ASC`;

  // Fetch maxRows + 1 so we can detect truncation without a second
  // COUNT(*) round-trip: if we get back maxRows+1 rows, there were more
  // than maxRows matches and the extra row is dropped before returning.
  params.push(maxRows + 1);
  const result = await client.query(
    `SELECT
       t.id                       AS trip_id,
       t.trip_date                AS trip_date,
       tsv.snapshot_vehicle_type    AS vehicle_type,
       tsv.snapshot_vehicle_number  AS vehicle_number,
       tsv.total_km                 AS total_running_km,
       COALESCE(tsv.snap_per_km_rate_paise, 0) AS per_km_rate_paise,
       tsv.base_amount_paise        AS running_cost_paise,
       tsv.driver_batta_paise       AS batta_paise,
       tsv.toll_paise               AS toll_paise,
       tsv.net_payable_paise        AS total_paise,
       t.status                   AS status,
       t.customer_id              AS customer_id,
       COALESCE(c.company_name, c.name, '') AS customer_display_name,
       c.customer_type            AS customer_type
     FROM trip_sheets t
     JOIN trip_sheet_vehicles tsv
       ON tsv.trip_sheet_id = t.id AND tsv.tenant_id = t.tenant_id
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
 * Task B1 / Part G: `AND vehicle_count = 1` — the GST invoice engine
 * only knows how to fan a trip into ONE invoice_line per sheet
 * (invoice.service.js#buildInvoiceLines); a multi-vehicle trip is
 * EXCLUDED here at the source rather than reaching the picker and
 * risking a silent under-bill. B2 (a separate, later task) is what
 * teaches the invoice engine to fan a trip into N lines — until then
 * this filter is the enforcement point. Because only single-vehicle
 * sheets reach this query, the INNER JOIN's `line_number = 1` always
 * resolves to that sheet's one and only vehicle.
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
       t.id, t.trip_sheet_number, t.service_type, t.billing_mode, t.trip_date,
       tsv.snapshot_vehicle_number, tsv.snapshot_vehicle_type,
       tsv.total_km, tsv.total_hours, tsv.total_days,
       tsv.base_amount_paise, tsv.extras_amount_paise, tsv.driver_batta_paise,
       tsv.toll_paise, tsv.parking_paise, tsv.permit_paise, tsv.fasttag_paise,
       tsv.advance_paise,
       tsv.subtotal_paise, tsv.gross_paise, tsv.net_payable_paise,
       t.held_by_invoice_id,
       t.created_at
     FROM trip_sheets t
     JOIN trip_sheet_vehicles tsv
       ON tsv.trip_sheet_id = t.id AND tsv.tenant_id = t.tenant_id AND tsv.line_number = 1
     WHERE t.tenant_id = $1::uuid
       AND t.customer_id = $2::uuid
       AND t.status = 'FINALIZED'::trip_status_enum
       AND t.vehicle_count = 1
       AND (t.held_by_invoice_id IS NULL OR t.held_by_invoice_id = $3::uuid)
     ORDER BY t.trip_date ASC, t.id ASC`,
    [tenantId, customerId, excludeInvoiceId || null],
  );
  return result.rows;
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
  reverseInvoiced,
};
