/**
 * SQL for the `invoices` table. Has FORCE ROW LEVEL SECURITY (see the
 * invoice_foundation migration), so every query here MUST run on a
 * client that already has `app.current_tenant_id` set for this
 * transaction — same convention as tripSheet.repository.js and every
 * Module 2 repository. No `pool` fallback; `client` is always a client
 * obtained via req.db.withTenantContext().
 *
 * Every enum and date column parameter gets an explicit cast
 * ($n::invoice_type_enum, $n::invoice_status_enum, $n::date) — Postgres
 * has no implicit cast from text to a custom enum type (Task 2.3
 * debrief, Rule 1).
 *
 * Every WHERE clause still includes tenant_id alongside id, even though
 * RLS already enforces it — belt and suspenders (established convention
 * since Task 1.4).
 */

const { apiError } = require("../utils/httpError");

// Columns editable while an invoice is DRAFT. Deliberately excludes
// identity/audit columns — invoice_number, invoice_type, customer_id,
// tenant_id, status, and every audit/issue/cancel/pdf column — same
// "whitelist, not blacklist" pattern as
// tripSheet.repository.js#DRAFT_UPDATABLE_COLUMNS. The financial
// columns are listed together because the service always rewrites them
// as a group on every trip-set change or charge edit (recomputed via
// the GST domain module, never patched independently).
const DRAFT_UPDATABLE_COLUMNS = [
  "invoice_date",
  "due_date",
  "notes",
  "terms",
  "subtotal_paise",
  "gst_rate_snapshot",
  "cgst_paise",
  "sgst_paise",
  "igst_paise",
  "total_gst_paise",
  "toll_paise",
  "parking_paise",
  "permit_paise",
  "fasttag_paise",
  "discount_paise",
  "discount_reason",
  "round_off_paise",
  "grand_total_paise",
  "net_payable_paise",
  "amount_in_words",
  "toll_manual_override",
  "parking_manual_override",
  "permit_manual_override",
  "fasttag_manual_override",
];

/**
 * @param {string} tenantId
 * @param {object} params
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object>}
 */
async function insertDraft(
  tenantId,
  {
    invoiceType,
    customerId,
    invoiceDate,
    dueDate,
    notes,
    terms,
    subtotalPaise,
    gstRateSnapshot,
    cgstPaise,
    sgstPaise,
    igstPaise,
    totalGstPaise,
    tollPaise,
    parkingPaise,
    permitPaise,
    fasttagPaise,
    discountPaise,
    discountReason,
    roundOffPaise,
    grandTotalPaise,
    netPayablePaise,
    amountInWords,
    tollManualOverride,
    parkingManualOverride,
    permitManualOverride,
    fasttagManualOverride,
    createdBy,
  },
  client,
) {
  const result = await client.query(
    `INSERT INTO invoices (
       tenant_id, invoice_type, status, customer_id,
       invoice_date, due_date, notes, terms,
       subtotal_paise, gst_rate_snapshot,
       cgst_paise, sgst_paise, igst_paise, total_gst_paise,
       toll_paise, parking_paise, permit_paise, fasttag_paise,
       discount_paise, discount_reason,
       round_off_paise, grand_total_paise, net_payable_paise,
       amount_in_words,
       toll_manual_override, parking_manual_override,
       permit_manual_override, fasttag_manual_override,
       created_by
     )
     VALUES (
       $1, $2::invoice_type_enum, 'DRAFT'::invoice_status_enum, $3,
       $4::date, $5::date, $6, $7,
       $8, $9,
       $10, $11, $12, $13,
       $14, $15, $16, $17,
       $18, $19,
       $20, $21, $22,
       $23,
       $24, $25,
       $26, $27,
       $28
     )
     RETURNING *`,
    [
      tenantId,
      invoiceType,
      customerId,
      invoiceDate,
      dueDate,
      notes || null,
      terms || null,
      subtotalPaise,
      gstRateSnapshot ?? null,
      cgstPaise,
      sgstPaise,
      igstPaise,
      totalGstPaise,
      tollPaise,
      parkingPaise,
      permitPaise,
      fasttagPaise,
      discountPaise,
      discountReason || null,
      roundOffPaise,
      grandTotalPaise,
      netPayablePaise,
      amountInWords,
      Boolean(tollManualOverride),
      Boolean(parkingManualOverride),
      Boolean(permitManualOverride),
      Boolean(fasttagManualOverride),
      createdBy || null,
    ],
  );
  return result.rows[0];
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function findById(tenantId, id, client) {
  const result = await client.query("SELECT * FROM invoices WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
  return result.rows[0] || null;
}

/**
 * Row lock for lifecycle operations (PATCH/DELETE here; issue/cancel in
 * Task 4.3). `client` is REQUIRED — same reasoning as
 * tripSheet.repository.js#findByIdForUpdate: `FOR UPDATE` outside an
 * explicit transaction holds the lock for only the instant of the
 * SELECT itself.
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
  const result = await client.query("SELECT * FROM invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [
    id,
    tenantId,
  ]);
  return result.rows[0] || null;
}

/**
 * Updates only the whitelisted, present keys of `patch`, guarded by
 * `status = 'DRAFT'` in the WHERE — same "guard in the WHERE, not a
 * separate check" pattern as tripSheet.repository.js#updateDraft. A
 * `null` return means either the invoice doesn't exist for this tenant
 * or it's no longer DRAFT; the caller disambiguates via its own
 * findByIdForUpdate read earlier in the same transaction.
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
      if (key === "invoice_date" || key === "due_date") return `${key} = ${placeholder}::date`;
      return `${key} = ${placeholder}`;
    })
    .join(", ");
  const values = keys.map((key) => patch[key]);

  const result = await client.query(
    `UPDATE invoices SET ${setClause}
     WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT'::invoice_status_enum
     RETURNING *`,
    [id, tenantId, ...values],
  );
  return result.rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {import('pg').PoolClient} client
 * @returns {Promise<void>}
 */
async function deleteDraft(tenantId, id, client) {
  await client.query("DELETE FROM invoices WHERE id = $1 AND tenant_id = $2 AND status = 'DRAFT'::invoice_status_enum", [
    id,
    tenantId,
  ]);
}

module.exports = { insertDraft, findById, findByIdForUpdate, updateDraft, deleteDraft };
