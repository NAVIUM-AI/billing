#!/usr/bin/env node
/**
 * Best-effort Chrome install for PDF generation (pdfEngine.service.js).
 *
 * We deliberately depend on `puppeteer-core`, not the full `puppeteer`
 * package — pdfEngine.service.js's own top comment explains why: full
 * puppeteer's postinstall Chromium download stalled indefinitely
 * (connected, zero bytes, 14+ minutes) behind a local corporate proxy.
 * puppeteer-core has no postinstall of its own, so on Render — which
 * has no Chrome preinstalled — pdfEngine.service.js#findChromeExecutable
 * has nothing to find, and every PDF request 500s.
 *
 * This script is the middle ground: it uses @puppeteer/browsers (a
 * transitive dep of puppeteer-core, listed directly in package.json
 * here since we require() it explicitly) to fetch a Chrome build the
 * SAME way findChromeExecutable's cache-dir fallback looks it up — but
 * as a best-effort step that can NEVER block `npm install`:
 *   - Skipped entirely if SKIP_CHROME_INSTALL is set (escape hatch for
 *     exactly the constrained-network environment that forced the
 *     puppeteer-core switch in the first place).
 *   - Skipped if a system Chrome/Chromium is already present (macOS
 *     dev machines, or a container image that already bundles one) —
 *     no redundant download.
 *   - Skipped if @puppeteer/browsers already has a Chrome cached
 *     (idempotent across repeat installs / Render's build cache).
 *   - Time-boxed and failure-tolerant: a stalled or failed download
 *     logs a warning and exits 0, so `npm install` always completes.
 *     If Chrome genuinely isn't available at runtime, PDF requests
 *     will fail loudly with the improved error logging in
 *     pdf.service.js — visible over Render logs, not a blocked build.
 */
const { existsSync } = require("fs");
const os = require("os");
const path = require("path");

const INSTALL_TIMEOUT_MS = 120_000;

const SYSTEM_CHROME_CANDIDATES = [
  process.env.CHROME_EXECUTABLE_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function defaultCacheDir() {
  return process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), ".cache", "puppeteer");
}

async function main() {
  if (process.env.SKIP_CHROME_INSTALL === "true") {
    console.log("[postinstall-chrome] SKIP_CHROME_INSTALL=true — skipping.");
    return;
  }

  if (SYSTEM_CHROME_CANDIDATES.some((p) => existsSync(p))) {
    console.log("[postinstall-chrome] System Chrome/Chromium already present — skipping download.");
    return;
  }

  const { install, getInstalledBrowsers, resolveBuildId, detectBrowserPlatform, Browser, ChromeReleaseChannel } =
    require("@puppeteer/browsers");
  const cacheDir = defaultCacheDir();

  const alreadyInstalled = await getInstalledBrowsers({ cacheDir }).catch(() => []);
  if (alreadyInstalled.some((b) => b.browser === Browser.CHROME)) {
    console.log(`[postinstall-chrome] Chrome already cached at ${cacheDir} — skipping download.`);
    return;
  }

  const platform = detectBrowserPlatform();
  if (!platform) {
    console.warn("[postinstall-chrome] Could not detect browser platform — skipping (findChromeExecutable will fail at runtime).");
    return;
  }

  const installPromise = (async () => {
    const buildId = await resolveBuildId(Browser.CHROME, platform, ChromeReleaseChannel.STABLE);
    await install({ browser: Browser.CHROME, buildId, cacheDir, unpack: true });
    console.log(`[postinstall-chrome] Installed Chrome ${buildId} to ${cacheDir}`);
  })();

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timed out after ${INSTALL_TIMEOUT_MS}ms`)), INSTALL_TIMEOUT_MS),
  );

  await Promise.race([installPromise, timeoutPromise]);
}

main().catch((err) => {
  // Never fail the build over this — see top comment. A missing Chrome
  // at runtime surfaces loudly via pdf.service.js's error logging
  // instead of silently blocking every future `npm install`.
  console.warn(`[postinstall-chrome] Chrome install skipped after error: ${err.message}`);
  process.exit(0);
});
