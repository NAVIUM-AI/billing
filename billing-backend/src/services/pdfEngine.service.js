/**
 * Puppeteer launcher + Handlebars template loader (Task 4.5).
 *
 * One browser is launched PER PDF request and closed when it's done
 * (see renderHtmlToPdf) — NOT kept alive at module scope. That used to
 * be a long-lived singleton (reused across requests, ~500ms saved per
 * render), which is fine on a machine with headroom but is a real OOM
 * risk on Render's free tier (512MB total, Chrome alone can hold
 * 150-300MB resident even idle) — a crashed/leaked long-lived browser
 * also silently degrades every subsequent request until the process
 * restarts, which is a worse failure mode than a predictable ~500ms
 * launch tax on each request. PDF generation is not a hot path here
 * (fired once per invoice issue/regenerate, not per page view), so
 * that tax is the right trade for this app. Compiled Handlebars
 * templates are still cached by (name, version) at module scope — that
 * cache is cheap (a few KB of compiled function, not a Chrome process)
 * and safe to keep for the app's lifetime.
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
// machine instead (see findChromeExecutable below). scripts/postinstall-
// chrome.js is a best-effort, non-blocking install of one via
// @puppeteer/browsers for environments (Render) that have neither a
// system Chrome nor this repo's own local dev setup.
const puppeteer = require("puppeteer-core");
const handlebars = require("handlebars");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const { existsSync } = require("fs");

const templateCache = new Map();

// Bump on any layout change. A PDF regenerated for an already-issued
// invoice/credit note always uses the version stored on that record
// (see pdf.service.js), never this current value, so historical
// documents stay visually stable even after this bumps.
const TEMPLATE_VERSION = "v1.1.0";

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

// Cached resolution so every PDF request doesn't re-scan the
// filesystem / re-query @puppeteer/browsers's cache metadata.
let resolvedExecutablePath = null;

/**
 * Falls back to whatever scripts/postinstall-chrome.js (or a manual
 * `npx puppeteer browsers install chrome`) put in the
 * @puppeteer/browsers-managed cache dir — none of CHROME_CANDIDATE_PATHS'
 * hardcoded system paths match where that installs Chrome, so without
 * this a Render deploy that successfully ran the postinstall step
 * would STILL 500 here, unable to find what it just downloaded.
 */
async function findManagedChromeExecutable() {
  const { getInstalledBrowsers, Browser } = require("@puppeteer/browsers");
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), ".cache", "puppeteer");
  const installed = await getInstalledBrowsers({ cacheDir }).catch(() => []);
  const chrome = installed.find((b) => b.browser === Browser.CHROME);
  return chrome ? chrome.executablePath : null;
}

async function findChromeExecutable() {
  if (resolvedExecutablePath && existsSync(resolvedExecutablePath)) {
    return resolvedExecutablePath;
  }

  const systemMatch = CHROME_CANDIDATE_PATHS.find((candidate) => existsSync(candidate));
  if (systemMatch) {
    resolvedExecutablePath = systemMatch;
    return resolvedExecutablePath;
  }

  const managedMatch = await findManagedChromeExecutable();
  if (managedMatch) {
    resolvedExecutablePath = managedMatch;
    return resolvedExecutablePath;
  }

  throw new Error(
    "No Chrome/Chromium executable found for PDF rendering. Install Google Chrome, set CHROME_EXECUTABLE_PATH " +
      "to a Chromium binary, or run `npx puppeteer browsers install chrome` (see scripts/postinstall-chrome.js).",
  );
}

// `--single-process`/`--disable-gpu` are the standard recipe for
// containerized Linux (Render, Docker) but reproducibly hang macOS
// Chrome on page.setContent (verified locally: both flags individually
// cause a networkidle0 timeout on this machine's Chrome) — gated to
// Render's own environment (Render sets RENDER=true automatically) so
// local dev keeps using the args that have always worked here, while
// Render gets the flags it actually needs for its container.
function launchArgs() {
  const base = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--no-zygote",
    "--disable-accelerated-2d-canvas",
    "--disable-web-security",
  ];
  if (process.env.RENDER === "true") {
    base.push("--disable-gpu", "--single-process");
  }
  return base;
}

async function launchBrowser() {
  const executablePath = await findChromeExecutable();
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: launchArgs(),
  });
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
  const browser = await launchBrowser();
  try {
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
  } finally {
    await browser.close();
  }
}

// No module-scope browser to close anymore (see top-of-file comment) —
// kept as a no-op so server.js's SIGTERM/SIGINT handler doesn't need a
// conditional require. If a render is genuinely in flight at shutdown,
// its own `finally { await browser.close() }` above still runs it down.
async function shutdown() {}

module.exports = { loadTemplate, renderHtmlToPdf, shutdown, TEMPLATE_VERSION, registerPartial: (name, content) => handlebars.registerPartial(name, content) };
