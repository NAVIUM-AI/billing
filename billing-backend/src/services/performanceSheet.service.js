/**
 * Performance sheet: a read-only Blue UI projection over existing
 * billing_mode='PERFORMANCE' trips. No new table — this is a view over
 * trip_sheets, grouped by customer with subtotals and a grand total.
 * Kept as its own service file (rather than folded into
 * tripSheet.service.js) because the projection/grouping/CSV logic is
 * meaty enough to isolate, even though it belongs conceptually with
 * trips.
 */

const tripRepo = require("../repositories/tripSheet.repository");
const money = require("../utils/money");
const { apiError } = require("../utils/httpError");

const MAX_ROWS = 10000;

/**
 * Renders one trip row to the Blue UI columns. Blue UI columns are
 * UPPERCASE snake style matching the reference PDF exactly. Paise
 * duplicates enable programmatic clients to skip float parsing; rupees
 * are for display. Standing Rule: money is stored + computed in paise,
 * formatted for humans at the edge.
 *
 * @param {object} row - a row from tripRepo.listPerformanceRows
 * @param {number} sl - 1-based serial number within the row's group
 * @returns {object}
 */
function shapeRow(row, sl) {
  return {
    SL: sl,
    DATE: row.trip_date,
    VEHICLE_TYPE: row.vehicle_type,
    VEHICLE_NUMBER: row.vehicle_number,
    TOTAL_RUNNING_KM: row.total_running_km,
    PER_KM_COST_RUPEES: money.paiseToRupees(row.per_km_rate_paise),
    PER_KM_COST_PAISE: row.per_km_rate_paise,
    TOTAL_COST_RUPEES: money.paiseToRupees(row.running_cost_paise),
    TOTAL_COST_PAISE: row.running_cost_paise,
    BATA_RUPEES: money.paiseToRupees(row.batta_paise),
    BATA_PAISE: row.batta_paise,
    TOLL_CHARGES_RUPEES: money.paiseToRupees(row.toll_paise),
    TOLL_CHARGES_PAISE: row.toll_paise,
    GRAND_TOTAL_RUPEES: money.paiseToRupees(row.total_paise),
    GRAND_TOTAL_PAISE: row.total_paise,
    TRIP_ID: row.trip_id,
    STATUS: row.status,
  };
}

/**
 * GET /trips/performance-sheet — read-only, no transaction needed
 * beyond the tenant-context session-var setter.
 *
 * @param {string} tenantId
 * @param {object} query - validated performanceSheetQuerySchema output
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ groups: object[], grand_total: object, filters_applied: object }>}
 */
async function getPerformanceSheet(tenantId, query, db) {
  // Step 1: Normalize.
  const customerId = query.customer_id ?? null;
  const vehicleId = query.vehicle_id ?? null;
  const driverId = query.driver_id ?? null;
  const fromDate = query.from_date ?? null;
  const toDate = query.to_date ?? null;
  const serviceType = query.service_type ?? null;
  const includeCancelled = query.includeCancelled ?? false;
  const sortBy = query.sort_by ?? "trip_date";
  const sortDir = query.sort_dir ?? "asc";
  const statusIn = query.status
    ? query.status
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    : null;

  // Steps 4-5: Read.
  const result = await db.withTenantContext(async (client) => {
    return tripRepo.listPerformanceRows(
      tenantId,
      {
        customerId,
        vehicleId,
        driverId,
        fromDate,
        toDate,
        serviceType,
        statusIn,
        includeCancelled,
        sortBy,
        sortDir,
        maxRows: MAX_ROWS,
      },
      client,
    );
  });

  if (result.truncated) {
    throw apiError(
      400,
      "EXPORT_TOO_LARGE",
      `Filter matched more than ${MAX_ROWS} rows. Narrow with date range or customer filter.`,
      { max_rows: MAX_ROWS },
    );
  }

  // Group by customer_id; preserve within-group ordering from the SQL
  // result (already sorted by the repo's ORDER BY).
  const groups = new Map();
  for (const row of result.rows) {
    if (!groups.has(row.customer_id)) {
      groups.set(row.customer_id, {
        customer_id: row.customer_id,
        customer_name: row.customer_display_name,
        customer_type: row.customer_type,
        rows: [],
        subtotal: {
          total_running_km: 0,
          running_cost_paise: 0,
          batta_paise: 0,
          toll_paise: 0,
          total_paise: 0,
        },
      });
    }
    const g = groups.get(row.customer_id);
    g.rows.push(shapeRow(row, g.rows.length + 1));
    g.subtotal.total_running_km += row.total_running_km;
    g.subtotal.running_cost_paise += row.running_cost_paise;
    g.subtotal.batta_paise += row.batta_paise;
    g.subtotal.toll_paise += row.toll_paise;
    g.subtotal.total_paise += row.total_paise;
  }

  // Grand totals accumulate across ALL rows, not just per-group.
  const grandTotal = {
    total_running_km: 0,
    running_cost_paise: 0,
    batta_paise: 0,
    toll_paise: 0,
    total_paise: 0,
    row_count: result.rows.length,
    group_count: groups.size,
  };
  for (const row of result.rows) {
    grandTotal.total_running_km += row.total_running_km;
    grandTotal.running_cost_paise += row.running_cost_paise;
    grandTotal.batta_paise += row.batta_paise;
    grandTotal.toll_paise += row.toll_paise;
    grandTotal.total_paise += row.total_paise;
  }

  return {
    groups: Array.from(groups.values()),
    grand_total: grandTotal,
    filters_applied: {
      customer_id: customerId,
      vehicle_id: vehicleId,
      driver_id: driverId,
      from_date: fromDate,
      to_date: toDate,
      service_type: serviceType,
      status: statusIn,
      include_cancelled: includeCancelled,
    },
  };
}

/**
 * @param {*} v
 * @returns {string} RFC 4180 CSV-escaped field
 */
function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

const CSV_HEADER = [
  "SL",
  "DATE",
  "CUSTOMER",
  "VEHICLE_TYPE",
  "VEHICLE_NUMBER",
  "TOTAL_RUNNING_KM",
  "PER_KM_COST_RUPEES",
  "TOTAL_COST_RUPEES",
  "BATA_RUPEES",
  "TOLL_CHARGES_RUPEES",
  "GRAND_TOTAL_RUPEES",
  "STATUS",
];

/**
 * GET /trips/performance-sheet/export.csv — reuses getPerformanceSheet
 * for the data, then renders it as RFC 4180 CSV: CRLF line endings,
 * double-quote wrapping/escaping when a field contains a comma,
 * newline, or quote.
 *
 * @param {string} tenantId
 * @param {object} query - validated performanceSheetCsvQuerySchema output
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ filename: string, csv: string, row_count: number, group_count: number }>}
 */
async function getPerformanceSheetCsv(tenantId, query, db) {
  const sheet = await getPerformanceSheet(tenantId, query, db);

  const lines = [CSV_HEADER.join(",")];

  for (const group of sheet.groups) {
    for (const row of group.rows) {
      lines.push(
        [
          row.SL,
          row.DATE,
          group.customer_name,
          row.VEHICLE_TYPE,
          row.VEHICLE_NUMBER,
          row.TOTAL_RUNNING_KM,
          row.PER_KM_COST_RUPEES,
          row.TOTAL_COST_RUPEES,
          row.BATA_RUPEES,
          row.TOLL_CHARGES_RUPEES,
          row.GRAND_TOTAL_RUPEES,
          row.STATUS,
        ]
          .map(csvEscape)
          .join(","),
      );
    }
    lines.push(
      [
        "",
        "SUBTOTAL",
        group.customer_name,
        "",
        "",
        group.subtotal.total_running_km,
        "",
        money.paiseToRupees(group.subtotal.running_cost_paise),
        money.paiseToRupees(group.subtotal.batta_paise),
        money.paiseToRupees(group.subtotal.toll_paise),
        money.paiseToRupees(group.subtotal.total_paise),
        "",
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  lines.push(
    [
      "",
      "GRAND TOTAL",
      "",
      "",
      "",
      sheet.grand_total.total_running_km,
      "",
      money.paiseToRupees(sheet.grand_total.running_cost_paise),
      money.paiseToRupees(sheet.grand_total.batta_paise),
      money.paiseToRupees(sheet.grand_total.toll_paise),
      money.paiseToRupees(sheet.grand_total.total_paise),
      "",
    ]
      .map(csvEscape)
      .join(","),
  );

  const csv = lines.join("\r\n") + "\r\n";
  const today = new Date().toISOString().slice(0, 10);

  return {
    filename: `performance-sheet-${today}.csv`,
    csv,
    row_count: sheet.grand_total.row_count,
    group_count: sheet.grand_total.group_count,
  };
}

module.exports = { getPerformanceSheet, getPerformanceSheetCsv };
