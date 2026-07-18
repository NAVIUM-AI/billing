/**
 * Outstation slab pricing (Blue UI / Cauvery Cars / Niriksha format).
 *   Billable KM = max(actual_km, min_km_per_day * days)
 *   Slab amount  = billable_km * slab_rate_paise
 *   Batta        = days * driver_batta_per_day_paise
 *   Toll/Parking/Permit/Fasttag are pass-throughs.
 *
 *   Gross    = slab + batta + toll + parking + permit + fasttag
 *   NetPayable = Gross - advance
 *
 * Reference: Cauvery Cars invoice CI-150 →
 *   50/km × 1699 km = 84,950 + batta 4,800 + fasttag 2,440 = 92,190.
 *
 * Zero external imports by design — see local.js for why.
 */

const { DomainInputError } = require("./errors");

function calculateOutstation(rule, usage) {
  assertOutstationRule(rule);
  const total_km = usage.total_km ?? 0;
  const total_days = usage.total_days ?? 1;
  const toll_paise = usage.toll_paise ?? 0;
  const parking_paise = usage.parking_paise ?? 0;
  const permit_paise = usage.permit_paise ?? 0;
  const fasttag_paise = usage.fasttag_paise ?? 0;
  const advance_paise = usage.advance_paise ?? 0;

  [total_km, total_days, toll_paise, parking_paise, permit_paise, fasttag_paise, advance_paise].forEach(
    (v, i) =>
      assertNonNegInteger(
        v,
        ["total_km", "total_days", "toll_paise", "parking_paise", "permit_paise", "fasttag_paise", "advance_paise"][
          i
        ],
      ),
  );

  if (total_days < 1) {
    throw new DomainInputError("total_days must be >= 1", {
      field: "total_days",
      reason: "USAGE_INVALID",
    });
  }

  const min_km_total = rule.min_km_per_day * total_days;
  const billable_km = Math.max(total_km, min_km_total);

  const slab_paise = billable_km * rule.slab_rate_paise;
  const batta_paise = total_days * rule.driver_batta_per_day_paise;

  const gross_paise =
    slab_paise + batta_paise + toll_paise + parking_paise + permit_paise + fasttag_paise;
  const net_payable_paise = gross_paise - advance_paise;

  return {
    billable_km,
    slab_paise,
    batta_paise,
    toll_paise,
    parking_paise,
    permit_paise,
    fasttag_paise,
    advance_paise,
    gross_paise,
    net_payable_paise,
    breakdown: [
      {
        label: "Slab",
        value_paise: slab_paise,
        detail: `${billable_km} km × ₹${rule.slab_rate_paise / 100}`,
      },
      {
        label: "Batta",
        value_paise: batta_paise,
        detail: `${total_days} days × ₹${rule.driver_batta_per_day_paise / 100}`,
      },
      { label: "Toll", value_paise: toll_paise },
      { label: "Parking", value_paise: parking_paise },
      { label: "Permit", value_paise: permit_paise },
      { label: "Fasttag", value_paise: fasttag_paise },
      { label: "Advance", value_paise: -advance_paise },
    ],
  };
}

function assertOutstationRule(r) {
  ["slab_rate_paise", "min_km_per_day", "driver_batta_per_day_paise"].forEach((k) => {
    if (r[k] === undefined || r[k] === null) {
      throw new DomainInputError(`OUTSTATION rule missing field: ${k}`, {
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

module.exports = calculateOutstation;
