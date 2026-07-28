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

const UNIQUE_VIOLATION = "23505";

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
  "reverse_charge",
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
    reverseCharge,
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
       reverse_charge,
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
       $28,
       $29
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
      reverseCharge ?? null,
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

/**
 * Guarded invoice-status transition, shared by issue/cancel (Task 4.3).
 * Every optional field — audit timestamps, invoice_number, the two
 * snapshot JSONB blobs — uses COALESCE so a caller only needs to pass
 * what THIS transition actually sets; untouched fields keep their
 * existing value. That's safe here (unlike trip_sheets'
 * invoiced_at/invoice_id reversal — see
 * tripSheet.repository.js#reverseInvoiced) because invoice_number,
 * tenant_snapshot, and customer_snapshot are write-once in this state
 * machine: nothing ever needs to clear them back to null once set.
 *
 * @param {string} tenantId
 * @param {string} id
 * @param {string} fromStatus
 * @param {string} toStatus
 * @param {{ issuedAt?: Date, issuedBy?: string, cancelledAt?: Date, cancelledBy?: string, cancellationReason?: string, creditNoteId?: string }} auditFields
 * @param {?{ tenantSnapshot: object, customerSnapshot: object }} snapshotFields
 * @param {?string} invoiceNumber
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function transitionStatus(tenantId, id, fromStatus, toStatus, auditFields, snapshotFields, invoiceNumber, client) {
  const { issuedAt, issuedBy, cancelledAt, cancelledBy, cancellationReason, creditNoteId } = auditFields || {};

  try {
    const result = await client.query(
      `UPDATE invoices
       SET status = $3::invoice_status_enum,
           invoice_number = COALESCE($4, invoice_number),
           tenant_snapshot = COALESCE($5::jsonb, tenant_snapshot),
           customer_snapshot = COALESCE($6::jsonb, customer_snapshot),
           issued_at = COALESCE($7::timestamptz, issued_at),
           issued_by = COALESCE($8::uuid, issued_by),
           cancelled_at = COALESCE($9::timestamptz, cancelled_at),
           cancelled_by = COALESCE($10::uuid, cancelled_by),
           cancellation_reason = COALESCE($11::text, cancellation_reason),
           credit_note_id = COALESCE($12::uuid, credit_note_id)
       WHERE id = $1::uuid
         AND tenant_id = $2::uuid
         AND status = $13::invoice_status_enum
       RETURNING *`,
      [
        id,
        tenantId,
        toStatus,
        invoiceNumber ?? null,
        snapshotFields ? JSON.stringify(snapshotFields.tenantSnapshot) : null,
        snapshotFields ? JSON.stringify(snapshotFields.customerSnapshot) : null,
        issuedAt ?? null,
        issuedBy ?? null,
        cancelledAt ?? null,
        cancelledBy ?? null,
        cancellationReason ?? null,
        creditNoteId ?? null,
        fromStatus,
      ],
    );
    return result.rows[0] || null;
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION && err.constraint === "invoices_number_per_tenant_unique") {
      // Should never happen if sequence allocation works correctly —
      // same "this is a bug, not routine contention" reasoning as
      // tripSheet.repository.js#insert's TRIP_NUMBER_COLLISION.
      throw apiError(409, "INVOICE_NUMBER_COLLISION", "Invoice number already in use. Retry.", {
        invoice_number: invoiceNumber,
      });
    }
    throw err;
  }
}

module.exports = { insertDraft, findById, findByIdForUpdate, updateDraft, deleteDraft, transitionStatus };
