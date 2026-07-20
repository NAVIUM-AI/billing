/**
 * SQL for the `credit_notes` table. Has FORCE ROW LEVEL SECURITY (see
 * the credit_notes migration), so every query here MUST run on a
 * client that already has `app.current_tenant_id` set for this
 * transaction — same convention as invoice.repository.js. No `pool`
 * fallback; `client` is always a client obtained via
 * req.db.withTenantContext().
 *
 * Credit notes are write-once: there is no update function. A credit
 * note is a permanent legal reversal document — nothing in this task
 * ever edits one after creation.
 */

const { apiError } = require("../utils/httpError");

const UNIQUE_VIOLATION = "23505";

/**
 * @param {string} tenantId
 * @param {object} params
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object>}
 */
async function insert(
  tenantId,
  {
    creditNoteNumber,
    originalInvoiceId,
    customerId,
    customerSnapshot,
    tenantSnapshot,
    subtotalPaise,
    totalGstPaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    tollPaise,
    parkingPaise,
    permitPaise,
    fasttagPaise,
    discountPaise,
    grandTotalPaise,
    netPayablePaise,
    creditNoteDate,
    reason,
    amountInWords,
    issuedBy,
  },
  client,
) {
  try {
    const result = await client.query(
      `INSERT INTO credit_notes (
         tenant_id, credit_note_number, original_invoice_id,
         customer_id, customer_snapshot, tenant_snapshot,
         subtotal_paise, total_gst_paise, cgst_paise, sgst_paise, igst_paise,
         toll_paise, parking_paise, permit_paise, fasttag_paise,
         discount_paise, grand_total_paise, net_payable_paise,
         credit_note_date, reason, amount_in_words, issued_by
       )
       VALUES (
         $1, $2, $3::uuid,
         $4::uuid, $5::jsonb, $6::jsonb,
         $7, $8, $9, $10, $11,
         $12, $13, $14, $15,
         $16, $17, $18,
         $19::date, $20, $21, $22
       )
       RETURNING *`,
      [
        tenantId,
        creditNoteNumber,
        originalInvoiceId,
        customerId,
        JSON.stringify(customerSnapshot),
        JSON.stringify(tenantSnapshot),
        subtotalPaise,
        totalGstPaise,
        cgstPaise,
        sgstPaise,
        igstPaise,
        tollPaise,
        parkingPaise,
        permitPaise,
        fasttagPaise,
        discountPaise,
        grandTotalPaise,
        netPayablePaise,
        creditNoteDate,
        reason,
        amountInWords || null,
        issuedBy || null,
      ],
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION && err.constraint === "credit_notes_number_per_tenant_unique") {
      // Should never happen if sequence allocation works correctly —
      // same "this is a bug, not routine contention" reasoning as
      // tripSheet.repository.js#insert's TRIP_NUMBER_COLLISION.
      throw apiError(409, "CREDIT_NOTE_NUMBER_COLLISION", "Credit note number already in use. Retry.", {
        credit_note_number: creditNoteNumber,
      });
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
  const result = await client.query("SELECT * FROM credit_notes WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
  return result.rows[0] || null;
}

/**
 * Simple offset pagination, newest first. No filters in this task.
 *
 * @param {string} tenantId
 * @param {{ limit: number, offset: number }} params
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{ rows: object[], total: number }>}
 */
async function list(tenantId, { limit, offset }, client) {
  const listResult = await client.query(
    `SELECT * FROM credit_notes
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  const countResult = await client.query("SELECT COUNT(*) FROM credit_notes WHERE tenant_id = $1", [tenantId]);
  return { rows: listResult.rows, total: Number(countResult.rows[0].count) };
}

module.exports = { insert, findById, list };
