/**
 * Uniform entry point. Route by rule.rule_type. Callers should prefer
 * this over the individual calculators.
 *
 * Zero external imports by design — see local.js for why.
 */
const local = require("./local");
const outstation = require("./outstation");
const performance = require("./performance");

module.exports = function calculate(rule, usage) {
  switch (rule.rule_type) {
    case "LOCAL_PACKAGE":
      return local(rule, usage);
    case "OUTSTATION_SLAB":
      return outstation(rule, usage);
    case "PERFORMANCE":
      return performance(rule, usage);
    default:
      throw new TypeError(`Unknown rule_type: ${rule.rule_type}`);
  }
};
