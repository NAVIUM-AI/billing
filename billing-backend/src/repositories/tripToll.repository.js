/**
 * SQL for the `trip_tolls` table. Has FORCE ROW LEVEL SECURITY (see the
 * trip_tolls migration), so every query here MUST run on a client that
 * already has `app.current_tenant_id` set for this transaction — same
 * convention as tripSheet.repository.js and the rest of the Module 2/3
 * repositories. No `pool` fallback.
 *
 * Tolls are append-only in this task (Task 3.2): no update path, no
 * delete path except cascade-with-parent (ON DELETE CASCADE on
 * trip_sheet_id). PATCH support ships in Task 3.3 alongside draft trip
 * editing.
 */

const COLUMNS_PER_ROW = 10;

/**
 * Inserts every toll receipt for a trip in a single multi-row INSERT —
 * atomic (all rows land or none do) and avoids N round-trips for what
 * is, in practice, a single logical write (the trip's full toll list).
 * `client` is REQUIRED (never defaulted to `pool`) because this always
 * runs inside the same transaction as the parent trip_sheets insert —
 * see tripSheet.service.js#createTripSheet.
 *
 * @param {string} tenantId
 * @param {string} tripSheetId
 * @param {Array<{ plazaName: string, tollId?: string|null, amountPaise: number, crossedAt?: string|null, vehicleNumber?: string|null, closingBalancePaise?: number|null, notes?: string|null, lineNumber: number }>} receipts
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object[]>}
 */
async function insertBatch(tenantId, tripSheetId, receipts, client) {
  if (receipts.length === 0) {
    return [];
  }

  const values = [];
  const rowPlaceholders = receipts.map((r, i) => {
    const base = i * COLUMNS_PER_ROW;
    values.push(
      tripSheetId,
      tenantId,
      r.plazaName,
      r.tollId ?? null,
      r.amountPaise,
      r.crossedAt ?? null,
      r.vehicleNumber ?? null,
      r.closingBalancePaise ?? null,
      r.notes ?? null,
      r.lineNumber,
    );
    return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`;
  });

  const result = await client.query(
    `INSERT INTO trip_tolls (
       trip_sheet_id, tenant_id, plaza_name, toll_id, amount_paise,
       crossed_at, vehicle_number, closing_balance_paise, notes, line_number
     )
     VALUES ${rowPlaceholders.join(", ")}
     RETURNING *`,
    values,
  );
  return result.rows;
}

/**
 * @param {string} tenantId
 * @param {string} tripSheetId
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object[]>}
 */
async function listByTrip(tenantId, tripSheetId, client) {
  const result = await client.query(
    "SELECT * FROM trip_tolls WHERE trip_sheet_id = $1 AND tenant_id = $2 ORDER BY line_number",
    [tripSheetId, tenantId],
  );
  return result.rows;
}

module.exports = { insertBatch, listByTrip };
