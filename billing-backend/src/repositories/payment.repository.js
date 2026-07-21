/**
 * SQL for the `payments` table. Has FORCE ROW LEVEL SECURITY (see the
 * payments migration), so every query here MUST run on a client that
 * already has `app.current_tenant_id` set for this transaction — same
 * convention as every other repository since Task 1.4. No `pool`
 * fallback; `client` is always a client obtained via
 * req.db.withTenantContext().
 *
 * Every enum parameter gets an explicit cast ($n::payment_mode_enum,
 * $n::payment_status_enum) — Postgres has no implicit cast from text to
 * a custom enum type (Rule 1).
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
  { customerId, invoiceId, parentPaymentId, amountPaise, paymentMode, referenceNumber, receivedAt, notes, recordedBy },
  client,
) {
  try {
    const result = await client.query(
      `INSERT INTO payments (
         tenant_id, customer_id, invoice_id, parent_payment_id,
         amount_paise, payment_mode, reference_number,
         received_at, status, notes, recorded_by
       )
       VALUES (
         $1, $2::uuid, $3::uuid, $4::uuid,
         $5, $6::payment_mode_enum, $7,
         $8::timestamptz, 'RECORDED'::payment_status_enum, $9, $10
       )
       RETURNING *`,
      [
        tenantId,
        customerId,
        invoiceId || null,
        parentPaymentId || null,
        amountPaise,
        paymentMode,
        referenceNumber || null,
        receivedAt,
        notes || null,
        recordedBy || null,
      ],
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION && err.constraint === "idx_payments_ref_unique") {
      throw apiError(409, "PAYMENT_REFERENCE_DUPLICATE", "A payment with this reference number already exists.", {
        payment_mode: paymentMode,
        reference_number: referenceNumber,
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
  const result = await client.query("SELECT * FROM payments WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
  return result.rows[0] || null;
}

/**
 * `client` is REQUIRED — same reasoning as every other findByIdForUpdate
 * in this codebase: `FOR UPDATE` outside an explicit transaction holds
 * the lock for only the instant of the SELECT itself.
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
  const result = await client.query("SELECT * FROM payments WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [
    id,
    tenantId,
  ]);
  return result.rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {string} invoiceId
 * @param {import('pg').PoolClient} client
 * @returns {Promise<number>} integer paise
 */
async function sumRecordedForInvoice(tenantId, invoiceId, client) {
  const result = await client.query(
    `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS total
     FROM payments
     WHERE tenant_id = $1::uuid
       AND invoice_id = $2::uuid
       AND status = 'RECORDED'::payment_status_enum`,
    [tenantId, invoiceId],
  );
  return Number(result.rows[0].total);
}

/**
 * @param {string} tenantId
 * @param {string} customerId
 * @param {import('pg').PoolClient} client
 * @returns {Promise<number>} integer paise
 */
async function sumUnallocatedAdvancesForCustomer(tenantId, customerId, client) {
  const result = await client.query(
    `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS total
     FROM payments
     WHERE tenant_id = $1::uuid
       AND customer_id = $2::uuid
       AND invoice_id IS NULL
       AND status = 'RECORDED'::payment_status_enum`,
    [tenantId, customerId],
  );
  return Number(result.rows[0].total);
}

/**
 * Oldest-first (FIFO) — a customer's earliest advance is the one that
 * should be offered against their next invoice first.
 *
 * @param {string} tenantId
 * @param {string} customerId
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object[]>}
 */
async function findUnallocatedAdvancesForCustomer(tenantId, customerId, client) {
  const result = await client.query(
    `SELECT * FROM payments
     WHERE tenant_id = $1::uuid
       AND customer_id = $2::uuid
       AND invoice_id IS NULL
       AND status = 'RECORDED'::payment_status_enum
     ORDER BY received_at ASC, id ASC`,
    [tenantId, customerId],
  );
  return result.rows;
}

/**
 * Guarded UPDATE — `status = 'RECORDED'` in the WHERE means a rowcount
 * of 0 unambiguously means "wasn't RECORDED anymore by the time this
 * ran" (the service disambiguates "not found" vs "already cancelled"
 * via its own findByIdForUpdate read earlier in the same transaction).
 *
 * @param {string} tenantId
 * @param {string} id
 * @param {{ cancelledAt: Date, cancelledBy: string, cancellationReason: string }} params
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object|null>}
 */
async function cancel(tenantId, id, { cancelledAt, cancelledBy, cancellationReason }, client) {
  const result = await client.query(
    `UPDATE payments
     SET status = 'CANCELLED'::payment_status_enum,
         cancelled_at = $3::timestamptz,
         cancelled_by = $4::uuid,
         cancellation_reason = $5
     WHERE id = $1::uuid AND tenant_id = $2::uuid
       AND status = 'RECORDED'::payment_status_enum
     RETURNING *`,
    [id, tenantId, cancelledAt, cancelledBy, cancellationReason],
  );
  return result.rows[0] || null;
}

const SORT_COLUMN = "received_at";

/**
 * @param {string} tenantId
 * @param {{ limit: number, offset: number, customerId: ?string, invoiceId: ?string, paymentMode: ?string, statusIn: ?string[], fromDate: ?string, toDate: ?string }} params
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{ rows: object[], total: number }>}
 */
async function list(tenantId, { limit, offset, customerId, invoiceId, paymentMode, statusIn, fromDate, toDate }, client) {
  const wheres = ["tenant_id = $1::uuid"];
  const params = [tenantId];
  let i = 2;

  const effectiveStatusIn = statusIn && statusIn.length > 0 ? statusIn : ["RECORDED"];
  wheres.push(`status = ANY($${i}::payment_status_enum[])`);
  params.push(effectiveStatusIn);
  i++;

  if (customerId) {
    wheres.push(`customer_id = $${i}::uuid`);
    params.push(customerId);
    i++;
  }
  if (invoiceId) {
    wheres.push(`invoice_id = $${i}::uuid`);
    params.push(invoiceId);
    i++;
  }
  if (paymentMode) {
    wheres.push(`payment_mode = $${i}::payment_mode_enum`);
    params.push(paymentMode);
    i++;
  }
  if (fromDate) {
    wheres.push(`received_at >= $${i}::date`);
    params.push(fromDate);
    i++;
  }
  if (toDate) {
    // Inclusive of the whole to_date day — received_at is a
    // TIMESTAMPTZ, so a bare ::date cast would exclude same-day
    // afternoon payments.
    wheres.push(`received_at < ($${i}::date + INTERVAL '1 day')`);
    params.push(toDate);
    i++;
  }

  const whereClause = wheres.join(" AND ");

  const dataParams = [...params, limit, offset];
  const dataResult = await client.query(
    `SELECT * FROM payments
     WHERE ${whereClause}
     ORDER BY ${SORT_COLUMN} DESC, id ASC
     LIMIT $${i} OFFSET $${i + 1}`,
    dataParams,
  );

  const countResult = await client.query(`SELECT COUNT(*) FROM payments WHERE ${whereClause}`, params);

  return { rows: dataResult.rows, total: Number(countResult.rows[0].count) };
}

module.exports = {
  insert,
  findById,
  findByIdForUpdate,
  sumRecordedForInvoice,
  sumUnallocatedAdvancesForCustomer,
  findUnallocatedAdvancesForCustomer,
  cancel,
  list,
};
