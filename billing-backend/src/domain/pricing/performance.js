/**
 * Performance sheet — internal cost tracking.
 *   Total = running_km * per_km_rate_paise + batta + toll
 * Not a GST invoice; used only for internal cost cards.
 *
 * Zero external imports by design — see local.js for why.
 */

const { DomainInputError } = require("./errors");

function calculatePerformance(rule, usage) {
  assertPerfRule(rule);
  const running_km = usage.running_km ?? 0;
  const toll_paise = usage.toll_paise ?? 0;

  assertNonNegInteger(running_km, "running_km");
  assertNonNegInteger(toll_paise, "toll_paise");

  const km_paise = running_km * rule.per_km_rate_paise;
  const batta_paise = rule.performance_batta_paise;
  const total_paise = km_paise + batta_paise + toll_paise;

  return {
    running_km,
    km_paise,
    batta_paise,
    toll_paise,
    total_paise,
    breakdown: [
      {
        label: "Running",
        value_paise: km_paise,
        detail: `${running_km} km × ₹${rule.per_km_rate_paise / 100}`,
      },
      { label: "Batta", value_paise: batta_paise },
      { label: "Toll", value_paise: toll_paise },
    ],
  };
}

function assertPerfRule(r) {
  ["per_km_rate_paise", "performance_batta_paise"].forEach((k) => {
    if (r[k] === undefined || r[k] === null) {
      throw new DomainInputError(`PERFORMANCE rule missing field: ${k}`, {
        field: k,
        reason: "RULE_FIELD_MISSING",
      });
    }
  });
}
function assertNonNegInteger(n, name) {
  if (!Number.isInteger(n) || n < 0) {
    throw new DomainInputError(`${name} must be a non-negative integer`, {
      field: name,
      reason: "USAGE_INVALID",
    });
  }
}

module.exports = calculatePerformance;
