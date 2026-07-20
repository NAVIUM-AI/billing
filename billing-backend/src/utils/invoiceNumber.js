/**
 * Atomic per-tenant per-type per-FY invoice/credit-note number
 * allocation. Mirrors tripSheetSequence.repository.js#allocateSeq's
 * UPSERT + xmax pattern from Task 3.1 exactly, including its
 * `xmax::text::int > 0` cast — `xmax` is Postgres' `xid` system type,
 * which has no `=` operator against a plain integer literal, so the
 * naive `WHEN xmax = 0` comparison a first draft of this file might
 * reach for actually fails at the SQL level ("operator does not
 * exist: xid = integer"). Casting through text first is the
 * already-proven-working fix, so this file reuses it rather than
 * rediscovering the same error.
 *
 * Both functions are called INSIDE a transaction the caller already
 * owns (invoice.service.js's issue/cancel flows) — the UPSERT is
 * atomic under Postgres' MVCC, and failed issues never consume a
 * number since nothing here runs until the caller's own checks have
 * passed.
 */

const { toIndianFY } = require("./fiscalYear");

/**
 * Parses a 'YYYY-MM-DD' string into a Date at LOCAL midnight — matches
 * fiscalYear.js#toIndianFY's use of local-time getFullYear()/getMonth()
 * accessors. Same helper as tripSheet.service.js#parseCalendarDateLocal
 * (duplicated rather than imported, since that one lives in a service
 * file this util shouldn't depend on).
 *
 * @param {string} isoDateStr
 * @returns {Date}
 */
function parseCalendarDateLocal(isoDateStr) {
  const [y, m, d] = isoDateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * @param {{ client: import('pg').PoolClient, tenantId: string, invoiceType: string, invoiceDate: string, prefix: string }} params
 * @returns {Promise<string>} e.g. "PRA-1/26-27"
 */
async function allocateInvoiceNumber({ client, tenantId, invoiceType, invoiceDate, prefix }) {
  const fy = toIndianFY(parseCalendarDateLocal(invoiceDate));

  const { rows } = await client.query(
    `INSERT INTO invoice_number_sequences
       (tenant_id, invoice_type, fiscal_year, next_seq)
     VALUES ($1::uuid, $2::invoice_type_enum, $3, 2)
     ON CONFLICT (tenant_id, invoice_type, fiscal_year) DO UPDATE
       SET next_seq   = invoice_number_sequences.next_seq + 1,
           updated_at = NOW()
     RETURNING
       CASE
         WHEN xmax::text::int > 0
           THEN invoice_number_sequences.next_seq - 1
         ELSE 1
       END AS allocated_seq`,
    [tenantId, invoiceType, fy],
  );

  const seq = rows[0].allocated_seq;
  return `${prefix}-${seq}/${fy}`;
}

/**
 * @param {{ client: import('pg').PoolClient, tenantId: string, creditNoteDate: string, prefix: string }} params
 * @returns {Promise<string>} e.g. "PRA-CN-1/26-27"
 */
async function allocateCreditNoteNumber({ client, tenantId, creditNoteDate, prefix }) {
  const fy = toIndianFY(parseCalendarDateLocal(creditNoteDate));

  const { rows } = await client.query(
    `INSERT INTO credit_note_number_sequences
       (tenant_id, fiscal_year, next_seq)
     VALUES ($1::uuid, $2, 2)
     ON CONFLICT (tenant_id, fiscal_year) DO UPDATE
       SET next_seq   = credit_note_number_sequences.next_seq + 1,
           updated_at = NOW()
     RETURNING
       CASE
         WHEN xmax::text::int > 0
           THEN credit_note_number_sequences.next_seq - 1
         ELSE 1
       END AS allocated_seq`,
    [tenantId, fy],
  );

  const seq = rows[0].allocated_seq;
  return `${prefix}-${seq}/${fy}`;
}

module.exports = { allocateInvoiceNumber, allocateCreditNoteNumber };
