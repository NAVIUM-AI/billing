/**
 * Local package pricing (Yellow UI format).
 * Base slab (e.g. 8 hrs / 80 km @ ₹2200) plus per-unit extras beyond
 * that slab.
 *
 *   Input all in canonical units:
 *     rule = {
 *       base_hours, base_km, base_price_paise,
 *       extra_km_rate_paise, extra_hr_rate_paise
 *     }
 *     usage = {
 *       total_km:        integer >= 0
 *       total_hours:     integer >= 0
 *       toll_paise:      integer >= 0 (default 0)
 *     }
 *
 *   Output:
 *     {
 *       base_paise, extra_km, extra_km_paise,
 *       extra_hours, extra_hours_paise,
 *       toll_paise, subtotal_paise, total_paise,
 *       breakdown: [ { label, value_paise } ... ]
 *     }
 *
 * subtotal = base + extras + toll
 * total    = subtotal (no batta on local)
 *
 * See the Yellow UI reference:
 *   Base 2200 + Extra KM 137*14 + Extra HR 4*180
 *   + Toll 0 = 4838. This function must produce
 *   that exact result in paise.
 *
 * Zero external imports by design (no express, no pg) — this module is
 * plain arithmetic over plain objects, trivially unit-testable and
 * portable (see scripts/test-pricing-calc.js).
 */

const { DomainInputError } = require("./errors");

function calculateLocal(rule, usage) {
  assertLocalRule(rule);
  const { total_km, total_hours } = usage;
  const toll_paise = usage.toll_paise ?? 0;

  assertNonNegInteger(total_km, "total_km");
  assertNonNegInteger(total_hours, "total_hours");
  assertNonNegInteger(toll_paise, "toll_paise");

  const extra_km = Math.max(0, total_km - rule.base_km);
  const extra_hours = Math.max(0, total_hours - rule.base_hours);

  const extra_km_paise = extra_km * rule.extra_km_rate_paise;
  const extra_hours_paise = extra_hours * rule.extra_hr_rate_paise;

  const base_paise = rule.base_price_paise;
  const subtotal_paise =
    base_paise + extra_km_paise + extra_hours_paise + toll_paise;
  const total_paise = subtotal_paise;

  return {
    base_paise,
    extra_km,
    extra_km_paise,
    extra_hours,
    extra_hours_paise,
    toll_paise,
    subtotal_paise,
    total_paise,
    breakdown: [
      { label: "Base package", value_paise: base_paise },
      {
        label: "Extra KM",
        value_paise: extra_km_paise,
        detail: `${extra_km} × ₹${rule.extra_km_rate_paise / 100}`,
      },
      {
        label: "Extra Hours",
        value_paise: extra_hours_paise,
        detail: `${extra_hours} × ₹${rule.extra_hr_rate_paise / 100}`,
      },
      { label: "Toll", value_paise: toll_paise },
    ],
  };
}

// ─── local assertions ──────────────────
function assertLocalRule(r) {
  const required = [
    "base_hours",
    "base_km",
    "base_price_paise",
    "extra_km_rate_paise",
    "extra_hr_rate_paise",
  ];
  for (const k of required) {
    if (r[k] === undefined || r[k] === null) {
      throw new DomainInputError(`LOCAL rule missing field: ${k}`, {
        field: k,
        reason: "RULE_FIELD_MISSING",
      });
    }
  }
}
function assertNonNegInteger(n, name) {
  if (!Number.isInteger(n) || n < 0) {
    throw new DomainInputError(`${name} must be a non-negative integer`, {
      field: name,
      reason: "USAGE_INVALID",
    });
  }
}

module.exports = calculateLocal;
