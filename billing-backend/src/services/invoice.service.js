/**
 * Invoice business logic (Task 4.1: draft creation/read/edit/delete
 * only — issue, numbering, and immutability snapshots are Task 4.3;
 * PDF is Task 4.5). Routes call this instead of touching any
 * repository directly, same convention as tripSheet.service.js.
 *
 * createDraftInvoice/updateDraftInvoice follow the locked-in service
 * order: normalize -> derive -> validate -> check -> write, with
 * "check" and "write" happening together inside a single
 * db.withTenantContext transaction — every check from that point on
 * needs live DB state (are these trips actually FINALIZED and unheld
 * right now?) and the whole unit (line inserts + trip holds) must
 * succeed or fail together.
 *
 * ─── Flagged spec deviation: invoice_lines.extras_amount_paise ───
 * The Task 4.1 spec's Part H(e) literally says to copy
 * trip.extras_amount_paise onto every invoice line unconditionally.
 * Doing that verbatim breaks two things the spec's own Part K worked
 * examples depend on:
 *   1. For an OUTSTATION trip, trip.extras_amount_paise is actually
 *      parking + permit + fasttag (see
 *      tripSheet.service.js#computeTripTotals) — non-taxable
 *      pure-agent reimbursements per GST rules, which is exactly why
 *      the invoices table has its OWN separate toll/parking/permit/
 *      fasttag columns, added AFTER GST in the grand-total formula
 *      (Part H(i)). Taxing them via the line would be a real GST
 *      compliance bug, not a cosmetic one.
 *   2. The spec's own Cauvery-reference worked example (Part K Step 1)
 *      asserts subtotal_paise = 8,975,000 (base + batta only) for a
 *      trip whose fasttag charge is ₹2,440 — and Step 2 then adds that
 *      exact ₹2,440 back in as a fresh, separate invoice-level
 *      fasttag_rupees. That only reconciles if the OUTSTATION trip's
 *      reimbursement-shaped "extras" never entered the line in the
 *      first place.
 * Resolution: extras_amount_paise is copied onto the line only for
 * LOCAL trips (where it's genuinely taxable extra-km/extra-hour
 * service revenue); OUTSTATION lines carry 0. See buildInvoiceLines
 * below.
 */

const { computeGST, computeRoundOff, isSameState, DomainInputError } = require("../domain/gst");
const { amountInWords } = require("../domain/gst/amountInWords");
const { isValidTransition, allowedTransitions } = require("../domain/invoiceLifecycle");
const { rupeesToPaise } = require("../utils/money");
const { allocateInvoiceNumber, allocateCreditNoteNumber } = require("../utils/invoiceNumber");
const { buildTenantSnapshot, buildCustomerSnapshot } = require("../utils/invoiceSnapshot");
const invoiceRepo = require("../repositories/invoice.repository");
const lineRepo = require("../repositories/invoiceLine.repository");
const tripRepo = require("../repositories/tripSheet.repository");
const customerRepo = require("../repositories/customer.repository");
const tenantRepo = require("../repositories/tenant.repository");
const creditNoteRepo = require("../repositories/creditNote.repository");
const tripService = require("./tripSheet.service");
const { apiError } = require("../utils/httpError");

const HSN_SAC_VEHICLE_RENTAL = "996601";

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * @param {string} isoDateStr
 * @returns {Date} a UTC-midnight Date for pure calendar-date arithmetic
 */
function parseISOToUTCDate(isoDateStr) {
  const [y, m, d] = isoDateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * @param {string} isoDateStr
 * @param {number} days
 * @returns {string} YYYY-MM-DD
 */
function addDaysISO(isoDateStr, days) {
  const dt = parseISOToUTCDate(isoDateStr);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * @param {string} fromISO
 * @param {string} toISO
 * @returns {number} whole days from `fromISO` to `toISO` (positive when toISO is later)
 */
function daysBetweenISO(fromISO, toISO) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((parseISOToUTCDate(toISO) - parseISOToUTCDate(fromISO)) / MS_PER_DAY);
}

/**
 * @param {string} isoDateStr
 * @returns {string} "01-Jun-2026"
 */
function formatDMY(isoDateStr) {
  const [y, m, d] = isoDateStr.split("-");
  return `${d}-${MONTH_ABBR[Number(m) - 1]}-${y}`;
}

/**
 * Resolves and validates a requested trip_sheet_ids array against live
 * DB state, shared by createDraftInvoice and updateDraftInvoice's
 * trip-set replacement. Throws the specific apiError for whichever
 * problem is found first, walking `tripSheetIds` in caller order so
 * failures are deterministic and reproducible.
 *
 * @param {string} tenantId
 * @param {string[]} tripSheetIds
 * @param {?string} excludeInvoiceId - the draft's own id, so its
 *   currently-held trips resolve too (null on initial create)
 * @param {string} customerId - the invoice's customer_id; every trip must match
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object[]>} trip_sheets rows, in the same order as tripSheetIds
 */
async function resolveTripsForInvoice(tenantId, tripSheetIds, excludeInvoiceId, customerId, client) {
  const trips = await tripRepo.findFinalizedAndUnheld(tenantId, tripSheetIds, excludeInvoiceId, client);
  const foundById = new Map(trips.map((t) => [t.id, t]));

  for (const id of tripSheetIds) {
    if (foundById.has(id)) continue;

    // Not in the eligible set — find out exactly why, for a clear error.
    const raw = await tripRepo.findById(tenantId, id, client);
    if (!raw) {
      throw apiError(404, "TRIP_NOT_FOUND", "Trip not found.", { trip_id: id });
    }
    if (raw.status !== "FINALIZED") {
      throw apiError(400, "TRIP_NOT_FINALIZED", "Trip must be FINALIZED to be added to an invoice.", {
        trip_id: id,
        current_status: raw.status,
      });
    }
    // Must be FINALIZED but held by some OTHER invoice.
    throw apiError(409, "TRIP_ALREADY_HELD", "Trip is already on another invoice.", {
      trip_id: id,
      held_by_invoice_id: raw.held_by_invoice_id,
    });
  }

  for (const id of tripSheetIds) {
    const trip = foundById.get(id);
    if (trip.customer_id !== customerId) {
      throw apiError(400, "CUSTOMER_MISMATCH", "All trips must belong to the same customer as the invoice.", {
        trip_id: id,
        trip_customer_id: trip.customer_id,
        invoice_customer_id: customerId,
      });
    }
  }

  // Preserve caller order for line_number assignment.
  return tripSheetIds.map((id) => foundById.get(id));
}

/**
 * Shapes trip_sheets rows into invoice_lines insert params. See the
 * top-of-file comment for why extras_amount_paise is LOCAL-only.
 *
 * @param {object[]} tripsInOrder
 * @returns {Array<object>}
 */
function buildInvoiceLines(tripsInOrder) {
  return tripsInOrder.map((trip, idx) => {
    const extrasAmountPaise = trip.service_type === "LOCAL" ? trip.extras_amount_paise : 0;
    const lineAmountPaise = trip.base_amount_paise + extrasAmountPaise + trip.driver_batta_paise;
    const label = trip.service_type === "OUTSTATION" ? "outstation trip" : "local trip";

    return {
      tripSheetId: trip.id,
      lineNumber: idx + 1,
      serviceType: trip.service_type,
      tripDate: trip.trip_date,
      vehicleNumber: trip.snapshot_vehicle_number,
      vehicleType: trip.snapshot_vehicle_type,
      totalKm: trip.total_km,
      totalHours: trip.total_hours,
      totalDays: trip.total_days,
      baseAmountPaise: trip.base_amount_paise,
      extrasAmountPaise,
      driverBattaPaise: trip.driver_batta_paise,
      lineAmountPaise,
      hsnSacCode: HSN_SAC_VEHICLE_RENTAL,
      description: `${trip.snapshot_vehicle_type} ${trip.snapshot_vehicle_number} - ${trip.total_km} km ${label} on ${formatDMY(trip.trip_date)}`,
    };
  });
}

// Task 4.2: which wire field / paise column / override-flag column each
// reimbursement maps to. Driving computeEffectiveReimbursements off this
// table (rather than four hand-written if-blocks) means adding a fifth
// reimbursement field later is a one-line change, not a copy-paste.
const REIMBURSEMENT_FIELDS = [
  { rupees: "toll_rupees", paise: "toll_paise", override: "toll_manual_override" },
  { rupees: "parking_rupees", paise: "parking_paise", override: "parking_manual_override" },
  { rupees: "permit_rupees", paise: "permit_paise", override: "permit_manual_override" },
  { rupees: "fasttag_rupees", paise: "fasttag_paise", override: "fasttag_manual_override" },
];

/**
 * Auto-sum-with-manual-override for the four reimbursement columns
 * (toll/parking/permit/fasttag). Called exactly once per create/PATCH
 * (Rule 4 — normalize once at the service boundary), never per-field.
 *
 * Precedence per field:
 *   1. A user-provided *_rupees value in THIS request always wins and
 *      sets manual_override=true. Checked with `!= null` rather than a
 *      truthiness/undefined check — an explicit 0 ("no fasttag on this
 *      invoice") is a real answer, not "the user didn't touch this
 *      field", so it must set the override flag too.
 *   2. Otherwise, if the invoice already carries manual_override=true
 *      for that field (PATCH only — `existingInvoice` is null on
 *      create), the existing paise value carries over unchanged. This
 *      is what makes an override survive a trip-set swap instead of
 *      being silently clobbered by a fresh auto-sum.
 *   3. Otherwise, auto-sum from the (possibly new) trip set.
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string[]} params.tripIds
 * @param {import('pg').PoolClient} params.client
 * @param {?object} params.userInput - raw create input or PATCH patch (rupees-shaped)
 * @param {?object} params.existingInvoice - null on create; current invoice row on PATCH
 * @returns {Promise<object>} { toll_paise, toll_manual_override, parking_paise, ... }
 */
async function computeEffectiveReimbursements({ tenantId, tripIds, client, userInput, existingInvoice }) {
  const sums = await tripRepo.summarizeReimbursements(tenantId, tripIds, client);

  const result = {};
  for (const f of REIMBURSEMENT_FIELDS) {
    const userGave = userInput?.[f.rupees] != null;

    if (userGave) {
      result[f.paise] = rupeesToPaise(userInput[f.rupees]);
      result[f.override] = true;
    } else if (existingInvoice?.[f.override]) {
      result[f.paise] = existingInvoice[f.paise];
      result[f.override] = true;
    } else {
      result[f.paise] = sums[f.paise];
      result[f.override] = false;
    }
  }
  return result;
}

/**
 * @param {?object} c - customers row
 * @returns {object}
 */
function shapeCustomerForPicker(c) {
  return {
    id: c.id,
    name: c.name,
    company_name: c.company_name,
    customer_type: c.customer_type,
    gstin: c.gstin,
    state_code: c.state_code,
    credit_days: c.credit_days,
  };
}

/**
 * Computes every derived financial column shared by create and update:
 * discount -> taxable amount -> GST (TAX only) -> grand total ->
 * round-off -> amount in words. Shared so the two entry points can
 * never drift apart on the arithmetic.
 *
 * @param {object} params
 * @returns {object}
 */
function computeInvoiceFinancials({
  subtotalPaise,
  discountPaise,
  tollPaise,
  parkingPaise,
  permitPaise,
  fasttagPaise,
  invoiceType,
  gstRate,
  sameState,
}) {
  const taxableAmountPaise = Math.max(0, subtotalPaise - discountPaise);

  let gstRateSnapshot = null;
  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;
  let totalGstPaise = 0;

  if (invoiceType === "TAX") {
    gstRateSnapshot = gstRate;
    try {
      ({ cgstPaise, sgstPaise, igstPaise, totalGstPaise } = computeGST({
        taxableAmountPaise,
        gstRate,
        sameState,
      }));
    } catch (err) {
      if (err instanceof DomainInputError) {
        throw apiError(400, "INVALID_GST_INPUT", err.message, { field: err.field, reason: err.reason });
      }
      throw err; // truly unexpected -> 500 is correct
    }
  }

  const grandTotalPaise = taxableAmountPaise + totalGstPaise + tollPaise + parkingPaise + permitPaise + fasttagPaise;
  const { roundOffPaise, netPayablePaise } = computeRoundOff(grandTotalPaise);
  const amountWords = amountInWords(netPayablePaise);

  return {
    taxableAmountPaise,
    gstRateSnapshot,
    cgstPaise,
    sgstPaise,
    igstPaise,
    totalGstPaise,
    grandTotalPaise,
    roundOffPaise,
    netPayablePaise,
    amountWords,
  };
}

/**
 * @param {?object} c - customers row
 * @returns {?object}
 */
function shapeCustomerRef(c) {
  if (!c) return null;
  return {
    id: c.id,
    customer_type: c.customer_type,
    name: c.name,
    company_name: c.company_name,
    gstin: c.gstin,
    state_code: c.state_code,
  };
}

/**
 * @param {?object} t - tenants row
 * @returns {?object}
 */
function shapeTenantRef(t) {
  if (!t) return null;
  return { id: t.id, name: t.name, gstin: t.gstin, state_code: t.state_code };
}

/**
 * @param {string} tenantId
 * @param {object} input - validated createInvoiceSchema output
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db - req.db
 * @returns {Promise<object>}
 */
async function createDraftInvoice(tenantId, input, actorUserId, db) {
  // Step 1: Normalize.
  // toll/parking/permit/fasttag are NOT converted here — they're
  // auto-summed-with-override by computeEffectiveReimbursements once
  // trips are resolved, inside the transaction below (Task 4.2).
  const discountPaise = input.discount_rupees !== undefined ? rupeesToPaise(input.discount_rupees) : 0;
  const discountReason = input.discount_reason?.trim() || null;
  const notes = input.notes?.trim() || null;
  const terms = input.terms?.trim() || null;
  const today = new Date().toISOString().slice(0, 10);
  const invoiceDate = input.invoice_date || today;
  const tripSheetIds = [...input.trip_sheet_ids];

  // Step 2: Derive. (Fiscal-year allocation is Task 4.3's concern —
  // DRAFT invoices carry no invoice_number, so nothing to derive yet.)

  // Step 3: Validate.
  if (invoiceDate > today) {
    throw apiError(400, "INVOICE_DATE_INVALID", "invoice_date cannot be in the future.");
  }
  if (daysBetweenISO(invoiceDate, today) > 30) {
    throw apiError(400, "INVOICE_DATE_INVALID", "invoice_date cannot be more than 30 days in the past.");
  }

  // Steps 4 + 5: Check (DB state) + Write, as one transaction.
  return db.withTenantContext(async (client) => {
    const tenant = await tenantRepo.findById(tenantId, client);

    const customer = await customerRepo.findById(tenantId, input.customer_id, client);
    if (!customer || !customer.is_active) {
      throw apiError(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    }

    const dueDate = input.due_date || addDaysISO(invoiceDate, customer.credit_days || 0);

    const tripsInOrder = await resolveTripsForInvoice(tenantId, tripSheetIds, null, customer.id, client);

    const reimbursements = await computeEffectiveReimbursements({
      tenantId,
      tripIds: tripSheetIds,
      client,
      userInput: input,
      existingInvoice: null,
    });

    const lines = buildInvoiceLines(tripsInOrder);
    const subtotalPaise = lines.reduce((sum, l) => sum + l.lineAmountPaise, 0);

    const sameState = isSameState(customer.state_code, tenant.state_code);
    const financials = computeInvoiceFinancials({
      subtotalPaise,
      discountPaise,
      tollPaise: reimbursements.toll_paise,
      parkingPaise: reimbursements.parking_paise,
      permitPaise: reimbursements.permit_paise,
      fasttagPaise: reimbursements.fasttag_paise,
      invoiceType: input.invoice_type,
      gstRate: tenant.gst_rate,
      sameState,
    });

    const invoice = await invoiceRepo.insertDraft(
      tenantId,
      {
        invoiceType: input.invoice_type,
        customerId: customer.id,
        invoiceDate,
        dueDate,
        notes,
        terms,
        subtotalPaise,
        gstRateSnapshot: financials.gstRateSnapshot,
        cgstPaise: financials.cgstPaise,
        sgstPaise: financials.sgstPaise,
        igstPaise: financials.igstPaise,
        totalGstPaise: financials.totalGstPaise,
        tollPaise: reimbursements.toll_paise,
        parkingPaise: reimbursements.parking_paise,
        permitPaise: reimbursements.permit_paise,
        fasttagPaise: reimbursements.fasttag_paise,
        discountPaise,
        discountReason,
        roundOffPaise: financials.roundOffPaise,
        grandTotalPaise: financials.grandTotalPaise,
        netPayablePaise: financials.netPayablePaise,
        amountInWords: financials.amountWords,
        tollManualOverride: reimbursements.toll_manual_override,
        parkingManualOverride: reimbursements.parking_manual_override,
        permitManualOverride: reimbursements.permit_manual_override,
        fasttagManualOverride: reimbursements.fasttag_manual_override,
        reverseCharge: input.reverse_charge ?? null,
        createdBy: actorUserId,
      },
      client,
    );

    const insertedLines = await lineRepo.insertBatch(tenantId, invoice.id, lines, client);
    await tripRepo.setHold(tenantId, tripSheetIds, invoice.id, client);

    return { ...invoice, lines: insertedLines };
  });
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
async function getInvoice(tenantId, id, db) {
  const result = await db.withTenantContext(async (client) => {
    const invoice = await invoiceRepo.findById(tenantId, id, client);
    if (!invoice) return null;
    const lines = await lineRepo.listByInvoice(tenantId, id, client);
    const customer = await customerRepo.findById(tenantId, invoice.customer_id, client);
    const tenant = await tenantRepo.findById(tenantId, client);
    return { ...invoice, lines, customer: shapeCustomerRef(customer), tenant: shapeTenantRef(tenant) };
  });
  if (!result) {
    throw apiError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
  }
  return result;
}

/**
 * PATCH /invoices/:invoiceId — editable only while an invoice is DRAFT.
 * Sending `trip_sheet_ids` REPLACES the trip set entirely (not a
 * merge); every financial column is always recomputed as a group,
 * never patched independently, mirroring
 * tripSheet.service.js#updateTripSheet's derived-totals discipline.
 *
 * @param {string} tenantId
 * @param {string} id
 * @param {object} patch - validated updateInvoiceSchema output
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
async function updateDraftInvoice(tenantId, id, patch, actorUserId, db) {
  // Step 1: Normalize.
  // toll/parking/permit/fasttag are NOT converted here — they're
  // auto-summed-with-override by computeEffectiveReimbursements below,
  // once the (possibly replaced) trip set is known (Task 4.2).
  const discountPaiseInPatch = patch.discount_rupees !== undefined ? rupeesToPaise(patch.discount_rupees) : undefined;
  const tripSheetIdsInPatch = Object.prototype.hasOwnProperty.call(patch, "trip_sheet_ids");

  // Steps 2-3: nothing beyond what Joi + the DB CHECK constraints cover.

  return db.withTenantContext(async (client) => {
    const invoice = await invoiceRepo.findByIdForUpdate(tenantId, id, client);
    if (!invoice) {
      throw apiError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
    }
    if (invoice.status !== "DRAFT") {
      throw apiError(409, "INVOICE_NOT_EDITABLE", "Only DRAFT invoices can be edited.", {
        current_status: invoice.status,
      });
    }

    let lines;
    let subtotalPaise = invoice.subtotal_paise;
    if (tripSheetIdsInPatch) {
      // Release first so the invoice's OWN currently-held trips count as
      // eligible again for resolveTripsForInvoice's re-check below (a
      // trip dropped from the new set becomes free; one kept in the new
      // set is re-validated and re-held, not left stale).
      await tripRepo.releaseHold(tenantId, invoice.id, client);
      const tripsInOrder = await resolveTripsForInvoice(
        tenantId,
        patch.trip_sheet_ids,
        invoice.id,
        invoice.customer_id,
        client,
      );
      const newLines = buildInvoiceLines(tripsInOrder);
      await lineRepo.deleteByInvoice(tenantId, invoice.id, client);
      lines = await lineRepo.insertBatch(tenantId, invoice.id, newLines, client);
      await tripRepo.setHold(tenantId, patch.trip_sheet_ids, invoice.id, client);
      subtotalPaise = newLines.reduce((sum, l) => sum + l.lineAmountPaise, 0);
    } else {
      lines = await lineRepo.listByInvoice(tenantId, invoice.id, client);
    }

    const effectiveDiscountPaise = discountPaiseInPatch !== undefined ? discountPaiseInPatch : invoice.discount_paise;

    // Effective trip set for the auto-sum: the just-rebuilt lines when
    // trip_sheet_ids was patched, otherwise the lines already loaded
    // above (untouched trip set).
    const effectiveTripIds = lines.map((l) => l.trip_sheet_id);
    const reimbursements = await computeEffectiveReimbursements({
      tenantId,
      tripIds: effectiveTripIds,
      client,
      userInput: patch,
      existingInvoice: invoice,
    });

    const customer = await customerRepo.findById(tenantId, invoice.customer_id, client);
    const tenant = await tenantRepo.findById(tenantId, client);
    const sameState = isSameState(customer.state_code, tenant.state_code);

    // gst_rate_snapshot is never implicitly re-derived from the
    // tenant's CURRENT setting on edit — same "never an implicit
    // re-lookup" principle as
    // tripSheet.service.js#resolveRuleForRecompute. Only trip-set/
    // charge fields change here; the applicable GST rate stays whatever
    // it was frozen to at invoice creation.
    const gstRate = invoice.invoice_type === "TAX" ? invoice.gst_rate_snapshot : null;

    const financials = computeInvoiceFinancials({
      subtotalPaise,
      discountPaise: effectiveDiscountPaise,
      tollPaise: reimbursements.toll_paise,
      parkingPaise: reimbursements.parking_paise,
      permitPaise: reimbursements.permit_paise,
      fasttagPaise: reimbursements.fasttag_paise,
      invoiceType: invoice.invoice_type,
      gstRate,
      sameState,
    });

    const patchToDb = {
      subtotal_paise: subtotalPaise,
      gst_rate_snapshot: financials.gstRateSnapshot,
      cgst_paise: financials.cgstPaise,
      sgst_paise: financials.sgstPaise,
      igst_paise: financials.igstPaise,
      total_gst_paise: financials.totalGstPaise,
      toll_paise: reimbursements.toll_paise,
      parking_paise: reimbursements.parking_paise,
      permit_paise: reimbursements.permit_paise,
      fasttag_paise: reimbursements.fasttag_paise,
      toll_manual_override: reimbursements.toll_manual_override,
      parking_manual_override: reimbursements.parking_manual_override,
      permit_manual_override: reimbursements.permit_manual_override,
      fasttag_manual_override: reimbursements.fasttag_manual_override,
      discount_paise: effectiveDiscountPaise,
      round_off_paise: financials.roundOffPaise,
      grand_total_paise: financials.grandTotalPaise,
      net_payable_paise: financials.netPayablePaise,
      amount_in_words: financials.amountWords,
    };
    if (patch.invoice_date !== undefined) patchToDb.invoice_date = patch.invoice_date;
    if (patch.due_date !== undefined) patchToDb.due_date = patch.due_date;
    if (patch.notes !== undefined) patchToDb.notes = patch.notes?.trim() || null;
    if (patch.terms !== undefined) patchToDb.terms = patch.terms?.trim() || null;
    if (patch.discount_reason !== undefined) patchToDb.discount_reason = patch.discount_reason?.trim() || null;
    if (patch.reverse_charge !== undefined) patchToDb.reverse_charge = patch.reverse_charge;

    const updated = await invoiceRepo.updateDraft(tenantId, id, patchToDb, client);
    if (!updated) {
      // Shouldn't happen — findByIdForUpdate holds the row lock for
      // this whole transaction — but defensive, same as
      // tripSheet.service.js#updateTripSheet's equivalent guard.
      throw apiError(
        409,
        "INVOICE_STATUS_CHANGED_DURING_UPDATE",
        "Invoice status changed while updating. Reload and retry.",
        { invoice_id: id },
      );
    }

    return { ...updated, lines };
  });
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ deleted: true, id: string }>}
 */
async function deleteDraftInvoice(tenantId, id, actorUserId, db) {
  return db.withTenantContext(async (client) => {
    const invoice = await invoiceRepo.findByIdForUpdate(tenantId, id, client);
    if (!invoice) {
      throw apiError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
    }
    if (invoice.status !== "DRAFT") {
      throw apiError(409, "INVOICE_NOT_DELETABLE", "Only DRAFT invoices can be deleted.", {
        current_status: invoice.status,
      });
    }
    // Cascades to invoice_lines (ON DELETE CASCADE) and releases any
    // trip holds (ON DELETE SET NULL on trip_sheets.held_by_invoice_id)
    // — no manual cleanup needed here.
    await invoiceRepo.deleteDraft(tenantId, id, client);
    return { deleted: true, id };
  });
}

/**
 * GET /customers/:customerId/invoiceable-trips — the checkbox picker a
 * frontend uses to build POST /invoices' trip_sheet_ids. Groups
 * FINALIZED, unheld trips for one customer by service_type, with
 * per-group and overall aggregate summaries.
 *
 * @param {string} tenantId
 * @param {string} customerId
 * @param {{ invoice_id?: string }} query - validated invoiceableTripsQuerySchema output
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
async function getInvoiceableTripsForCustomer(tenantId, customerId, query, db) {
  // Step 1: Normalize.
  const excludeInvoiceId = query.invoice_id ?? null;

  return db.withTenantContext(async (client) => {
    // Step 3: Validate.
    const customer = await customerRepo.findById(tenantId, customerId, client);
    if (!customer || !customer.is_active) {
      throw apiError(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    }

    // Steps 4-5: Read (no transaction needed beyond the tenant-context
    // session-var setter — this is a pure read).
    const trips = await tripRepo.findInvoiceableForCustomer(tenantId, customerId, excludeInvoiceId, client);

    const groups = { LOCAL: [], OUTSTATION: [] };
    for (const t of trips) {
      groups[t.service_type].push(t);
    }

    const sumField = (rows, key) => rows.reduce((acc, r) => acc + r[key], 0);
    const summarize = (rows) => ({
      count: rows.length,
      total_km: sumField(rows, "total_km"),
      total_subtotal_paise: sumField(rows, "subtotal_paise"),
      total_gross_paise: sumField(rows, "gross_paise"),
      total_net_payable_paise: sumField(rows, "net_payable_paise"),
    });

    return {
      customer: shapeCustomerForPicker(customer),
      groups: {
        LOCAL: { trips: groups.LOCAL, summary: summarize(groups.LOCAL) },
        OUTSTATION: { trips: groups.OUTSTATION, summary: summarize(groups.OUTSTATION) },
      },
      total_summary: summarize(trips),
    };
  });
}

/**
 * PATCH /invoices/:invoiceId/lines/:lineId — DRAFT-only. Only
 * `description` is editable (invoiceLine.repository.js#LINE_UPDATABLE_COLUMNS);
 * line_amount and every trip-derived field stay a frozen snapshot.
 *
 * @param {string} tenantId
 * @param {string} invoiceId
 * @param {string} lineId
 * @param {{ description: string }} patch - validated updateLineSchema output
 * @param {string} actorUserId - unused today; kept in the signature for
 *   parity with every other mutating service function here, and in case
 *   line-edit audit logging is added later.
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ line: object }>}
 */
// eslint-disable-next-line no-unused-vars
async function updateInvoiceLine(tenantId, invoiceId, lineId, patch, actorUserId, db) {
  // Step 1: Normalize.
  const description = patch.description?.trim() || null;
  if (!description) {
    throw apiError(400, "VALIDATION_ERROR", "Description cannot be empty.");
  }

  // Steps 4 + 5: Check (DB state) + Write, as one transaction.
  return db.withTenantContext(async (client) => {
    const invoice = await invoiceRepo.findByIdForUpdate(tenantId, invoiceId, client);
    if (!invoice) {
      throw apiError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
    }
    if (invoice.status !== "DRAFT") {
      throw apiError(409, "INVOICE_NOT_EDITABLE", "Only DRAFT invoices can be edited.", {
        current_status: invoice.status,
      });
    }

    const line = await lineRepo.findById(tenantId, invoiceId, lineId, client);
    if (!line) {
      throw apiError(404, "LINE_NOT_FOUND", "Invoice line not found.");
    }

    const updated = await lineRepo.updateLine(tenantId, invoiceId, lineId, { description }, client);
    if (!updated) {
      // Shouldn't happen — findByIdForUpdate holds the row lock for
      // this whole transaction — but defensive, same pattern as every
      // other guarded update in this file.
      throw apiError(
        409,
        "INVOICE_STATUS_CHANGED_DURING_UPDATE",
        "Invoice status changed while updating. Reload and retry.",
        { invoice_id: invoiceId },
      );
    }

    return { line: updated };
  });
}

/**
 * Guard used by both issueInvoice and cancelInvoice — same shape as
 * tripSheet.service.js#assertTransition, just against the invoice
 * state machine instead of the trip one.
 *
 * @param {{ status: string }} invoice
 * @param {string} toStatus
 */
function assertInvoiceTransition(invoice, toStatus) {
  if (!isValidTransition(invoice.status, toStatus)) {
    throw apiError(
      409,
      "INVALID_INVOICE_STATE_TRANSITION",
      `Invoice in status '${invoice.status}' cannot transition to '${toStatus}'.`,
      {
        current_status: invoice.status,
        requested_status: toStatus,
        allowed_transitions: allowedTransitions(invoice.status),
      },
    );
  }
}

/**
 * POST /invoices/:invoiceId/issue — DRAFT -> ISSUED. Allocates the
 * legal invoice number atomically, freezes tenant/customer state into
 * the invoice's snapshot columns, and flips every trip on the invoice
 * from FINALIZED to INVOICED — all inside one transaction, so a
 * failure partway through (a stale trip status, a number collision)
 * rolls back the number allocation and every trip transition together
 * rather than leaving the system half-issued.
 *
 * @param {string} tenantId
 * @param {string} id
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<object>}
 */
async function issueInvoice(tenantId, id, actorUserId, db) {
  return db.withTenantContext(async (client) => {
    const invoice = await invoiceRepo.findByIdForUpdate(tenantId, id, client);
    if (!invoice) {
      throw apiError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
    }

    assertInvoiceTransition(invoice, "ISSUED");

    // Both should always exist — an invoice's own tenant and its
    // customer_id (FK, ON DELETE RESTRICT) can't disappear out from
    // under it. If they somehow do, a 500 correctly signals a data
    // integrity failure rather than a routine 404.
    const tenant = await tenantRepo.findById(tenantId, client);
    const customer = await customerRepo.findById(tenantId, invoice.customer_id, client);

    const prefix = invoice.invoice_type === "TAX" ? tenant.invoice_prefix : tenant.performance_prefix;

    const invoiceNumber = await allocateInvoiceNumber({
      client,
      tenantId,
      invoiceType: invoice.invoice_type,
      invoiceDate: invoice.invoice_date,
      prefix,
    });

    const tenantSnapshot = buildTenantSnapshot(tenant);
    const customerSnapshot = buildCustomerSnapshot(customer);

    // Recomputed here (not just trusted from DRAFT) in case some edit
    // path changed net_payable_paise without refreshing the words —
    // cheap insurance, safe to overwrite either way.
    const amountWords = amountInWords(invoice.net_payable_paise);

    const issued = await invoiceRepo.transitionStatus(
      tenantId,
      id,
      invoice.status,
      "ISSUED",
      { issuedAt: new Date(), issuedBy: actorUserId },
      { tenantSnapshot, customerSnapshot },
      invoiceNumber,
      client,
    );
    if (!issued) {
      // Shouldn't happen — findByIdForUpdate holds the row lock for
      // this whole transaction — but defensive, same pattern as every
      // other guarded transition in this file.
      throw apiError(409, "INVOICE_STATUS_CHANGED", "Invoice status changed during issue. Reload and retry.", {
        invoice_id: id,
      });
    }

    // transitionStatus's own column list doesn't include
    // amount_in_words (see its comment) — write it separately.
    await client.query("UPDATE invoices SET amount_in_words = $1 WHERE id = $2::uuid AND tenant_id = $3::uuid", [
      amountWords,
      id,
      tenantId,
    ]);

    const tripIds = (await lineRepo.listByInvoice(tenantId, id, client)).map((l) => l.trip_sheet_id);
    await tripService.markTripsInvoiced(tenantId, tripIds, id, actorUserId, client);
    // No longer needed once every trip is INVOICED — the hold's job
    // was only to prevent double-booking a trip across two DRAFTS.
    await tripRepo.releaseHold(tenantId, id, client);

    const finalInvoice = await invoiceRepo.findById(tenantId, id, client);
    const lines = await lineRepo.listByInvoice(tenantId, id, client);
    return { ...finalInvoice, lines };
  });
}

/**
 * POST /invoices/:invoiceId/cancel. Two shapes depending on where the
 * invoice was in its lifecycle:
 *   - DRAFT: a plain status flip + trip-hold release. No credit note —
 *     the invoice was never legally issued, so there's nothing to
 *     reverse for GST purposes.
 *   - ISSUED/PAID: a legal cancellation. Issues a credit note (its own
 *     gap-free number, its own tenant/customer snapshot as of NOW,
 *     mirroring the invoice's frozen totals as the reversal amount),
 *     flips the invoice to CANCELLED, and reverses every trip on it
 *     back to FINALIZED (re-invoiceable) — all in one transaction.
 *
 * @param {string} tenantId
 * @param {string} id
 * @param {{ reason: string }} input - validated cancelInvoiceSchema output
 * @param {string} actorUserId
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ invoice: object, credit_note: ?object }>}
 */
async function cancelInvoice(tenantId, id, { reason }, actorUserId, db) {
  // Step 1: Normalize.
  const trimmedReason = reason.trim();

  return db.withTenantContext(async (client) => {
    const invoice = await invoiceRepo.findByIdForUpdate(tenantId, id, client);
    if (!invoice) {
      throw apiError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
    }

    assertInvoiceTransition(invoice, "CANCELLED");

    if (invoice.status === "DRAFT") {
      await tripRepo.releaseHold(tenantId, invoice.id, client);

      const cancelled = await invoiceRepo.transitionStatus(
        tenantId,
        id,
        "DRAFT",
        "CANCELLED",
        { cancelledAt: new Date(), cancelledBy: actorUserId, cancellationReason: trimmedReason },
        null,
        null,
        client,
      );
      if (!cancelled) {
        throw apiError(409, "INVOICE_STATUS_CHANGED", "Invoice status changed during cancel. Reload and retry.", {
          invoice_id: id,
        });
      }

      return { invoice: cancelled, credit_note: null };
    }

    // ISSUED or PAID: legal cancellation via credit note.
    const tenant = await tenantRepo.findById(tenantId, client);
    const customer = await customerRepo.findById(tenantId, invoice.customer_id, client);

    // A plain ISO date string, not a raw Date — every other calendar
    // date in this codebase (invoice_date, trip_date, ...) is handled
    // as 'YYYY-MM-DD' specifically to sidestep the local-midnight/
    // UTC-midnight shift documented repeatedly elsewhere (Task 2.2);
    // invoiceNumber.js#allocateCreditNoteNumber expects that same shape.
    const creditNoteDateStr = new Date().toISOString().slice(0, 10);

    const cnNumber = await allocateCreditNoteNumber({
      client,
      tenantId,
      creditNoteDate: creditNoteDateStr,
      prefix: tenant.credit_note_prefix,
    });

    const cnAmountWords = amountInWords(invoice.net_payable_paise);

    const creditNote = await creditNoteRepo.insert(
      tenantId,
      {
        creditNoteNumber: cnNumber,
        originalInvoiceId: invoice.id,
        customerId: invoice.customer_id,
        customerSnapshot: buildCustomerSnapshot(customer),
        tenantSnapshot: buildTenantSnapshot(tenant),
        subtotalPaise: invoice.subtotal_paise,
        totalGstPaise: invoice.total_gst_paise,
        cgstPaise: invoice.cgst_paise,
        sgstPaise: invoice.sgst_paise,
        igstPaise: invoice.igst_paise,
        tollPaise: invoice.toll_paise,
        parkingPaise: invoice.parking_paise,
        permitPaise: invoice.permit_paise,
        fasttagPaise: invoice.fasttag_paise,
        discountPaise: invoice.discount_paise,
        grandTotalPaise: invoice.grand_total_paise,
        netPayablePaise: invoice.net_payable_paise,
        creditNoteDate: creditNoteDateStr,
        reason: trimmedReason,
        amountInWords: cnAmountWords,
        issuedBy: actorUserId,
      },
      client,
    );

    const cancelled = await invoiceRepo.transitionStatus(
      tenantId,
      id,
      invoice.status,
      "CANCELLED",
      {
        cancelledAt: new Date(),
        cancelledBy: actorUserId,
        cancellationReason: trimmedReason,
        creditNoteId: creditNote.id,
      },
      null,
      null,
      client,
    );
    if (!cancelled) {
      throw apiError(409, "INVOICE_STATUS_CHANGED", "Invoice status changed during cancel. Reload and retry.", {
        invoice_id: id,
      });
    }

    const tripIds = (await lineRepo.listByInvoice(tenantId, id, client)).map((l) => l.trip_sheet_id);
    await tripService.reverseTripInvoiced(tenantId, tripIds, actorUserId, client);

    return { invoice: cancelled, credit_note: creditNote };
  });
}

/**
 * @param {string} tenantId
 * @param {string} id
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ credit_note: object }>}
 */
async function getCreditNote(tenantId, id, db) {
  const creditNote = await db.withTenantContext(async (client) => creditNoteRepo.findById(tenantId, id, client));
  if (!creditNote) {
    throw apiError(404, "CREDIT_NOTE_NOT_FOUND", "Credit note not found.");
  }
  return { credit_note: creditNote };
}

/**
 * @param {string} tenantId
 * @param {{ limit?: number, offset?: number }} query
 * @param {{ withTenantContext: Function }} db
 * @returns {Promise<{ credit_notes: object[], pagination: object }>}
 */
async function listCreditNotes(tenantId, query, db) {
  const limit = query.limit ?? 25;
  const offset = query.offset ?? 0;

  const result = await db.withTenantContext(async (client) => creditNoteRepo.list(tenantId, { limit, offset }, client));

  return {
    credit_notes: result.rows,
    pagination: {
      total: result.total,
      limit,
      offset,
      has_more: offset + result.rows.length < result.total,
    },
  };
}

module.exports = {
  createDraftInvoice,
  getInvoice,
  updateDraftInvoice,
  deleteDraftInvoice,
  getInvoiceableTripsForCustomer,
  updateInvoiceLine,
  issueInvoice,
  cancelInvoice,
  getCreditNote,
  listCreditNotes,
};
