/**
 * SQL for the `invoice_lines` table. Same RLS/client/cast conventions as
 * invoice.repository.js — see that file's top-of-file comment.
 */

const { apiError } = require("../utils/httpError");

const UNIQUE_VIOLATION = "23505";

const COLUMNS_PER_LINE = 17;

/**
 * Multi-row insert — one round trip for the whole line set, not N
 * single-row inserts. `lines` is already fully shaped by the service
 * (camelCase, one entry per trip, in invoice order).
 *
 * @param {string} tenantId
 * @param {string} invoiceId
 * @param {Array<{ tripSheetId: string, lineNumber: number, serviceType: string, tripDate: string, vehicleNumber: string, vehicleType: string, totalKm: number, totalHours: ?number, totalDays: ?number, baseAmountPaise: number, extrasAmountPaise: number, driverBattaPaise: number, lineAmountPaise: number, hsnSacCode: string, description: string }>} lines
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object[]>}
 */
async function insertBatch(tenantId, invoiceId, lines, client) {
  const params = [];
  const rowPlaceholders = lines.map((line, idx) => {
    const base = idx * COLUMNS_PER_LINE;
    params.push(
      tenantId,
      invoiceId,
      line.tripSheetId,
      line.lineNumber,
      line.serviceType,
      line.tripDate,
      line.vehicleNumber,
      line.vehicleType,
      line.totalKm,
      line.totalHours ?? null,
      line.totalDays ?? null,
      line.baseAmountPaise,
      line.extrasAmountPaise,
      line.driverBattaPaise,
      line.lineAmountPaise,
      line.hsnSacCode,
      line.description || null,
    );
    return `(
      $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4},
      $${base + 5}::trip_service_type_enum, $${base + 6}::date,
      $${base + 7}, $${base + 8}::vehicle_type_enum,
      $${base + 9}, $${base + 10}, $${base + 11},
      $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15},
      $${base + 16}, $${base + 17}
    )`;
  });

  try {
    const result = await client.query(
      `INSERT INTO invoice_lines (
         tenant_id, invoice_id, trip_sheet_id, line_number,
         service_type, trip_date,
         vehicle_number, vehicle_type,
         total_km, total_hours, total_days,
         base_amount_paise, extras_amount_paise, driver_batta_paise, line_amount_paise,
         hsn_sac_code, description
       )
       VALUES ${rowPlaceholders.join(", ")}
       RETURNING *`,
      params,
    );
    return result.rows;
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION && err.constraint === "invoice_lines_trip_per_invoice_unique") {
      throw apiError(409, "TRIP_ALREADY_ON_INVOICE", "One or more trips are already on this invoice.");
    }
    throw err;
  }
}

/**
 * @param {string} tenantId
 * @param {string} invoiceId
 * @param {import('pg').PoolClient} client
 * @returns {Promise<void>}
 */
async function deleteByInvoice(tenantId, invoiceId, client) {
  await client.query("DELETE FROM invoice_lines WHERE invoice_id = $1 AND tenant_id = $2", [invoiceId, tenantId]);
}

/**
 * @param {string} tenantId
 * @param {string} invoiceId
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object[]>}
 */
async function listByInvoice(tenantId, invoiceId, client) {
  const result = await client.query(
    "SELECT * FROM invoice_lines WHERE invoice_id = $1 AND tenant_id = $2 ORDER BY line_number ASC",
    [invoiceId, tenantId],
  );
  return result.rows;
}

/**
 * Same rows as listByInvoice, plus a handful of columns from the
 * parent trip sheet that the PDF layout needs but invoice_lines never
 * denormalized onto itself:
 *   - trip_sheet_number (Task 4.5) — the human-readable sheet number.
 *   - snap_base_km/snap_base_hours/snap_extra_km_rate_paise/
 *     snap_extra_hr_rate_paise (Task 4.7) — the LOCAL_PACKAGE rule
 *     snapshot already frozen onto the trip at creation (Task 3.x).
 *     invoice_lines.extras_amount_paise only stores the combined
 *     extra-KM + extra-hours amount; these let the PDF re-derive the
 *     same split the original calculator (src/domain/pricing/local.js)
 *     produced, without re-running any pricing logic here.
 *   - snap_slab_rate_paise (Task 4.7) — the OUTSTATION_SLAB rate,
 *     shown as-is instead of back-deriving base_amount_paise/total_km
 *     (which drifts from the true rate whenever min_km_per_day floors
 *     billable_km above actual total_km).
 *   - toll_paise (Task 4.7) — per-trip toll, real column on
 *     trip_sheets, currently only ever summed at the invoice level
 *     (invoices.toll_paise). Reference invoices (PTT-150/151) show a
 *     per-line Toll/Parking column, which this makes possible without
 *     inventing any figure that isn't already stored.
 *   - parking_paise (Task 4.7) — same reasoning, combined with
 *     toll_paise into the LOCAL template's single "Toll / Parking"
 *     column (matching PTT-150's exact column label).
 *   - booked_by (Task 4.7) — real, user-settable field
 *     (tripSheet.validator.js), shown in the Service Details block.
 *
 * None of this is a schema change — every one of these columns already
 * existed on trip_sheets; this just widens the JOIN that already
 * existed for trip_sheet_number.
 *
 * @param {string} tenantId
 * @param {string} invoiceId
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object[]>}
 */
async function listByInvoiceForPdf(tenantId, invoiceId, client) {
  const result = await client.query(
    `SELECT il.*, ts.trip_sheet_number, ts.booked_by,
            ts.snap_base_km, ts.snap_base_hours,
            ts.snap_extra_km_rate_paise, ts.snap_extra_hr_rate_paise,
            ts.snap_slab_rate_paise,
            ts.toll_paise, ts.parking_paise
     FROM invoice_lines il
     JOIN trip_sheets ts ON ts.id = il.trip_sheet_id AND ts.tenant_id = il.tenant_id
     WHERE il.invoice_id = $1 AND il.tenant_id = $2
     ORDER BY il.line_number ASC`,
    [invoiceId, tenantId],
  );
  return result.rows;
}

/**
 * @param {string} tenantId
 * @param {string} invoiceId
 * @param {string} lineId
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function findById(tenantId, invoiceId, lineId, client) {
  const result = await client.query(
    "SELECT * FROM invoice_lines WHERE tenant_id = $1 AND invoice_id = $2 AND id = $3",
    [tenantId, invoiceId, lineId],
  );
  return result.rows[0] || null;
}

// Just description for now (Task 4.2) — line_amount and every
// trip-derived field are intentionally NOT here, since they're
// snapshotted from the trip at line-creation time, not user-editable.
const LINE_UPDATABLE_COLUMNS = ["description"];

/**
 * Guarded by an EXISTS check that the parent invoice is still DRAFT —
 * belt-and-suspenders on top of the service's own pre-check
 * (findByIdForUpdate + status check), same "guard in the WHERE" pattern
 * as invoice.repository.js#updateDraft. The EXISTS subquery correlates
 * via the bound $1/$2 params rather than by referencing
 * invoice_lines.tenant_id/invoice_id unqualified inside the subquery —
 * an unqualified column name there would resolve against the
 * subquery's OWN `invoices i` table (which also has tenant_id/id
 * columns), silently turning the guard into an always-true tautology
 * instead of an actual cross-table check.
 *
 * @param {string} tenantId
 * @param {string} invoiceId
 * @param {string} lineId
 * @param {Record<string, unknown>} patch
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function updateLine(tenantId, invoiceId, lineId, patch, client) {
  const keys = Object.keys(patch).filter((key) => LINE_UPDATABLE_COLUMNS.includes(key));
  if (keys.length === 0) {
    throw apiError(400, "EMPTY_PATCH", "No valid fields to update.");
  }

  // $1 = tenantId, $2 = invoiceId, $3 = lineId, so column placeholders start at $4.
  const setClause = keys.map((key, i) => `${key} = $${i + 4}`).join(", ");
  const values = keys.map((key) => patch[key]);

  const result = await client.query(
    `UPDATE invoice_lines SET ${setClause}
     WHERE tenant_id = $1 AND invoice_id = $2 AND id = $3
       AND EXISTS (
         SELECT 1 FROM invoices i
         WHERE i.id = $2
           AND i.tenant_id = $1
           AND i.status = 'DRAFT'::invoice_status_enum
       )
     RETURNING *`,
    [tenantId, invoiceId, lineId, ...values],
  );
  return result.rows[0] || null;
}

module.exports = { insertBatch, deleteByInvoice, listByInvoice, listByInvoiceForPdf, findById, updateLine };
