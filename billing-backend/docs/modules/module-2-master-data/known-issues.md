# Known issues

_Last updated: 2026-07-18. Reviewers: TBD._

All four Module 2 verification scripts and the pricing-calculator unit tests pass at 100% as of this writing (`npm run verify:vehicles` 21/21, `npm run verify:drivers` 17/17, `npm run verify:customers` 24/24, `npm run verify:pricing` 25/25, `npm run test:pricing` 11/11 — the pricing counts grew in Task 2.6, see below). The issue below was originally found while writing Task 2.5's documentation — specifically, while sourcing `04-api-reference.md`'s error-code list for `POST /pricing/preview` — not by a failing automated check, and was deliberately left unfixed in that task per its docs-only scope. It was fixed in Task 2.6. The entry stays below, marked `FIXED`, as the audit trail — issues found during doc-writing are recorded here even after resolution, not deleted.

## Issue: `POST /pricing/preview` returns a raw 500 instead of a validation error when `usage` is missing a rule-type-specific field

**Symptom:** Calling `POST /api/v1/pricing/preview` with a `usage` object that's missing a field the resolved rule's calculator actually requires (e.g. omitting `total_hours` for a `LOCAL_PACKAGE` rule) returns `500 INTERNAL_ERROR` with a generic "Internal server error" message, instead of a `400` naming the missing field the way every other validation failure in this module does.

**Affected task:** 2.4 (Pricing Rules Engine)

**Detected by:** Manual verification while writing `04-api-reference.md`, not by `npm run verify:pricing` — the script's own preview checks (steps 17–18) always send a complete `usage` object, so this path was never exercised by automation.

**Reproduction:**

```bash
# Assumes a LOCAL_PACKAGE rule already exists for SEDAN and is
# active on the current date.
curl -s -X POST http://localhost:8000/api/v1/pricing/preview \
  -H "Authorization: Bearer $ACCESS" -H "Content-Type: application/json" \
  -d '{"rule_type":"LOCAL_PACKAGE","vehicle_type":"SEDAN","usage":{"total_km":100}}'
# omits total_hours
```

Observed response: `500`, `error.code: "INTERNAL_ERROR"`, with `error.details.stack` (present because `NODE_ENV !== production`) showing:

```
TypeError: total_hours must be a non-negative integer
    at assertNonNegInteger (src/domain/pricing/local.js:96:11)
    at calculateLocal (src/domain/pricing/local.js:44:3)
    at Object.calculate (src/domain/pricing/dispatch.js:14:14)
    at Object.previewCalculation (src/services/pricingRule.service.js:351:26)
```

**Root cause hypothesis:** `previewSchema` (`src/validators/pricingRule.validator.js`) validates `usage` loosely — `Joi.object().unknown(true)` — by design, since the required shape of `usage` depends on `rule_type`, and re-encoding each calculator's exact requirements into the Joi schema would duplicate logic already expressed in `src/domain/pricing/*`'s own `assert*` guard functions. Those guard functions throw a plain `TypeError`, not an `apiError`, when a required field is missing or malformed. `src/middleware/errorHandler.js` only gives a thrown error special HTTP-status/code treatment when it carries `.status`/`.statusCode` and `.code` properties (which `apiError()` attaches and a bare `TypeError` does not), so any calculator-thrown `TypeError` falls through to the handler's generic 500 fallback.

**Suggested fix:** `pricingRuleService.previewCalculation` (or `pricing.calculate` itself, at the dispatch layer) could catch a `TypeError` thrown by a calculator and re-throw it as `apiError(400, 'INVALID_USAGE', err.message)`, giving callers a clean 400 with the calculator's own (already-descriptive) message, without duplicating the per-rule-type field requirements into the Joi schema. This keeps the "one place that knows what a rule type requires" property the calculators already have (see ADR's discussion of `src/domain/pricing/`'s pure-module design) while still giving API callers a proper 4xx instead of a 500 for what is, from the caller's side, a client error (an incomplete request), not a server fault.

**Status:** FIXED

**Fixed in commit:** <TBD — fill in after committing this change>

**Fix task:** 2.6

**Fix summary:** Introduced `DomainInputError` in the pricing domain (`src/domain/pricing/errors.js`) — a dependency-free `Error` subclass carrying `field` and `reason`. Every calculator (`local.js`, `outstation.js`, `performance.js`, `dispatch.js`) now throws `DomainInputError` instead of a bare `TypeError` for missing rule fields, invalid usage values, and unknown `rule_type`. `previewCalculation` (`src/services/pricingRule.service.js`) wraps its `calculate()` call in a `try/catch` that translates `DomainInputError` → `apiError(400, 'INVALID_CALCULATION_INPUT', ...)`, including `field`, `reason`, `rule_type`, and `rule_id` in `error.details`; any other error type is re-thrown untouched, so a genuinely unexpected failure still correctly surfaces as a `500`. Regression tests added at both layers: `scripts/test-pricing-calc.js` gained 4 new assertions (11 total, up from 7) asserting `instanceof DomainInputError` with the expected `field`/`reason` for each calculator and for dispatch's unknown-`rule_type` case; `scripts/verify-pricing.sh` gained 5 new steps (25 total, up from 20) covering the missing-field "money shot", an invalid (negative) value, an unknown `rule_type` (validated to fail cleanly whether Joi or the domain layer catches it first), a happy-path regression check, and an explicit assertion that no preview call anywhere in the script returns `500`. See ADR-006 for the general pattern (pure domain modules throw a dedicated `*InputError`; services translate at their boundary) and `06-error-reference.md` for the new `INVALID_CALCULATION_INPUT` error code entry.
