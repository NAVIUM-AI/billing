/**
 * Stand-alone unit tests for the pricing calculators
 * (src/domain/pricing/*). No DB, no server, no test framework — just
 * plain `node scripts/test-pricing-calc.js`. Asserts against known
 * numbers from real invoice references so a refactor that silently
 * changes the arithmetic gets caught immediately.
 */

const assert = require("node:assert/strict");
const { calculateLocal, calculateOutstation, calculatePerformance } = require("../src/domain/pricing");

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

// ─── Yellow UI reference row ───
// Base 2200 + 137 * 14 + 4 * 180 + 0 = 4838
check("Local: Yellow UI reference row", () => {
  const rule = {
    base_hours: 8,
    base_km: 80,
    base_price_paise: 220000,
    extra_km_rate_paise: 1400,
    extra_hr_rate_paise: 18000,
  };
  const out = calculateLocal(rule, {
    total_km: 80 + 137,
    total_hours: 8 + 4,
    toll_paise: 0,
  });
  assert.equal(out.extra_km, 137);
  assert.equal(out.extra_hours, 4);
  assert.equal(out.extra_km_paise, 191800);
  assert.equal(out.extra_hours_paise, 72000);
  assert.equal(out.total_paise, 483800); // ₹4,838
});

// ─── Cauvery Cars reference (CI-150) ───
// 1699 km × ₹50 = 84,950 + batta 4800 + fasttag 2440 = 92,190
check("Outstation: Cauvery Cars CI-150", () => {
  const rule = {
    slab_rate_paise: 5000, // ₹50/km
    min_km_per_day: 250, // 5 days × 250 = 1250 min
    driver_batta_per_day_paise: 96000, // ₹960/day × 5d = 4800
  };
  const out = calculateOutstation(rule, {
    total_km: 1699,
    total_days: 5,
    fasttag_paise: 244000, // ₹2440
    advance_paise: 0,
  });
  assert.equal(out.billable_km, 1699); // 1699 > 1250
  assert.equal(out.slab_paise, 8495000); // ₹84,950
  assert.equal(out.batta_paise, 480000); // ₹4,800
  assert.equal(out.gross_paise, 9219000); // ₹92,190
  assert.equal(out.net_payable_paise, 9219000);
});

// ─── Niriksha Travel reference (CI-1905) ───
// Slab shape is minimum 600 km @ ₹52 = 31200,
// BUT the PDF shows total 62,768 (base 31200 + batta 3200
// + parking/permit 200 + fasttag/tolls 4040
// + additional slab because actual_km 1064 > 600).
// Actually: slab was 1064 * 52 = 55,328? no — the PDF
// says slab 600 × 52 with 0/600 min & the excess as
// "extra kms". Different agencies quote differently;
// for our engine, treat the PDF as:
//   effective billable_km = 1064
//   slab_rate = ₹52/km
//   batta = ₹1600/day × 2 = ₹3200
//   toll+parking+permit+fasttag = 4240
//   → gross = 55,328 + 3,200 + 4,240 = 62,768.
// Less advance 25,000 → net 37,768.
check("Outstation: Niriksha CI-1905 (simplified)", () => {
  const rule = {
    slab_rate_paise: 5200,
    min_km_per_day: 300,
    driver_batta_per_day_paise: 160000,
  };
  const out = calculateOutstation(rule, {
    total_km: 1064,
    total_days: 2,
    parking_paise: 20000,
    permit_paise: 0,
    fasttag_paise: 404000,
    toll_paise: 0,
    advance_paise: 2500000,
  });
  // 1064 > 600 (min) → billable_km = 1064
  assert.equal(out.billable_km, 1064);
  assert.equal(out.slab_paise, 5532800); // ₹55,328
  assert.equal(out.batta_paise, 320000); // ₹3,200
  assert.equal(out.gross_paise, 6276800); // ₹62,768
  assert.equal(out.net_payable_paise, 3776800); // ₹37,768
});

// ─── Blue Performance UI ───
// 300 km × ₹14 = 4200 + batta 300 + toll 0 = 4500
check("Performance: Blue UI reference row", () => {
  const rule = {
    per_km_rate_paise: 1400,
    performance_batta_paise: 30000,
  };
  const out = calculatePerformance(rule, {
    running_km: 300,
    toll_paise: 0,
  });
  assert.equal(out.km_paise, 420000);
  assert.equal(out.total_paise, 450000);
});

// ─── Edge: extras are zero when under base ───
check("Local: extras zero when under base", () => {
  const rule = {
    base_hours: 8,
    base_km: 80,
    base_price_paise: 220000,
    extra_km_rate_paise: 1400,
    extra_hr_rate_paise: 18000,
  };
  const out = calculateLocal(rule, {
    total_km: 50,
    total_hours: 6,
    toll_paise: 0,
  });
  assert.equal(out.extra_km, 0);
  assert.equal(out.extra_hours, 0);
  assert.equal(out.total_paise, 220000);
});

// ─── Edge: min_km takes over when actual is low ───
check("Outstation: min_km_per_day floor", () => {
  const rule = {
    slab_rate_paise: 5000,
    min_km_per_day: 300,
    driver_batta_per_day_paise: 60000,
  };
  const out = calculateOutstation(rule, {
    total_km: 200,
    total_days: 2,
  });
  assert.equal(out.billable_km, 600);
});

// ─── Dispatch routes correctly ───
check("Dispatch: routes by rule_type", () => {
  const { calculate } = require("../src/domain/pricing");
  const r = {
    rule_type: "LOCAL_PACKAGE",
    base_hours: 8,
    base_km: 80,
    base_price_paise: 220000,
    extra_km_rate_paise: 1400,
    extra_hr_rate_paise: 18000,
  };
  const out = calculate(r, { total_km: 80, total_hours: 8, toll_paise: 0 });
  assert.equal(out.total_paise, 220000);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
