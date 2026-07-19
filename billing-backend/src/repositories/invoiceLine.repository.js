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

module.exports = { insertBatch, deleteByInvoice, listByInvoice };
