/**
 * SQL for the `trip_sheet_sequences` table — a concurrency-safe
 * per-tenant, per-fiscal-year counter that trip sheet numbering draws
 * from. Has FORCE ROW LEVEL SECURITY (see the trip_sheets migration),
 * so every query here MUST run on a client that already has
 * `app.current_tenant_id` set for this transaction — same convention as
 * the other Module 2 repositories. No `pool` fallback; `client` is
 * always the same client the caller's parent trip-insert transaction is
 * using (see tripSheet.service.js#createTripSheet).
 */

/**
 * Atomically allocates the next sequence number for (tenantId,
 * fiscalYear).
 *
 * Approach: UPSERT with RETURNING.
 *   INSERT ... ON CONFLICT DO UPDATE SET next_seq
 *     = trip_sheet_sequences.next_seq + 1
 *     RETURNING ...
 *
 * This runs as a single SQL statement, atomic under Postgres' MVCC —
 * concurrent inserts for the same (tenant_id, fiscal_year) serialize on
 * the row's primary-key lock, so two requests racing to allocate the
 * first number of a new fiscal year can never both win.
 *
 * The `xmax` trick below is how we tell "this INSERT created a brand
 * new row" apart from "this INSERT hit the ON CONFLICT branch and
 * UPDATEd an existing row": `xmax` is a Postgres system column holding
 * the transaction ID of the last UPDATE/DELETE to touch a row (0 if
 * the row has never been updated/deleted). `RETURNING xmax` on a
 * freshly INSERTed row is always 0; on a row that just went through
 * the ON CONFLICT DO UPDATE path, xmax is the current transaction's ID
 * (always > 0, since transaction IDs start at a nonzero value). So:
 *   - xmax = 0   -> this was the FIRST trip of the fiscal year; the row
 *                   was inserted with next_seq=2, meaning we allocated
 *                   seq=1.
 *   - xmax > 0   -> the row already existed and next_seq was just
 *                   incremented; we allocated (new next_seq - 1).
 *
 * Caller must supply a client that's already inside
 * db.withTenantContext (the parent trip insert transaction) — this
 * keeps the sequence allocation and the trip insert atomic as a unit:
 * if the insert fails after the seq is allocated, the whole transaction
 * rolls back and the seq allocation rolls back with it, so no number
 * is ever burned on a failed create.
 *
 * @param {string} tenantId
 * @param {string} fiscalYear - e.g. '26-27'
 * @param {import('pg').PoolClient} client
 * @returns {Promise<number>} the allocated sequence number
 */
async function allocateSeq(tenantId, fiscalYear, client) {
  const q = `
    INSERT INTO trip_sheet_sequences
      (tenant_id, fiscal_year, next_seq)
    VALUES ($1::uuid, $2, 2)
    ON CONFLICT (tenant_id, fiscal_year) DO UPDATE
      SET next_seq   = trip_sheet_sequences.next_seq + 1,
          updated_at = NOW()
    RETURNING
      CASE
        WHEN xmax::text::int > 0
          THEN trip_sheet_sequences.next_seq - 1
        ELSE 1
      END AS allocated_seq
  `;
  const { rows } = await client.query(q, [tenantId, fiscalYear]);
  return rows[0].allocated_seq;
}

module.exports = { allocateSeq };
