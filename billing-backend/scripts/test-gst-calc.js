/**
 * Stand-alone unit tests for the GST domain module (src/domain/gst/*).
 * No DB, no server, no test framework — just
 * `node scripts/test-gst-calc.js`. Mirrors scripts/test-pricing-calc.js.
 */

const assert = require("node:assert/strict");
const { computeGST, computeRoundOff, isSameState, DomainInputError } = require("../src/domain/gst");
const { amountInWords } = require("../src/domain/gst/amountInWords");

let pass = 0,
  fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.message}`);
    fail++;
  }
}

// ─── GST intra-state 5% ───
check("GST 5% intra-state on ₹84,950 base", () => {
  const r = computeGST({ taxableAmountPaise: 8495000, gstRate: 5, sameState: true });
  assert.equal(r.totalGstPaise, 424750);
  assert.equal(r.cgstPaise, 212375);
  assert.equal(r.sgstPaise, 212375);
  assert.equal(r.igstPaise, 0);
});

// ─── GST inter-state 5% ───
check("GST 5% inter-state on ₹84,950 base", () => {
  const r = computeGST({ taxableAmountPaise: 8495000, gstRate: 5, sameState: false });
  assert.equal(r.totalGstPaise, 424750);
  assert.equal(r.cgstPaise, 0);
  assert.equal(r.sgstPaise, 0);
  assert.equal(r.igstPaise, 424750);
});

// ─── GST 12% ITC rate ───
check("GST 12% intra-state on ₹100", () => {
  const r = computeGST({ taxableAmountPaise: 10000, gstRate: 12, sameState: true });
  assert.equal(r.totalGstPaise, 1200);
  assert.equal(r.cgstPaise, 600);
  assert.equal(r.sgstPaise, 600);
});

// ─── Odd totalGST split ───
check("GST odd total splits with remainder to SGST", () => {
  // 5% of 1235 paise = 61.75 -> rounds to 62
  const r = computeGST({ taxableAmountPaise: 1235, gstRate: 5, sameState: true });
  assert.equal(r.totalGstPaise, 62);
  assert.equal(r.cgstPaise, 31);
  assert.equal(r.sgstPaise, 31);
  // 62 / 2 = 31 exactly; no remainder here.

  // 5% of 1230 paise = 61.5 -> rounds to 62 (up on 0.5)
  const r2 = computeGST({ taxableAmountPaise: 1230, gstRate: 5, sameState: true });
  assert.equal(r2.totalGstPaise, 62);
  assert.equal(r2.cgstPaise, 31);
  assert.equal(r2.sgstPaise, 31);

  // 5% of 1250 paise = 62.5 -> rounds to 63
  const r3 = computeGST({ taxableAmountPaise: 1250, gstRate: 5, sameState: true });
  assert.equal(r3.totalGstPaise, 63);
  assert.equal(r3.cgstPaise, 31);
  assert.equal(r3.sgstPaise, 32); // SGST absorbs remainder
});

// ─── Zero rate ───
check("GST 0% returns zeroes", () => {
  const r = computeGST({ taxableAmountPaise: 100000, gstRate: 0, sameState: true });
  assert.equal(r.totalGstPaise, 0);
});

// ─── Round-off ───
check("Round-off to nearest rupee — ₹4834.75", () => {
  const r = computeRoundOff(483475);
  assert.equal(r.netPayablePaise, 483500);
  assert.equal(r.roundOffPaise, 25);
});

check("Round-off — ₹4834.25", () => {
  const r = computeRoundOff(483425);
  assert.equal(r.netPayablePaise, 483400);
  assert.equal(r.roundOffPaise, -25);
});

check("Round-off — already whole rupees", () => {
  const r = computeRoundOff(100000);
  assert.equal(r.netPayablePaise, 100000);
  assert.equal(r.roundOffPaise, 0);
});

// ─── isSameState edge cases ───
check("isSameState handles nulls (defaults true)", () => {
  assert.equal(isSameState(null, "KA"), true);
  assert.equal(isSameState("KA", null), true);
  assert.equal(isSameState("KA", "KA"), true);
  assert.equal(isSameState("KA", "MH"), false);
  assert.equal(isSameState("ka", "KA"), true);
});

// ─── DomainInputError translation ───
check("computeGST throws DomainInputError on bad input", () => {
  assert.throws(
    () => computeGST({ taxableAmountPaise: -100, gstRate: 5, sameState: true }),
    (err) => {
      assert.ok(err instanceof DomainInputError);
      assert.equal(err.field, "taxableAmountPaise");
      return true;
    },
  );
});

// ─── Amount in words ───
check("amountInWords: ₹92,190", () => {
  assert.equal(amountInWords(9219000), "Rupees Ninety Two Thousand One Hundred Ninety Only");
});

check("amountInWords: ₹1,00,000", () => {
  assert.equal(amountInWords(10000000), "Rupees One Lakh Only");
});

check("amountInWords: ₹4,838", () => {
  assert.equal(amountInWords(483800), "Rupees Four Thousand Eight Hundred Thirty Eight Only");
});

check("amountInWords: ₹100 and 50 paise", () => {
  assert.equal(amountInWords(10050), "Rupees One Hundred And Fifty Paise Only");
});

check("amountInWords: ₹0", () => {
  assert.equal(amountInWords(0), "Rupees Zero Only");
});

check("amountInWords: ₹1 crore", () => {
  assert.equal(amountInWords(1000000000), "Rupees One Crore Only");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
