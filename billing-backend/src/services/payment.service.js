/**
 * Payments business logic (Task 4.4): recording payments against
 * invoices or as standalone customer advances, applying advances to
 * invoices, cancelling payments, the derived ISSUED<->PAID transition,
 * the customer ledger, and the receivables aging report.
 *
 * ─── Flagged spec deviation: outstanding <= 0 on recordPaymentOnInvoice ───
 * The Task 4.4 spec's split formula is: "if amountPaise <= outstanding,
 * full payment; else, split — apply {outstanding} to the invoice,
 * spill the remainder as an advance." That's correct whenever
 * outstanding > 0. But an invoice can legitimately be ISSUED-or-PAID
 * with outstanding <= 0 already (e.g. someone records a second payment
 * on an invoice that's already fully PAID) — the spec's own step (b)
 * explicitly allows recording payments on PAID invoices, not just
 * ISSUED ones. In that case the literal split formula would try to
 * insert an "applied" row with amount_paise = outstanding <= 0, which
 * violates payments' own `amount_paise > 0` CHECK constraint and would
 * surface as a raw, unhandled Postgres error instead of a clean
 * apiError. Resolution: when outstanding <= 0, the ENTIRE payment
 * becomes a pure advance (invoice_id null) with no "applied" portion
 * at all — see the dedicated branch in recordPaymentOnInvoice below.
 *
 * ─── Flagged spec deviation: applied-from-advance reference reuse ───
 * The spec's partial-advance-application reference,
 * `applied-from-advance-{advance.id}`, is stable across repeated PARTIAL
 * applications of the same advance to different invoices (an advance
 * large enough to need splitting across two separate apply-advance
 * calls, only the last of which fully consumes it). Since that
 * reference is reused on a non-CASH advance, the second call would
 * collide with the idempotency unique index that Task 4.4 itself adds
 * (idx_payments_ref_unique). Fixed by including the target invoice id
 * in the reference (`applied-from-advance-{advance.id}-to-{invoice.id}`),
 * which stays human-meaningful and unique per (advance, invoice) pair.
 */

const paymentRepo = require("../repositories/payment.repository");
const invoiceRepo = require("../repositories/invoice.repository");
const customerRepo = require("../repositories/customer.repository");
const { rupeesToPaise } = require("../utils/money");
const { apiError } = require("../utils/httpError");

const ELIGIBLE_PAYMENT_STATUSES = new Set(["ISSUED", "PAID"]);

/**
 * @param {object} c - customers row
 * @returns {object}
 */
function shapeCustomerForLedger(c) {
  return {
    id: c.id,
    customer_type: c.customer_type,
    name: c.name,
    company_name: c.company_name,
    gstin: c.gstin,
    state_code: c.state_code,
    credit_days: c.credit_days,
  };
}

/**
 * Shared normalize step for both recordPaymentOnInvoice and
 * recordAdvanceForCustomer (Rule 4 — normalize once).
 *
 * @param {object} input - validated recordPaymentSchema output
 * @returns {{ amountPaise: number, paymentMode: string, referenceNumber: ?string, receivedAt: Date, notes: ?string }}
 */
function normalizePaymentInput(input) {
  const amountPaise = rupeesToPaise(input.amount_rupees);
  const paymentMode = input.payment_mode;
  const referenceNumber = input.reference_number?.trim() || null;
  const receivedAt = input.received_at ? new Date(input.received_at) : new Date();
  const notes = input.notes?.trim() || null;

  // Step 3: Validate (defense-in-depth — Joi already covers both of
  // these; this only fires if it's ever bypassed).
  if (receivedAt.getTime() > Date.now()) {
    throw apiError(400, "VALIDATION_ERROR", "received_at cannot be in the future.");
  }
  if (paymentMode !== "CASH" && !referenceNumber) {
    throw apiError(400, "REFERENCE_REQUIRED", "reference_number is required for non-CASH payments.");
  }

  return { amountPaise, paymentMode, referenceNumber, receivedAt, notes };
}

/**
 * Re-derives whether the invoice should transition ISSUED -> PAID after
 * a payment/advance-application changed its recorded total. Re-queries
 * the sum fresh (rather than trusting a caller-computed delta) so it's
 * correct regardless of which of recordPaymentOnInvoice's three
 * branches ran.
 *
 * @param {string} tenantId
 * @param {object} invoice - the invoice row as loaded at the START of this request
 * @param {import('pg').PoolClient} client
 * @returns {Promise<boolean>}
 */
async function maybeTransitionToPaid(tenantId, invoice, client) {
  if (invoice.status !== "ISSUED") return false;
  const newTotal = await paymentRepo.sumRecordedForInvoice(tenantId, invoice.id, client);
  if (newTotal < invoice.net_payable_paise) return false;
  await invoiceRepo.transitionStatus(tenantId, invoice.id, "ISSUED", "PAID", {}, null, null, client);
  return true;
}

/**
 * @param {string} tenantId
 * @param {string} invoiceId
 * @param {object} input - validated recordPaymentSchema output
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ payment: object, spillover_advance: ?object, invoice_transitioned_to_paid: boolean }>}
 */
async function recordPaymentOnInvoice(tenantId, invoiceId, input, actorUserId, db) {
  const { amountPaise, paymentMode, referenceNumber, receivedAt, notes } = normalizePaymentInput(input);

  return db.withTenantContext(async (client) => {
    const invoice = await invoiceRepo.findByIdForUpdate(tenantId, invoiceId, client);
    if (!invoice) {
      throw apiError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
    }
    if (!ELIGIBLE_PAYMENT_STATUSES.has(invoice.status)) {
      throw apiError(400, "PAYMENT_NOT_ALLOWED_STATE", "Payments can only be recorded on ISSUED or PAID invoices.", {
        current_status: invoice.status,
      });
    }

    const alreadyPaid = await paymentRepo.sumRecordedForInvoice(tenantId, invoiceId, client);
    const netPayable = invoice.net_payable_paise;
    const outstanding = netPayable - alreadyPaid;

    let applied;
    let overflow = null;

    if (outstanding <= 0) {
      // See top-of-file note — nothing left to apply, the whole
      // payment becomes a pure advance.
      applied = await paymentRepo.insert(
        tenantId,
        {
          customerId: invoice.customer_id,
          invoiceId: null,
          parentPaymentId: null,
          amountPaise,
          paymentMode,
          referenceNumber,
          receivedAt,
          notes,
          recordedBy: actorUserId,
        },
        client,
      );
    } else if (amountPaise <= outstanding) {
      applied = await paymentRepo.insert(
        tenantId,
        {
          customerId: invoice.customer_id,
          invoiceId: invoice.id,
          parentPaymentId: null,
          amountPaise,
          paymentMode,
          referenceNumber,
          receivedAt,
          notes,
          recordedBy: actorUserId,
        },
        client,
      );
    } else {
      applied = await paymentRepo.insert(
        tenantId,
        {
          customerId: invoice.customer_id,
          invoiceId: invoice.id,
          parentPaymentId: null,
          amountPaise: outstanding,
          paymentMode,
          referenceNumber,
          receivedAt,
          notes,
          recordedBy: actorUserId,
        },
        client,
      );

      // See top-of-file note: '#advance-of-{id}' keeps the reference
      // human-meaningful and unique so it never collides with the
      // idempotency index on the (already-recorded) applied portion.
      const spilloverRef = referenceNumber ? `${referenceNumber}#advance-of-${applied.id}` : null;
      overflow = await paymentRepo.insert(
        tenantId,
        {
          customerId: invoice.customer_id,
          invoiceId: null,
          parentPaymentId: applied.id,
          amountPaise: amountPaise - outstanding,
          paymentMode,
          referenceNumber: spilloverRef,
          receivedAt,
          notes,
          recordedBy: actorUserId,
        },
        client,
      );
    }

    const transitioned = await maybeTransitionToPaid(tenantId, invoice, client);

    return { payment: applied, spillover_advance: overflow, invoice_transitioned_to_paid: transitioned };
  });
}

/**
 * @param {string} tenantId
 * @param {string} customerId
 * @param {object} input - validated recordPaymentSchema output
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>} the inserted payment row
 */
async function recordAdvanceForCustomer(tenantId, customerId, input, actorUserId, db) {
  const { amountPaise, paymentMode, referenceNumber, receivedAt, notes } = normalizePaymentInput(input);

  return db.withTenantContext(async (client) => {
    const customer = await customerRepo.findById(tenantId, customerId, client);
    if (!customer || !customer.is_active) {
      throw apiError(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    }

    return paymentRepo.insert(
      tenantId,
      {
        customerId,
        invoiceId: null,
        parentPaymentId: null,
        amountPaise,
        paymentMode,
        referenceNumber,
        receivedAt,
        notes,
        recordedBy: actorUserId,
      },
      client,
    );
  });
}

/**
 * @param {string} tenantId
 * @param {string} invoiceId
 * @param {{ advance_payment_id: string, amount_rupees?: number }} input - validated applyAdvanceSchema output
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ applied_payment_id: string, remaining_advance_id: ?string, invoice_transitioned_to_paid: boolean }>}
 */
async function applyAdvanceToInvoice(tenantId, invoiceId, input, actorUserId, db) {
  // Step 1: Normalize.
  const advancePaymentId = input.advance_payment_id;
  const requestedAmountPaise = input.amount_rupees !== undefined ? rupeesToPaise(input.amount_rupees) : null;

  return db.withTenantContext(async (client) => {
    const invoice = await invoiceRepo.findByIdForUpdate(tenantId, invoiceId, client);
    if (!invoice) {
      throw apiError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
    }
    if (!ELIGIBLE_PAYMENT_STATUSES.has(invoice.status)) {
      throw apiError(400, "PAYMENT_NOT_ALLOWED_STATE", "Payments can only be recorded on ISSUED or PAID invoices.", {
        current_status: invoice.status,
      });
    }

    const advance = await paymentRepo.findByIdForUpdate(tenantId, advancePaymentId, client);
    if (!advance) {
      throw apiError(404, "ADVANCE_NOT_FOUND", "Advance payment not found.");
    }
    if (advance.invoice_id !== null) {
      throw apiError(400, "PAYMENT_NOT_AN_ADVANCE", "The specified payment is not an unallocated advance.");
    }
    if (advance.status !== "RECORDED") {
      throw apiError(400, "ADVANCE_NOT_ACTIVE", "The specified advance is not active.");
    }
    if (advance.customer_id !== invoice.customer_id) {
      throw apiError(400, "ADVANCE_CUSTOMER_MISMATCH", "Advance and invoice belong to different customers.");
    }

    const alreadyPaid = await paymentRepo.sumRecordedForInvoice(tenantId, invoiceId, client);
    const netPayable = invoice.net_payable_paise;
    const outstanding = netPayable - alreadyPaid;
    if (outstanding <= 0) {
      throw apiError(400, "INVOICE_ALREADY_FULLY_PAID", "Invoice is already fully paid.");
    }

    const advancePaise = advance.amount_paise;
    const applyAmount = requestedAmountPaise
      ? Math.min(requestedAmountPaise, advancePaise, outstanding)
      : Math.min(advancePaise, outstanding);
    if (applyAmount <= 0) {
      throw apiError(400, "APPLY_AMOUNT_INVALID", "Nothing to apply.");
    }

    let result;
    if (applyAmount === advancePaise) {
      // Full advance consumed — reassign the entire row to the invoice
      // rather than inserting a new one; there's nothing left over to
      // track separately.
      await client.query(
        `UPDATE payments
         SET invoice_id = $1::uuid,
             notes = COALESCE(notes, '') || E'\n[Applied to invoice ' || COALESCE($2, '') || ' on ' || NOW() || ']'
         WHERE id = $3::uuid AND tenant_id = $4::uuid`,
        [invoice.id, invoice.invoice_number, advance.id, tenantId],
      );
      result = { applied_payment_id: advance.id, remaining_advance_id: null };
    } else {
      // Partial advance consumed — a new payment row for the applied
      // portion, decrement the advance row by the same amount.
      const applied = await paymentRepo.insert(
        tenantId,
        {
          customerId: advance.customer_id,
          invoiceId: invoice.id,
          parentPaymentId: advance.id,
          amountPaise: applyAmount,
          paymentMode: advance.payment_mode,
          // See top-of-file note: includes the invoice id so repeated
          // partial applications of the SAME advance to DIFFERENT
          // invoices never collide on the idempotency index.
          referenceNumber: `applied-from-advance-${advance.id}-to-${invoice.id}`,
          receivedAt: new Date(),
          notes: `Applied from advance ${advance.id}`,
          recordedBy: actorUserId,
        },
        client,
      );
      await client.query("UPDATE payments SET amount_paise = amount_paise - $1 WHERE id = $2::uuid AND tenant_id = $3::uuid", [
        applyAmount,
        advance.id,
        tenantId,
      ]);
      result = { applied_payment_id: applied.id, remaining_advance_id: advance.id };
    }

    const transitioned = await maybeTransitionToPaid(tenantId, invoice, client);

    return { ...result, invoice_transitioned_to_paid: transitioned };
  });
}

/**
 * @param {string} tenantId
 * @param {string} paymentId
 * @param {{ reason: string }} input - validated cancelPaymentSchema output
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ payment: object, invoice_reverted: boolean }>}
 */
async function cancelPayment(tenantId, paymentId, { reason }, actorUserId, db) {
  const trimmedReason = reason.trim();

  return db.withTenantContext(async (client) => {
    const payment = await paymentRepo.findByIdForUpdate(tenantId, paymentId, client);
    if (!payment) {
      throw apiError(404, "PAYMENT_NOT_FOUND", "Payment not found.");
    }
    if (payment.status !== "RECORDED") {
      throw apiError(409, "PAYMENT_ALREADY_CANCELLED", "Payment is already cancelled.");
    }

    let invoice = null;
    if (payment.invoice_id) {
      invoice = await invoiceRepo.findByIdForUpdate(tenantId, payment.invoice_id, client);
    }

    const cancelled = await paymentRepo.cancel(
      tenantId,
      paymentId,
      { cancelledAt: new Date(), cancelledBy: actorUserId, cancellationReason: trimmedReason },
      client,
    );
    if (!cancelled) {
      // Shouldn't happen — findByIdForUpdate holds the row lock for
      // this whole transaction — but defensive, same pattern as every
      // other guarded update in this codebase.
      throw apiError(409, "PAYMENT_ALREADY_CANCELLED", "Payment is already cancelled.");
    }

    let reverted = false;
    if (invoice && invoice.status === "PAID") {
      const remaining = await paymentRepo.sumRecordedForInvoice(tenantId, invoice.id, client);
      if (remaining < invoice.net_payable_paise) {
        await invoiceRepo.transitionStatus(tenantId, invoice.id, "PAID", "ISSUED", {}, null, null, client);
        reverted = true;
      }
    }

    return { payment: cancelled, invoice_reverted: reverted };
  });
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ payment: object }>}
 */
async function getPayment(tenantId, id, db) {
  const payment = await db.withTenantContext(async (client) => paymentRepo.findById(tenantId, id, client));
  if (!payment) {
    throw apiError(404, "PAYMENT_NOT_FOUND", "Payment not found.");
  }
  return { payment };
}

/**
 * @param {string} tenantId
 * @param {object} query - validated listPaymentsQuerySchema output
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ payments: object[], pagination: object }>}
 */
async function listPayments(tenantId, query, db) {
  const limit = query.limit ?? 25;
  const offset = query.offset ?? 0;
  const customerId = query.customer_id ?? null;
  const invoiceId = query.invoice_id ?? null;
  const paymentMode = query.payment_mode ?? null;
  const statusIn = query.status
    ? query.status
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    : null;
  const fromDate = query.from_date ?? null;
  const toDate = query.to_date ?? null;

  const result = await db.withTenantContext(async (client) =>
    paymentRepo.list(tenantId, { limit, offset, customerId, invoiceId, paymentMode, statusIn, fromDate, toDate }, client),
  );

  return {
    payments: result.rows,
    pagination: {
      total: result.total,
      limit,
      offset,
      has_more: offset + result.rows.length < result.total,
    },
  };
}

/**
 * @param {string} tenantId
 * @param {string} customerId
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
async function getCustomerLedger(tenantId, customerId, db) {
  return db.withTenantContext(async (client) => {
    const customer = await customerRepo.findById(tenantId, customerId, client);
    if (!customer || !customer.is_active) {
      throw apiError(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    }

    const invoiceRows = (
      await client.query(
        `SELECT id, invoice_number, invoice_type, invoice_date, due_date, net_payable_paise, status, cancelled_at
         FROM invoices
         WHERE tenant_id = $1::uuid AND customer_id = $2::uuid AND status <> 'DRAFT'::invoice_status_enum
         ORDER BY invoice_date ASC, id ASC`,
        [tenantId, customerId],
      )
    ).rows;

    const paymentRows = (
      await client.query(
        `SELECT id, invoice_id, amount_paise, payment_mode, reference_number, received_at, status
         FROM payments
         WHERE tenant_id = $1::uuid AND customer_id = $2::uuid AND status = 'RECORDED'::payment_status_enum
         ORDER BY received_at ASC, id ASC`,
        [tenantId, customerId],
      )
    ).rows;

    // CANCELLED invoices are shown for audit but contribute zero debit
    // — the whole point of cancelling one (via credit note, Task 4.3)
    // is that it no longer represents money owed.
    const invoiceEntries = invoiceRows.map((inv) => ({
      type: "INVOICE",
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      due_date: inv.due_date,
      debit_paise: inv.status === "CANCELLED" ? 0 : inv.net_payable_paise,
      status: inv.status,
      _timestamp: inv.invoice_date,
    }));
    const paymentEntries = paymentRows.map((p) => ({
      type: "PAYMENT",
      payment_id: p.id,
      invoice_id: p.invoice_id,
      received_at: p.received_at,
      credit_paise: p.amount_paise,
      payment_mode: p.payment_mode,
      reference_number: p.reference_number,
      _timestamp: p.received_at,
    }));

    const merged = [...invoiceEntries, ...paymentEntries].sort(
      (a, b) => new Date(a._timestamp).getTime() - new Date(b._timestamp).getTime(),
    );

    let runningBalance = 0;
    const entries = merged.map(({ _timestamp, ...entry }) => {
      runningBalance += (entry.debit_paise ?? 0) - (entry.credit_paise ?? 0);
      return { ...entry, running_balance_paise: runningBalance };
    });

    const totalInvoicedPaise = invoiceRows
      .filter((inv) => inv.status !== "CANCELLED")
      .reduce((sum, inv) => sum + inv.net_payable_paise, 0);
    const totalCancelledPaise = invoiceRows
      .filter((inv) => inv.status === "CANCELLED")
      .reduce((sum, inv) => sum + inv.net_payable_paise, 0);
    const totalPaidPaise = paymentRows.filter((p) => p.invoice_id !== null).reduce((sum, p) => sum + p.amount_paise, 0);
    const unallocatedAdvancePaise = paymentRows
      .filter((p) => p.invoice_id === null)
      .reduce((sum, p) => sum + p.amount_paise, 0);
    const outstandingPaise = totalInvoicedPaise - totalPaidPaise - unallocatedAdvancePaise;

    return {
      customer: shapeCustomerForLedger(customer),
      summary: {
        total_invoiced_paise: totalInvoicedPaise,
        total_paid_paise: totalPaidPaise,
        total_cancelled_paise: totalCancelledPaise,
        unallocated_advance_paise: unallocatedAdvancePaise,
        outstanding_paise: outstandingPaise,
      },
      entries,
    };
  });
}

const AGING_BUCKET_NAMES = ["CURRENT", "DAYS_1_30", "DAYS_31_60", "DAYS_61_90", "DAYS_90_PLUS"];

/**
 * @param {string} tenantId
 * @param {{ as_of_date?: string }} query
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
async function getReceivablesAging(tenantId, query, db) {
  // Step 1: Normalize.
  const asOfDate = query.as_of_date || new Date().toISOString().slice(0, 10);

  return db.withTenantContext(async (client) => {
    const { rows } = await client.query(
      `WITH invoice_balances AS (
         SELECT
           i.id AS invoice_id,
           i.customer_id,
           i.invoice_number,
           i.due_date,
           i.net_payable_paise,
           COALESCE(
             (SELECT SUM(amount_paise) FROM payments p
              WHERE p.tenant_id = i.tenant_id AND p.invoice_id = i.id AND p.status = 'RECORDED'::payment_status_enum),
             0
           ) AS paid_paise,
           (i.net_payable_paise - COALESCE(
             (SELECT SUM(amount_paise) FROM payments p
              WHERE p.tenant_id = i.tenant_id AND p.invoice_id = i.id AND p.status = 'RECORDED'::payment_status_enum),
             0
           )) AS outstanding_paise
         FROM invoices i
         WHERE i.tenant_id = $1::uuid AND i.status = 'ISSUED'::invoice_status_enum
       )
       SELECT
         invoice_id, customer_id, invoice_number, due_date, net_payable_paise, paid_paise, outstanding_paise,
         ($2::date - due_date) AS days_overdue,
         CASE
           WHEN $2::date <= due_date THEN 'CURRENT'
           WHEN $2::date - due_date <= 30 THEN 'DAYS_1_30'
           WHEN $2::date - due_date <= 60 THEN 'DAYS_31_60'
           WHEN $2::date - due_date <= 90 THEN 'DAYS_61_90'
           ELSE 'DAYS_90_PLUS'
         END AS bucket
       FROM invoice_balances
       WHERE outstanding_paise > 0
       ORDER BY due_date ASC, invoice_number ASC`,
      [tenantId, asOfDate],
    );

    const customerIds = [...new Set(rows.map((r) => r.customer_id))];
    const customerMap = new Map();
    if (customerIds.length > 0) {
      const custRows = (
        await client.query("SELECT id, customer_type, name, company_name FROM customers WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])", [
          tenantId,
          customerIds,
        ])
      ).rows;
      for (const c of custRows) customerMap.set(c.id, c);
    }

    const buckets = {};
    for (const name of AGING_BUCKET_NAMES) buckets[name] = { count: 0, total_paise: 0, entries: [] };

    for (const row of rows) {
      const customer = customerMap.get(row.customer_id);
      const bucket = buckets[row.bucket];
      bucket.entries.push({
        invoice_id: row.invoice_id,
        invoice_number: row.invoice_number,
        customer_id: row.customer_id,
        customer_name: customer ? customer.company_name || customer.name : null,
        due_date: row.due_date,
        net_payable_paise: Number(row.net_payable_paise),
        paid_paise: Number(row.paid_paise),
        outstanding_paise: Number(row.outstanding_paise),
        days_overdue: Number(row.days_overdue),
      });
      bucket.count += 1;
      bucket.total_paise += Number(row.outstanding_paise);
    }

    const grandTotalPaise = AGING_BUCKET_NAMES.reduce((sum, name) => sum + buckets[name].total_paise, 0);
    const totalInvoices = AGING_BUCKET_NAMES.reduce((sum, name) => sum + buckets[name].count, 0);

    const bucketsSummary = {};
    for (const name of AGING_BUCKET_NAMES) {
      bucketsSummary[name] = { count: buckets[name].count, total_paise: buckets[name].total_paise };
    }

    return {
      as_of_date: asOfDate,
      summary: {
        total_outstanding_paise: grandTotalPaise,
        total_invoices: totalInvoices,
        buckets_summary: bucketsSummary,
      },
      buckets,
    };
  });
}

module.exports = {
  recordPaymentOnInvoice,
  recordAdvanceForCustomer,
  applyAdvanceToInvoice,
  cancelPayment,
  getPayment,
  listPayments,
  getCustomerLedger,
  getReceivablesAging,
};
