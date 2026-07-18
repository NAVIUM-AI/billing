/**
 * Pricing engine — a self-contained folder with ZERO external imports
 * (no express, no pg, no framework code). Trivially unit-testable
 * (see scripts/test-pricing-calc.js) and portable.
 */
module.exports = {
  calculateLocal: require("./local"),
  calculateOutstation: require("./outstation"),
  calculatePerformance: require("./performance"),
  calculate: require("./dispatch"),
  DomainInputError: require("./errors").DomainInputError,
};
