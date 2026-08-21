/**
 * PDF generation + retrieval for invoices and credit notes (Task 4.5).
 *
 * ─── Flagged spec deviations (Rule 9/10 — reality over spec prose) ───
 * The Task 4.5 spec's own template/context pseudocode assumes several
 * fields that don't exist anywhere in this schema:
 *   - tenants has no tagline/phone/phone2/email/website/address
 *     columns — only name/gstin/pan/state_code/logo_url/bank_details/
 *     gst_rate exist (same gap invoiceSnapshot.js already flagged for
 *     Task 4.3's snapshot builders). The header/bank-details templates
 *     here only render fields that actually exist.
 *   - invoices has no reverse_charge or place_of_supply column, so
 *     "Place of Supply" is derived from the CUSTOMER's state_code
 *     (the standard GST convention: place of supply for a service is
 *     the recipient's state) rather than fabricated invoice columns.
 *   - invoice_lines stores one combined extras_amount_paise per line,
 *     not the spec's imagined base_km/base_hours/extra_km_rate_paise/
 *     extra_hr_rate_paise split. The Yellow/Blue tables show Package
 *     Amount + Extra Charges + Driver Bata + Taxable Value (all real
 *     columns) instead of a KM/Hr rate breakdown that was never
 *     stored. Per-km rate IS shown on the Blue/Performance tables, but
 *     as a derived display value (base_amount_paise / total_km) —
 *     informational only, never written back to the DB.
 *   - invoice_lines has no per-line toll column — toll/parking/permit/
 *     fasttag are invoice-level aggregates only (Task 4.1 schema), so
 *     they're shown once in the totals block, not per line.
 *   - credit_notes has no line-item table at all — it stores only the
 *     original invoice's frozen aggregate totals. credit-note.hbs
 *     renders the single-row "reversal of invoice X" summary the Task
 *     4.5 spec itself offered as a fallback, since the alternative
 *     (per-line reversal detail) has nothing to read from.
 *
 * Render context is built directly from invoice.tenant_snapshot /
 * invoice.customer_snapshot (and the credit note's own snapshots) —
 * the same frozen, write-once JSONB Task 4.3 already populates at
 * issue/cancel — rather than re-fetching live tenant/customer rows.
 * PDF generation is only ever legal on non-DRAFT documents (see the
 * INVOICE_NOT_ISSUED guard below), so the snapshot is always present
 * and is exactly the "state as of issue" a legal document must show.
 */

const path = require("path");
const fs = require("fs").promises;

const env = require("../config/env");
const pdfEngine = require("./pdfEngine.service");
const invoiceRepo = require("../repositories/invoice.repository");
const creditNoteRepo = require("../repositories/creditNote.repository");
const invoiceLineRepo = require("../repositories/invoiceLine.repository");
const tripSheetRepo = require("../repositories/tripSheet.repository");
const customerRepo = require("../repositories/customer.repository");
const tenantRepo = require("../repositories/tenant.repository");
const { apiError } = require("../utils/httpError");
const { stateNameForCode } = require("../constants/gstStateCodes");
const logger = require("../utils/logger");
// Trip sheets carry no frozen tenant/customer snapshot of their own
// (that's an invoice-only concept, written once at issue — see this
// file's own top comment) — buildTripSheetRenderContext below reuses
// these SAME snapshot-shaping functions on a LIVE tenant/customer row
// instead, to get the exact flat field shape shared/header.hbs and
// shared/bill-to.hbs already expect (address_line1/city/pincode/etc.)
// without duplicating that shaping logic.
const { buildTenantSnapshot, buildCustomerSnapshot } = require("../utils/invoiceSnapshot");
const { amountInWords } = require("../domain/gst/amountInWords");

const VEHICLE_TYPE_LABELS = {
  SEDAN: "Sedan",
  SUV: "SUV",
  HATCHBACK: "Hatchback",
  INNOVA: "Innova",
  KIA_CARNIVAL: "KIA Carnival",
  TEMPO_TRAVELLER: "Tempo Traveller",
  MINI_BUS: "Mini Bus",
  BUS_50_SEATER: "Bus (50-Seater)",
  OTHER: "Other",
};

function humanizeVehicleType(type) {
  return VEHICLE_TYPE_LABELS[type] || type;
}

let partialsLoaded = null;

/**
 * Registers every shared/*.hbs file as a Handlebars partial exactly
 * once per process — subsequent calls are a no-op via the memoized
 * promise, same "load once, cache forever" reasoning as
 * pdfEngine.service.js#loadTemplate's templateCache.
 */
async function ensurePartialsLoaded(version) {
  if (partialsLoaded) return partialsLoaded;
  partialsLoaded = (async () => {
    const partialsDir = path.join(__dirname, "../templates/pdf", version, "shared");
    const files = await fs.readdir(partialsDir);
    for (const file of files) {
      if (!file.endsWith(".hbs")) continue;
      const name = "shared/" + file.replace(/\.hbs$/, "");
      const content = await fs.readFile(path.join(partialsDir, file), "utf-8");
      pdfEngine.registerPartial(name, content);
    }
  })();
  return partialsLoaded;
}

/**
 * Yellow (LOCAL tax), Blue (OUTSTATION tax), or — since Task 4.7 split
 * the single "Performance" template in two — Proforma Local/Outstation.
 * TAX invoices are guaranteed single-service_type by Task 4.3's own
 * validation, so the first line's service_type is authoritative for
 * the whole invoice. invoice_type stays 'PERFORMANCE' in the DB enum
 * (renaming it to PROFORMA would need a migration + backfill, out of
 * scope for Task 4.7); "Proforma" is a user-facing label/template
 * choice only.
 *
 * Keyed by template version, not just invoice_type/service_type,
 * because v1.0.0 never split Performance by service_type — a PDF
 * regenerated for an invoice whose pdf_template_version is still
 * 'v1.0.0' (Task 4.7 ADR: template versioning) must keep resolving to
 * the single invoice-performance.hbs it originally rendered with, not
 * the new split template, or a historical document's layout would
 * silently change on re-generation.
 */
const TEMPLATE_MAP = {
  "v1.0.0": {
    "TAX:LOCAL": "invoice-local-tax",
    "TAX:OUTSTATION": "invoice-outstation-tax",
    "PERFORMANCE:LOCAL": "invoice-performance",
    "PERFORMANCE:OUTSTATION": "invoice-performance",
  },
  "v1.1.0": {
    "TAX:LOCAL": "invoice-local-tax",
    "TAX:OUTSTATION": "invoice-outstation-tax",
    "PERFORMANCE:LOCAL": "invoice-proforma-local",
    "PERFORMANCE:OUTSTATION": "invoice-proforma-outstation",
  },
};

function pickInvoiceTemplateName(invoice, lines, templateVersion) {
  const firstLine = lines[0];
  if (!firstLine) {
    throw apiError(400, "INVOICE_HAS_NO_LINES", "Cannot generate a PDF for an invoice with no lines.");
  }
  const versionMap = TEMPLATE_MAP[templateVersion];
  if (!versionMap) {
    throw apiError(500, "PDF_TEMPLATE_ERROR", `No template map defined for version ${templateVersion}.`);
  }
  const key = `${invoice.invoice_type}:${firstLine.service_type}`;
  const templateFile = versionMap[key];
  if (!templateFile) {
    throw apiError(500, "PDF_TEMPLATE_ERROR", `No template for ${key} at ${templateVersion}.`);
  }
  return templateFile;
}

/**
 * Task 4.7: derives the LOCAL extra-KM/extra-hours split and the
 * OUTSTATION per-line toll/total-cost columns the reference invoices
 * (PTT-150/151) show, from data listByInvoiceForPdf already joins in
 * (see that function's comment) — none of this is fabricated, it's
 * the same arithmetic src/domain/pricing/local.js itself used to
 * produce extras_amount_paise, just re-expressed as its two addends
 * instead of the stored combined sum.
 */
function enhanceLine(line) {
  const extraKm = line.snap_base_km != null ? Math.max(0, Number(line.total_km) - Number(line.snap_base_km)) : null;
  const extraHrs =
    line.snap_base_hours != null ? Math.max(0, Number(line.total_hours) - Number(line.snap_base_hours)) : null;
  const extraKmRatePaise = line.snap_extra_km_rate_paise != null ? Number(line.snap_extra_km_rate_paise) : null;
  const extraHrRatePaise = line.snap_extra_hr_rate_paise != null ? Number(line.snap_extra_hr_rate_paise) : null;
  const extraKmAmountPaise = extraKm != null && extraKmRatePaise != null ? extraKm * extraKmRatePaise : null;
  const extraHrsAmountPaise = extraHrs != null && extraHrRatePaise != null ? extraHrs * extraHrRatePaise : null;
  const tollPaise = Number(line.toll_paise || 0);
  const parkingPaise = Number(line.parking_paise || 0);

  const perKmRatePaise =
    line.snap_slab_rate_paise != null
      ? Number(line.snap_slab_rate_paise)
      : line.total_km > 0
        ? Math.round(Number(line.base_amount_paise) / line.total_km)
        : 0;

  return {
    ...line,
    vehicle_type_label: humanizeVehicleType(line.vehicle_type),
    per_km_rate_paise: perKmRatePaise,
    extra_km: extraKm,
    extra_km_rate_paise: extraKmRatePaise,
    extra_km_amount_paise: extraKmAmountPaise,
    extra_hrs: extraHrs,
    extra_hr_rate_paise: extraHrRatePaise,
    extra_hrs_amount_paise: extraHrsAmountPaise,
    toll_parking_paise: tollPaise + parkingPaise,
    total_cost_paise: Number(line.line_amount_paise) + tollPaise,
  };
}

/**
 * Calendar dates in this codebase are plain 'YYYY-MM-DD' strings (see
 * db.js's DATE type-parser override), so lexicographic min/max IS
 * chronological min/max — no Date object round-trip needed (that
 * round-trip is exactly what introduces the local-midnight/UTC shift
 * this codebase has repeatedly worked around elsewhere).
 */
function computeBillingCycle(lines) {
  if (lines.length === 0) return null;
  let from = lines[0].trip_date;
  let to = lines[0].trip_date;
  for (const line of lines) {
    if (line.trip_date < from) from = line.trip_date;
    if (line.trip_date > to) to = line.trip_date;
  }
  return { from, to };
}

function buildTenantRenderContext(tenantSnapshot) {
  const t = tenantSnapshot || {};
  return {
    ...t,
    logo_initials: (t.name || "P").charAt(0).toUpperCase(),
    state_name: stateNameForCode(t.state_code),
  };
}

function buildCustomerRenderContext(customerSnapshot) {
  const c = customerSnapshot || {};
  return {
    ...c,
    state_name: stateNameForCode(c.state_code),
  };
}

function buildInvoiceRenderContext(invoice, lines, templateName) {
  const gstRate = invoice.gst_rate_snapshot != null ? Number(invoice.gst_rate_snapshot) : null;
  const customer = buildCustomerRenderContext(invoice.customer_snapshot);
  const enhancedLines = lines.map(enhanceLine);

  // Per-line "Toll / Parking" (LOCAL) and "Total Cost" (OUTSTATION)
  // columns (Task 4.7, PTT-150/151 parity) are a display breakdown of
  // real per-trip data, not a re-derivation of the invoice's own
  // reimbursement/net-payable totals — the footer row under each of
  // those columns sums the same per-line values shown above it, kept
  // as its own total rather than reusing reimbursements_paise/
  // net_payable_paise (which may include permit/fasttag that this
  // column deliberately doesn't show, per PTT-151's own column set).
  const tollParkingTotalPaise = enhancedLines.reduce((sum, l) => sum + l.toll_parking_paise, 0);
  const tollTotalPaise = enhancedLines.reduce((sum, l) => sum + Number(l.toll_paise || 0), 0);
  const totalCostTotalPaise = enhancedLines.reduce((sum, l) => sum + l.total_cost_paise, 0);

  // Proforma (invoice_type PERFORMANCE) summary block (PTT-152 parity,
  // Task 4.7): "Trip Amount" is the base/running cost only, "Total
  // Extra Cost" is the extra-KM + extra-Hrs (LOCAL) or none
  // (OUTSTATION has no "extra" concept) portion — split back out of
  // subtotal_paise, which combines both.
  const tripAmountPaise = enhancedLines.reduce((sum, l) => sum + Number(l.base_amount_paise), 0);
  const totalExtraCostPaise = enhancedLines.reduce(
    (sum, l) => sum + (l.extra_km_amount_paise || 0) + (l.extra_hrs_amount_paise || 0),
    0,
  );
  const totalDriverBattaPaise = enhancedLines.reduce((sum, l) => sum + Number(l.driver_batta_paise || 0), 0);

  return {
    invoice,
    tenant: buildTenantRenderContext(invoice.tenant_snapshot),
    customer,
    lines: enhancedLines,
    billingCycle: computeBillingCycle(lines),
    // First line's trip is authoritative, same reasoning as
    // pickInvoiceTemplateName's service_type read — an invoice's
    // trips are always booked by the same person in practice, and
    // booked_by is real, already-captured data (trip_sheets.booked_by,
    // Task 3.x), just not previously plumbed through to the PDF.
    bookedBy: lines[0] ? lines[0].booked_by : null,
    toll_parking_total_paise: tollParkingTotalPaise,
    toll_total_paise: tollTotalPaise,
    total_cost_total_paise: totalCostTotalPaise,
    trip_amount_paise: tripAmountPaise,
    total_extra_cost_paise: totalExtraCostPaise,
    total_driver_batta_paise: totalDriverBattaPaise,
    placeOfSupplyStateName: customer.state_name,
    placeOfSupplyStateCode: customer.state_code,
    // Task 4.8: computed here (not read as invoice.reverse_charge
    // directly in the template) for the same reason
    // placeOfSupplyStateName is computed here rather than left as a
    // raw column read — shared/header.hbs is also used by
    // credit-note.hbs, whose render context has no `invoice` at all,
    // so a raw `invoice.reverse_charge` reference risks reintroducing
    // the exact "partials inherit the full parent context" leak Task
    // 4.7 already found and fixed for Place of Supply (see
    // known-issues.md). Present only when explicitly true/false, never
    // guessed — see invoice.validator.js's own comment on this field.
    reverseChargePresent: invoice.reverse_charge !== null && invoice.reverse_charge !== undefined,
    reverseChargeLabel: invoice.reverse_charge ? "Yes" : "No",
    subtotal_paise: invoice.subtotal_paise,
    cgst_paise: invoice.cgst_paise,
    sgst_paise: invoice.sgst_paise,
    igst_paise: invoice.igst_paise,
    discount_paise: invoice.discount_paise,
    reimbursements_paise:
      Number(invoice.toll_paise) + Number(invoice.parking_paise) + Number(invoice.permit_paise) + Number(invoice.fasttag_paise),
    round_off_paise: invoice.round_off_paise,
    net_payable_paise: invoice.net_payable_paise,
    amount_in_words: invoice.amount_in_words,
    cgst_rate: gstRate != null ? (gstRate / 2).toFixed(1) : null,
    sgst_rate: gstRate != null ? (gstRate / 2).toFixed(1) : null,
    gst_rate: gstRate,
  };
}

/**
 * Trip-sheet PDFs are ALWAYS Proforma-framed, never TAX — trip_sheets
 * has no gst_rate_snapshot/cgst_paise/sgst_paise/igst_paise columns at
 * all (GST is only ever computed later, at invoice-creation time, from
 * a trip's frozen subtotal), so there is no TAX-invoice path to
 * choose here. Keyed purely on service_type (billing_mode is
 * irrelevant to which document renders — a GST-mode trip's own PDF is
 * still a Proforma; billing_mode only decides what KIND of invoice
 * this trip is later eligible to be picked into). Only v1.1.0 exists
 * since this is a brand-new PDF feature with no v1.0.0 history to stay
 * compatible with — same reasoning as invoices' own template
 * versioning, just with nothing to freeze against yet.
 */
const TRIP_TEMPLATE_MAP = {
  "v1.1.0": {
    LOCAL: "invoice-proforma-local",
    OUTSTATION: "invoice-proforma-outstation",
  },
};

function pickTripSheetTemplateName(trip, templateVersion) {
  const versionMap = TRIP_TEMPLATE_MAP[templateVersion];
  if (!versionMap) {
    throw apiError(500, "PDF_TEMPLATE_ERROR", `No trip-sheet template map defined for version ${templateVersion}.`);
  }
  const templateFile = versionMap[trip.service_type];
  if (!templateFile) {
    throw apiError(500, "PDF_TEMPLATE_ERROR", `No trip-sheet template for service_type ${trip.service_type} at ${templateVersion}.`);
  }
  return templateFile;
}

/**
 * Reshapes a trip_sheets row into the SAME per-line shape enhanceLine()
 * already knows how to enrich for invoice PDFs, then runs it through
 * that unchanged function — a trip_sheets row already carries every
 * field enhanceLine() reads (toll_paise, parking_paise, total_km,
 * total_hours, snap_base_km, snap_base_hours, snap_extra_km_rate_paise,
 * snap_extra_hr_rate_paise, snap_slab_rate_paise, driver_batta_paise,
 * trip_date, trip_sheet_number) under IDENTICAL column names, since
 * invoiceLine.repository.js#listByInvoiceForPdf joins exactly these
 * trip_sheets columns onto each invoice_line row in the first place
 * (see that function's own comment). Only vehicle_number/vehicle_type/
 * line_number/line_amount_paise need aliasing — the trip's own
 * snapshot_vehicle_number/snapshot_vehicle_type instead of an
 * invoice_line's vehicle_number/vehicle_type, "1" since a trip is its
 * own single line, and line_amount_paise reconstructed as base+extras+
 * batta (ADR-010's "taxable revenue only" definition — EXCLUDING toll/
 * parking/permit/fasttag, which is why this is NOT simply
 * trip.subtotal_paise: for OUTSTATION, subtotal_paise already has toll/
 * parking/permit/fasttag folded in, and enhanceLine() adds toll_paise
 * back on top of line_amount_paise itself to get total_cost_paise —
 * reusing subtotal_paise here would double-count it).
 */
function buildTripSheetLine(trip) {
  return enhanceLine({
    ...trip,
    vehicle_number: trip.snapshot_vehicle_number,
    vehicle_type: trip.snapshot_vehicle_type,
    line_number: 1,
    line_amount_paise: trip.base_amount_paise + trip.extras_amount_paise + trip.driver_batta_paise,
  });
}

function buildTripSheetRenderContext(trip, tenant, customer) {
  const enhancedLine = buildTripSheetLine(trip);

  return {
    // shared/header.hbs reads docNumber=invoice.invoice_number and
    // docDate=invoice.invoice_date via the proforma templates' own
    // partial invocation — that hash-argument wiring lives INSIDE
    // invoice-proforma-{local,outstation}.hbs, unchanged, so this
    // context aliases a trip sheet into the same `invoice`-shaped key
    // rather than touching the templates. Not a real invoice; purely
    // satisfying the shared partial's expected context shape (Rule 10
    // — adapt to the real template contract, not invent a new one).
    invoice: { invoice_number: trip.trip_sheet_number, invoice_date: trip.trip_date },
    tenant: buildTenantRenderContext(tenant),
    customer: buildCustomerRenderContext(customer),
    lines: [enhancedLine],
    billingCycle: { from: trip.trip_date, to: trip.trip_date },
    bookedBy: trip.booked_by,
    toll_parking_total_paise: enhancedLine.toll_parking_paise,
    toll_total_paise: Number(trip.toll_paise || 0),
    total_cost_total_paise: enhancedLine.total_cost_paise,
    trip_amount_paise: Number(trip.base_amount_paise),
    total_extra_cost_paise: (enhancedLine.extra_km_amount_paise || 0) + (enhancedLine.extra_hrs_amount_paise || 0),
    total_driver_batta_paise: Number(trip.driver_batta_paise || 0),
    // invoice-proforma-local.hbs's own <tfoot> reads a TOP-LEVEL
    // subtotal_paise (mirroring invoice.subtotal_paise — the sum of
    // every line's line_amount_paise), not the per-line value already
    // on `lines[0]` — missing this rendered the table's Total row as
    // "0.00" (caught via Rule 13 visual review, not the smoke script,
    // which never asserted on that specific cell). Single line here,
    // so it's just that line's own line_amount_paise restated at the
    // top level.
    subtotal_paise: enhancedLine.line_amount_paise,
    // Trip sheets never carry a discount concept — explicitly zero,
    // not omitted, so the templates' `{{#if (gt discount_paise 0)}}`
    // guard resolves the same deterministic way an invoice with no
    // discount already does.
    discount_paise: 0,
    net_payable_paise: trip.net_payable_paise,
    amount_in_words: amountInWords(trip.net_payable_paise),
  };
}

function buildCreditNoteRenderContext(creditNote, originalInvoice) {
  const customer = buildCustomerRenderContext(creditNote.customer_snapshot);
  return {
    credit_note: creditNote,
    original_invoice: originalInvoice,
    tenant: buildTenantRenderContext(creditNote.tenant_snapshot),
    customer,
    natureOfSupply: `Credit note against invoice ${originalInvoice.invoice_number}`,
    placeOfSupplyStateName: customer.state_name,
    placeOfSupplyStateCode: customer.state_code,
    reimbursements_paise:
      Number(creditNote.toll_paise) +
      Number(creditNote.parking_paise) +
      Number(creditNote.permit_paise) +
      Number(creditNote.fasttag_paise),
  };
}

/**
 * Logs the ORIGINAL error (message/stack/name) plus correlation IDs
 * before it gets translated into a generic, client-safe apiError below
 * — this is what was missing: the previous catch blocks threw a brand
 * new Error with none of the real Puppeteer/Handlebars failure
 * attached, so Render's logs only ever showed "PDF_RENDER_FAILED" with
 * no way to tell a sandbox crash from a template bug from a timeout.
 * The original error is also attached as `.cause` on the thrown
 * apiError so it survives into errorHandler.js's own "Request failed"
 * log line as a second line of defense.
 */
function logAndWrapPdfError(stage, err, { templateName, templateVersion, correlation, code, message, details }) {
  logger.error(`PDF generation failed: ${stage}`, {
    err_message: err.message,
    err_stack: err.stack,
    err_name: err.name,
    template: templateName,
    template_version: templateVersion,
    ...correlation,
  });
  const apiErr = apiError(500, code, message, details);
  apiErr.cause = err;
  return apiErr;
}

/**
 * Puppeteer/Handlebars failures (browser crash, page timeout, a
 * missing template file) are infrastructure failures, not domain
 * errors — translate them at this boundary so a template-engine
 * exception never reaches the client as a raw, uncoded 500 (Rule 5).
 *
 * @param {object} [correlation] - e.g. { tenantId, invoiceId } or
 *   { tenantId, creditNoteId } — logged alongside every failure here so
 *   a Render log line can be traced back to the exact document.
 */
async function renderPdf(templateName, templateVersion, context, correlation = {}) {
  await ensurePartialsLoaded(templateVersion);
  let template;
  try {
    template = await pdfEngine.loadTemplate(templateName, templateVersion);
  } catch (err) {
    throw logAndWrapPdfError("template load", err, {
      templateName,
      templateVersion,
      correlation,
      code: "PDF_TEMPLATE_ERROR",
      message: "Could not load the PDF template.",
      details: { template: templateName },
    });
  }

  let html;
  try {
    html = template(context);
  } catch (err) {
    throw logAndWrapPdfError("template compile/render", err, {
      templateName,
      templateVersion,
      correlation,
      code: "PDF_TEMPLATE_ERROR",
      message: "Failed to render the PDF template.",
      details: { template: templateName },
    });
  }

  try {
    return await pdfEngine.renderHtmlToPdf(html);
  } catch (err) {
    throw logAndWrapPdfError("Puppeteer render", err, {
      templateName,
      templateVersion,
      correlation,
      code: "PDF_RENDER_FAILED",
      message: "PDF rendering failed. Please retry.",
    });
  }
}

async function writePdfFile(subdir, fileName, buffer) {
  const dirPath = path.join(env.pdfStorageRoot, subdir);
  await fs.mkdir(dirPath, { recursive: true });
  const filePath = path.join(dirPath, fileName);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

/**
 * Generates (or regenerates) the PDF for an issued/paid/cancelled
 * invoice and persists its metadata. Idempotent — re-running overwrites
 * the same file and DB row.
 *
 * @param {string} tenantId
 * @param {string} invoiceId
 * @param {object} db - req.db
 * @returns {Promise<object>}
 */
async function generateInvoicePdf(tenantId, invoiceId, db) {
  return db.withTenantContext(async (client) => {
    const invoice = await invoiceRepo.findById(tenantId, invoiceId, client);
    if (!invoice) {
      throw apiError(404, "INVOICE_NOT_FOUND", "Invoice not found.");
    }
    if (invoice.status === "DRAFT") {
      throw apiError(400, "INVOICE_NOT_ISSUED", "PDFs can only be generated for issued invoices.", {
        current_status: invoice.status,
      });
    }

    const lines = await invoiceLineRepo.listByInvoiceForPdf(tenantId, invoiceId, client);
    const templateVersion = invoice.pdf_template_version || pdfEngine.TEMPLATE_VERSION;
    const templateName = pickInvoiceTemplateName(invoice, lines, templateVersion);
    const context = buildInvoiceRenderContext(invoice, lines, templateName);

    const pdfBuffer = await renderPdf(templateName, templateVersion, context, { tenantId, invoiceId });

    const fileName = `${invoiceId}-${templateVersion}.pdf`;
    await writePdfFile(path.join(tenantId, "invoices"), fileName, pdfBuffer);
    const relativeUrl = `/pdf-storage/${tenantId}/invoices/${fileName}`;

    await client.query(
      `UPDATE invoices
       SET pdf_url = $1, pdf_generated_at = NOW(), pdf_template_version = $2, pdf_file_size_bytes = $3
       WHERE id = $4::uuid AND tenant_id = $5::uuid`,
      [relativeUrl, templateVersion, pdfBuffer.length, invoiceId, tenantId],
    );

    return {
      pdf_url: relativeUrl,
      pdf_template_version: templateVersion,
      pdf_file_size_bytes: pdfBuffer.length,
      pdf_generated_at: new Date().toISOString(),
    };
  });
}

/**
 * @param {string} tenantId
 * @param {string} creditNoteId
 * @param {object} db - req.db
 * @returns {Promise<object>}
 */
async function generateCreditNotePdf(tenantId, creditNoteId, db) {
  return db.withTenantContext(async (client) => {
    const creditNote = await creditNoteRepo.findById(tenantId, creditNoteId, client);
    if (!creditNote) {
      throw apiError(404, "CREDIT_NOTE_NOT_FOUND", "Credit note not found.");
    }

    const originalInvoice = await invoiceRepo.findById(tenantId, creditNote.original_invoice_id, client);

    const templateVersion = creditNote.pdf_template_version || pdfEngine.TEMPLATE_VERSION;
    const context = buildCreditNoteRenderContext(creditNote, originalInvoice);

    const pdfBuffer = await renderPdf("credit-note", templateVersion, context, { tenantId, creditNoteId });

    const fileName = `${creditNoteId}-${templateVersion}.pdf`;
    await writePdfFile(path.join(tenantId, "credit-notes"), fileName, pdfBuffer);
    const relativeUrl = `/pdf-storage/${tenantId}/credit-notes/${fileName}`;

    await client.query(
      `UPDATE credit_notes
       SET pdf_url = $1, pdf_generated_at = NOW(), pdf_template_version = $2, pdf_file_size_bytes = $3
       WHERE id = $4::uuid AND tenant_id = $5::uuid`,
      [relativeUrl, templateVersion, pdfBuffer.length, creditNoteId, tenantId],
    );

    return {
      pdf_url: relativeUrl,
      pdf_template_version: templateVersion,
      pdf_file_size_bytes: pdfBuffer.length,
      pdf_generated_at: new Date().toISOString(),
    };
  });
}

/**
 * Resolves the tenant/customer render blocks a trip sheet needs for
 * its PDF. Unlike invoices, a trip has no frozen snapshot to read —
 * this does a LIVE lookup instead (display data, not pricing; see this
 * file's top-of-imports comment). Three customer states:
 *   - trip.customer_id set: fetch the real row, run it through
 *     buildCustomerSnapshot for full address/phone/email/credit_days.
 *   - trip.customer_id null but a name was captured
 *     (snapshot_customer_name, set from manual_customer_name at
 *     create-time — see tripSheet.service.js): a minimal
 *     snapshot-shaped object with just a name, no address/GSTIN/etc.
 *     to fabricate.
 *   - neither: a clearly-labeled placeholder rather than a blank
 *     "Bill To" block, which would look like a rendering bug rather
 *     than a deliberate "no customer" trip on visual review (Rule 13).
 *
 * @param {string} tenantId
 * @param {object} trip - a trip_sheets row (findById's `SELECT *`)
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{ tenantSnapshot: object, customerSnapshot: object }>}
 */
async function resolveTripSheetPdfParties(tenantId, trip, client) {
  const tenant = await tenantRepo.findById(tenantId, client);
  const tenantSnapshot = buildTenantSnapshot(tenant);

  let customerSnapshot;
  if (trip.customer_id) {
    const customer = await customerRepo.findById(tenantId, trip.customer_id, client);
    customerSnapshot = customer ? buildCustomerSnapshot(customer) : { name: trip.snapshot_customer_name };
  } else if (trip.snapshot_customer_name) {
    customerSnapshot = { name: trip.snapshot_customer_name };
  } else {
    customerSnapshot = { name: "No customer specified" };
  }

  return { tenantSnapshot, customerSnapshot };
}

/**
 * Generates (or regenerates) the Proforma PDF for a trip sheet.
 * Mirrors generateInvoicePdf's structure exactly (storage path shape,
 * pdf tracking column UPDATE, idempotent overwrite) — see that
 * function's own doc comment. Deliberately does NOT touch the pricing
 * calculator: every number rendered comes straight off the trip's own
 * already-frozen columns (base_amount_paise, extras_amount_paise,
 * driver_batta_paise, subtotal_paise, gross_paise, net_payable_paise,
 * breakdown) via buildTripSheetRenderContext, never recomputed.
 *
 * @param {string} tenantId
 * @param {string} tripId
 * @param {object} db - req.db
 * @returns {Promise<object>}
 */
async function generateTripSheetPdf(tenantId, tripId, db) {
  return db.withTenantContext(async (client) => {
    const trip = await tripSheetRepo.findById(tenantId, tripId, client);
    if (!trip) {
      throw apiError(404, "TRIP_NOT_FOUND", "Trip sheet not found.");
    }
    // Mirrors generateInvoicePdf's INVOICE_NOT_ISSUED guard — DRAFT is
    // the only status blocked, same "once past DRAFT, PDF is always
    // legal" permanence invoices already have (FINALIZED, INVOICED,
    // and CANCELLED trips can all still render their Proforma).
    if (trip.status === "DRAFT") {
      throw apiError(400, "TRIP_NOT_FINALIZED", "PDFs can only be generated for finalized trip sheets.", {
        current_status: trip.status,
      });
    }

    const { tenantSnapshot, customerSnapshot } = await resolveTripSheetPdfParties(tenantId, trip, client);
    const templateVersion = trip.pdf_template_version || pdfEngine.TEMPLATE_VERSION;
    const templateName = pickTripSheetTemplateName(trip, templateVersion);
    const context = buildTripSheetRenderContext(trip, tenantSnapshot, customerSnapshot);

    const pdfBuffer = await renderPdf(templateName, templateVersion, context, { tenantId, tripId });

    const fileName = `${tripId}-${templateVersion}.pdf`;
    await writePdfFile(path.join(tenantId, "trip-sheets"), fileName, pdfBuffer);
    const relativeUrl = `/pdf-storage/${tenantId}/trip-sheets/${fileName}`;

    await client.query(
      `UPDATE trip_sheets
       SET pdf_url = $1, pdf_generated_at = NOW(), pdf_template_version = $2, pdf_file_size_bytes = $3
       WHERE id = $4::uuid AND tenant_id = $5::uuid`,
      [relativeUrl, templateVersion, pdfBuffer.length, tripId, tenantId],
    );

    return {
      pdf_url: relativeUrl,
      pdf_template_version: templateVersion,
      pdf_file_size_bytes: pdfBuffer.length,
      pdf_generated_at: new Date().toISOString(),
    };
  });
}

/**
 * @param {string} relativeUrl - e.g. "/pdf-storage/{tenantId}/invoices/{file}"
 * @returns {string} absolute filesystem path under env.pdfStorageRoot
 */
function resolveStoredPath(relativeUrl) {
  return path.join(env.pdfStorageRoot, relativeUrl.replace(/^\/pdf-storage\//, ""));
}

/**
 * @param {string} tenantId
 * @param {string} invoiceId
 * @param {object} db - req.db
 * @returns {Promise<{ buffer: Buffer, filename: string }>}
 */
async function getInvoicePdfBuffer(tenantId, invoiceId, db) {
  return db.withTenantContext(async (client) => {
    const invoice = await invoiceRepo.findById(tenantId, invoiceId, client);
    if (!invoice || !invoice.pdf_url) {
      throw apiError(404, "PDF_NOT_GENERATED", "PDF has not been generated for this invoice yet.");
    }
    try {
      const buffer = await fs.readFile(resolveStoredPath(invoice.pdf_url));
      return { buffer, filename: `${invoice.invoice_number.replace(/\//g, "-")}.pdf` };
    } catch (err) {
      throw apiError(500, "PDF_FILE_MISSING", "PDF file is registered but missing from storage.");
    }
  });
}

/**
 * @param {string} tenantId
 * @param {string} creditNoteId
 * @param {object} db - req.db
 * @returns {Promise<{ buffer: Buffer, filename: string }>}
 */
async function getCreditNotePdfBuffer(tenantId, creditNoteId, db) {
  return db.withTenantContext(async (client) => {
    const creditNote = await creditNoteRepo.findById(tenantId, creditNoteId, client);
    if (!creditNote || !creditNote.pdf_url) {
      throw apiError(404, "PDF_NOT_GENERATED", "PDF has not been generated for this credit note yet.");
    }
    try {
      const buffer = await fs.readFile(resolveStoredPath(creditNote.pdf_url));
      return { buffer, filename: `${creditNote.credit_note_number.replace(/\//g, "-")}.pdf` };
    } catch (err) {
      throw apiError(500, "PDF_FILE_MISSING", "PDF file is registered but missing from storage.");
    }
  });
}

/**
 * @param {string} tenantId
 * @param {string} tripId
 * @param {object} db - req.db
 * @returns {Promise<{ buffer: Buffer, filename: string }>}
 */
async function getTripSheetPdfBuffer(tenantId, tripId, db) {
  return db.withTenantContext(async (client) => {
    const trip = await tripSheetRepo.findById(tenantId, tripId, client);
    if (!trip || !trip.pdf_url) {
      throw apiError(404, "PDF_NOT_GENERATED", "PDF has not been generated for this trip sheet yet.");
    }
    try {
      const buffer = await fs.readFile(resolveStoredPath(trip.pdf_url));
      return { buffer, filename: `${trip.trip_sheet_number.replace(/\//g, "-")}.pdf` };
    } catch (err) {
      throw apiError(500, "PDF_FILE_MISSING", "PDF file is registered but missing from storage.");
    }
  });
}

module.exports = {
  generateInvoicePdf,
  generateCreditNotePdf,
  generateTripSheetPdf,
  getInvoicePdfBuffer,
  getCreditNotePdfBuffer,
  getTripSheetPdfBuffer,
};
