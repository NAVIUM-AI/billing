/**
 * SQL for the `trip_sheet_vehicles` table (Module 5 / Task B1). Has
 * FORCE ROW LEVEL SECURITY (see the trip-sheet-vehicles migration), so
 * every query here MUST run on a client that already has
 * `app.current_tenant_id` set for this transaction — same convention as
 * tripSheet.repository.js. No `pool` fallback.
 *
 * Every enum column parameter gets an explicit cast
 * ($n::vehicle_type_enum) — Postgres has no implicit cast from text to
 * a custom enum type (Task 2.3 debrief, restated in tripSheet.repository.js).
 */

const COLUMNS_PER_ROW = 38;

/**
 * Multi-row insert — one round trip for all N vehicles of a sheet, not
 * N single-row inserts. `vehicles` is already fully shaped by the
 * service (camelCase, one entry per vehicle, in line_number order) —
 * same convention as invoiceLine.repository.js#insertBatch.
 *
 * @param {string} tenantId
 * @param {string} tripSheetId
 * @param {Array<object>} vehicles - camelCase, one per vehicle, includes `lineNumber`
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object[]>} rows, ordered by line_number
 */
async function insertBatch(tenantId, tripSheetId, vehicles, client) {
  const params = [];
  const rowPlaceholders = vehicles.map((v, idx) => {
    const base = idx * COLUMNS_PER_ROW;
    params.push(
      tenantId,
      tripSheetId,
      v.lineNumber,
      v.vehicleId || null,
      v.driverId || null,
      v.pricingRuleId || null,
      v.pricingSource || "FLEET",
      v.snapshotVehicleNumber,
      v.snapshotVehicleType,
      v.snap.baseHours ?? null,
      v.snap.baseKm ?? null,
      v.snap.basePricePaise ?? null,
      v.snap.extraKmRatePaise ?? null,
      v.snap.extraHrRatePaise ?? null,
      v.snap.slabRatePaise ?? null,
      v.snap.minKmPerDay ?? null,
      v.snap.driverBattaPerDayPaise ?? null,
      v.snap.perKmRatePaise ?? null,
      v.snap.performanceBattaPaise ?? null,
      v.startDatetime || null,
      v.endDatetime || null,
      v.openingKm ?? null,
      v.closingKm ?? null,
      v.totalKm,
      v.totalHours,
      v.totalDays,
      v.tollPaise,
      v.parkingPaise,
      v.permitPaise,
      v.fasttagPaise,
      v.advancePaise,
      v.baseAmountPaise,
      v.extrasAmountPaise,
      v.driverBattaPaise,
      v.subtotalPaise,
      v.grossPaise,
      v.netPayablePaise,
      JSON.stringify(v.breakdown),
    );
    return `(
      $${base + 1}, $${base + 2}, $${base + 3},
      $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7},
      $${base + 8}, $${base + 9}::vehicle_type_enum,
      $${base + 10}, $${base + 11}, $${base + 12},
      $${base + 13}, $${base + 14},
      $${base + 15}, $${base + 16},
      $${base + 17}, $${base + 18},
      $${base + 19},
      $${base + 20}, $${base + 21}, $${base + 22}, $${base + 23},
      $${base + 24}, $${base + 25}, $${base + 26},
      $${base + 27}, $${base + 28}, $${base + 29}, $${base + 30}, $${base + 31},
      $${base + 32}, $${base + 33}, $${base + 34},
      $${base + 35}, $${base + 36}, $${base + 37}, $${base + 38}
    )`;
  });

  const result = await client.query(
    `INSERT INTO trip_sheet_vehicles (
       tenant_id, trip_sheet_id, line_number,
       vehicle_id, driver_id, pricing_rule_id, pricing_source,
       snapshot_vehicle_number, snapshot_vehicle_type,
       snap_base_hours, snap_base_km, snap_base_price_paise,
       snap_extra_km_rate_paise, snap_extra_hr_rate_paise,
       snap_slab_rate_paise, snap_min_km_per_day,
       snap_driver_batta_per_day_paise, snap_per_km_rate_paise,
       snap_performance_batta_paise,
       start_datetime, end_datetime, opening_km, closing_km,
       total_km, total_hours, total_days,
       toll_paise, parking_paise, permit_paise, fasttag_paise, advance_paise,
       base_amount_paise, extras_amount_paise, driver_batta_paise,
       subtotal_paise, gross_paise, net_payable_paise, breakdown
     )
     VALUES ${rowPlaceholders.join(", ")}
     RETURNING *`,
    params,
  );
  return result.rows.sort((a, b) => a.line_number - b.line_number);
}

/**
 * @param {string} tenantId
 * @param {string} tripSheetId
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object[]>} rows, ordered by line_number
 */
async function listBySheet(tenantId, tripSheetId, client) {
  const result = await client.query(
    "SELECT * FROM trip_sheet_vehicles WHERE trip_sheet_id = $1 AND tenant_id = $2 ORDER BY line_number ASC",
    [tripSheetId, tenantId],
  );
  return result.rows;
}

/**
 * Bulk-hydrates vehicles for MULTIPLE sheets in one round trip — the
 * list-screen path (Part B.2 of this task: list()/listPerformanceRows()
 * need a vehicle summary per row without an N+1 query per sheet).
 *
 * @param {string} tenantId
 * @param {string[]} tripSheetIds
 * @param {import('pg').PoolClient} client
 * @returns {Promise<Map<string, object[]>>} tripSheetId -> its vehicle rows, ordered by line_number
 */
async function listBySheetIds(tenantId, tripSheetIds, client) {
  if (tripSheetIds.length === 0) {
    return new Map();
  }
  const result = await client.query(
    `SELECT * FROM trip_sheet_vehicles
     WHERE tenant_id = $1 AND trip_sheet_id = ANY($2::uuid[])
     ORDER BY trip_sheet_id, line_number ASC`,
    [tenantId, tripSheetIds],
  );
  const map = new Map();
  for (const row of result.rows) {
    if (!map.has(row.trip_sheet_id)) map.set(row.trip_sheet_id, []);
    map.get(row.trip_sheet_id).push(row);
  }
  return map;
}

/**
 * Atomic delete-then-reinsert for a sheet's whole vehicle set — same
 * pattern as tripToll.repository.js#deleteByTrip followed by
 * insertBatch, used by updateTripSheet's PATCH-replaces-the-array
 * semantics (Part D.3 of this task).
 *
 * @param {string} tenantId
 * @param {string} tripSheetId
 * @param {import('pg').PoolClient} client
 * @returns {Promise<void>}
 */
async function deleteBySheet(tenantId, tripSheetId, client) {
  await client.query(
    "DELETE FROM trip_sheet_vehicles WHERE trip_sheet_id = $1 AND tenant_id = $2",
    [tripSheetId, tenantId],
  );
}

/**
 * Sums each reimbursement column across a set of SHEETS (joins to every
 * vehicle under each sheet) — the multi-vehicle-aware replacement for
 * tripSheet.repository.js#summarizeReimbursements, which read the
 * columns directly off trip_sheets before this migration moved them to
 * the child table. Same "pure aggregate, no eligibility validation"
 * contract as the function it replaces.
 *
 * @param {string} tenantId
 * @param {string[]} tripSheetIds
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{ toll_paise: number, parking_paise: number, permit_paise: number, fasttag_paise: number }>}
 */
async function summarizeReimbursementsBySheets(tenantId, tripSheetIds, client) {
  const result = await client.query(
    `SELECT
       COALESCE(SUM(toll_paise), 0)    AS toll_paise,
       COALESCE(SUM(parking_paise), 0) AS parking_paise,
       COALESCE(SUM(permit_paise), 0)  AS permit_paise,
       COALESCE(SUM(fasttag_paise), 0) AS fasttag_paise
     FROM trip_sheet_vehicles
     WHERE tenant_id = $1
       AND trip_sheet_id = ANY($2::uuid[])`,
    [tenantId, tripSheetIds],
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
  insertBatch,
  listBySheet,
  listBySheetIds,
  deleteBySheet,
  summarizeReimbursementsBySheets,
};
