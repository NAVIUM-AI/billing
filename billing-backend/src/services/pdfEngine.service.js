/**
 * Puppeteer singleton + Handlebars template loader (Task 4.5).
 *
 * The browser is expensive to launch (~500ms) so we keep one instance
 * alive for the app's lifetime; pages within it are cheap and one is
 * opened per render, then closed. Compiled templates are cached by
 * (name, version) so repeat renders of the same template never re-hit
 * disk or re-compile.
 *
 * Framework-agnostic on purpose (no req/res, no apiError here) — same
 * "pure engine, translate errors at the service boundary" split as
 * every domain module in this codebase (Rule 5 lives in pdf.service.js,
 * not here).
 */

// puppeteer-core, not puppeteer: the full `puppeteer` package's
// postinstall step downloads a bundled ~300MB Chromium, which stalled
// indefinitely in this environment (connected, zero bytes transferred
// for 14+ minutes — a corporate-proxy-shaped failure, exactly what
// Task 4.5's own spec anticipated). puppeteer-core skips that download
// entirely and drives whatever Chrome/Chromium is already on the
// machine instead (see findChromeExecutable below).
const puppeteer = require("puppeteer-core");
const handlebars = require("handlebars");
const fs = require("fs").promises;
const path = require("path");
const { existsSync } = require("fs");

let browserInstance = null;
const templateCache = new Map();

// Bump on any layout change. A PDF regenerated for an already-issued
// invoice/credit note always uses the version stored on that record
// (see pdf.service.js), never this current value, so historical
// documents stay visually stable even after this bumps.
const TEMPLATE_VERSION = "v1.0.0";

// Common install locations for an already-present Chrome/Chromium,
// checked in order. CHROME_EXECUTABLE_PATH always wins when set (e.g.
// in a container image that installs Chromium at a nonstandard path).
const CHROME_CANDIDATE_PATHS = [
  process.env.CHROME_EXECUTABLE_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function findChromeExecutable() {
  const found = CHROME_CANDIDATE_PATHS.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      "No Chrome/Chromium executable found for PDF rendering. Install Google Chrome, or set CHROME_EXECUTABLE_PATH to a Chromium binary.",
    );
  }
  return found;
}

async function getBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.version();
      return browserInstance;
    } catch (e) {
      browserInstance = null;
    }
  }
  browserInstance = await puppeteer.launch({
    executablePath: findChromeExecutable(),
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  return browserInstance;
}

// ─── Handlebars helpers ──────────────────────────────────────────────

handlebars.registerHelper("formatMoney", (paise) => {
  if (paise == null) return "₹0.00";
  const rupees = Number(paise) / 100;
  return "₹" + rupees.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
});

handlebars.registerHelper("formatMoneyBare", (paise) => {
  if (paise == null) return "0.00";
  const rupees = Number(paise) / 100;
  return rupees.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
});

// Calendar dates in this codebase are plain 'YYYY-MM-DD' strings (see
// db.js's DATE type-parser override) specifically to avoid local
// timezone shifts — parse the string directly rather than going
// through `new Date(isoDate)`, which would reintroduce that shift.
function splitCalendarDate(isoDate) {
  const [year, month, day] = String(isoDate).slice(0, 10).split("-");
  return { year, month, day };
}

handlebars.registerHelper("formatDate", (isoDate) => {
  if (!isoDate) return "";
  const { year, month, day } = splitCalendarDate(isoDate);
  return `${day}.${month}.${year}`;
});

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

handlebars.registerHelper("formatDateLong", (isoDate) => {
  if (!isoDate) return "";
  const { year, month, day } = splitCalendarDate(isoDate);
  return `${day}-${MONTH_NAMES[Number(month) - 1]}-${year}`;
});

handlebars.registerHelper("or", (a, b) => a || b);
handlebars.registerHelper("eq", (a, b) => a === b);
handlebars.registerHelper("gt", (a, b) => Number(a) > Number(b));
handlebars.registerHelper("add", (a, b) => Number(a) + Number(b));

/**
 * @param {string} templateName
 * @param {string} version
 * @returns {Promise<HandlebarsTemplateDelegate>}
 */
async function loadTemplate(templateName, version) {
  const cacheKey = `${templateName}@${version}`;
  if (templateCache.has(cacheKey)) {
    return templateCache.get(cacheKey);
  }
  const templatePath = path.join(__dirname, "../templates/pdf", version, `${templateName}.hbs`);
  let raw;
  try {
    raw = await fs.readFile(templatePath, "utf-8");
  } catch (err) {
    throw new Error(`Template not found: ${templateName}@${version}`);
  }
  const compiled = handlebars.compile(raw);
  templateCache.set(cacheKey, compiled);
  return compiled;
}

/**
 * @param {string} html
 * @param {object} [options] - extra puppeteer page.pdf() overrides
 * @returns {Promise<Buffer>}
 */
async function renderHtmlToPdf(html, options = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "15mm", right: "10mm", bottom: "15mm", left: "10mm" },
      ...options,
    });
  } finally {
    await page.close();
  }
}

async function shutdown() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

module.exports = { loadTemplate, renderHtmlToPdf, shutdown, TEMPLATE_VERSION, registerPartial: (name, content) => handlebars.registerPartial(name, content) };
