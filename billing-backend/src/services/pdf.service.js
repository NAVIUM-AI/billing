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
const { apiError } = require("../utils/httpError");
const { stateNameForCode } = require("../constants/gstStateCodes");

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
 * Yellow (LOCAL tax), Blue (OUTSTATION tax), or Performance. TAX
 * invoices are guaranteed single-service_type by Task 4.3's own
 * validation, so the first line's service_type is authoritative for
 * the whole invoice.
 */
function pickInvoiceTemplateName(invoice, lines) {
  if (invoice.invoice_type === "PERFORMANCE") {
    return "invoice-performance";
  }
  const firstLine = lines[0];
  if (!firstLine) {
    throw apiError(400, "INVOICE_HAS_NO_LINES", "Cannot generate a PDF for an invoice with no lines.");
  }
  return firstLine.service_type === "LOCAL" ? "invoice-local-tax" : "invoice-outstation-tax";
}

function enhanceLine(line) {
  return {
    ...line,
    vehicle_type_label: humanizeVehicleType(line.vehicle_type),
    per_km_rate_paise: line.total_km > 0 ? Math.round(Number(line.base_amount_paise) / line.total_km) : 0,
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

  return {
    invoice,
    tenant: buildTenantRenderContext(invoice.tenant_snapshot),
    customer,
    lines: lines.map(enhanceLine),
    billingCycle: computeBillingCycle(lines),
    placeOfSupplyStateName: customer.state_name,
    placeOfSupplyStateCode: customer.state_code,
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
 * Puppeteer/Handlebars failures (browser crash, page timeout, a
 * missing template file) are infrastructure failures, not domain
 * errors — translate them at this boundary so a template-engine
 * exception never reaches the client as a raw, uncoded 500 (Rule 5).
 */
async function renderPdf(templateName, templateVersion, context) {
  await ensurePartialsLoaded(templateVersion);
  let template;
  try {
    template = await pdfEngine.loadTemplate(templateName, templateVersion);
  } catch (err) {
    throw apiError(500, "PDF_TEMPLATE_ERROR", "Could not load the PDF template.", { template: templateName });
  }

  let html;
  try {
    html = template(context);
  } catch (err) {
    throw apiError(500, "PDF_TEMPLATE_ERROR", "Failed to render the PDF template.", { template: templateName });
  }

  try {
    return await pdfEngine.renderHtmlToPdf(html);
  } catch (err) {
    throw apiError(500, "PDF_RENDER_FAILED", "PDF rendering failed. Please retry.");
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
    const templateName = pickInvoiceTemplateName(invoice, lines);
    const context = buildInvoiceRenderContext(invoice, lines, templateName);

    const pdfBuffer = await renderPdf(templateName, templateVersion, context);

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

    const pdfBuffer = await renderPdf("credit-note", templateVersion, context);

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

module.exports = {
  generateInvoicePdf,
  generateCreditNotePdf,
  getInvoicePdfBuffer,
  getCreditNotePdfBuffer,
};
