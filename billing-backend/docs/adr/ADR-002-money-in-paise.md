# ADR-002: Store and compute money as integer paise

_Last updated: 2026-07-18. Reviewers: TBD._

## Status

Accepted (2026-07-18)

## Context

Floating-point arithmetic on decimal currency values is not exact: `0.1 + 0.2 === 0.30000000000000004` in JavaScript (and in most languages using IEEE-754 double-precision floats), because most decimal fractions have no exact binary representation. Applied to money, this isn't a cosmetic rounding annoyance — it's a real invoice discrepancy that compounds across the many additions, multiplications, and comparisons a pricing calculation performs (base rate plus per-km overage plus a driver allowance plus tolls, each potentially multiplied by a count). Postgres's `NUMERIC(12,2)` type solves the storage half of this problem, but doesn't help once a value crosses into JavaScript for calculation, formatting, or comparison — and every serious payments-adjacent system (Stripe, Razorpay, and the rest of the industry) has independently converged on the same answer for the JavaScript side.

## Decision

Every monetary value in the system, from the database columns (`pricing_rules.base_price_paise` and its siblings) through the calculators in `src/domain/pricing/` to the API response bodies, is stored and computed as an integer count of **paise** (1 rupee = 100 paise; `src/utils/money.js`). The wire contract — what a client sends and receives over HTTP — uses a strict naming convention to keep the two units from ever being confused in the same variable: request bodies accept decimal rupee values in fields suffixed `_rupees` (e.g. `base_price_rupees: 2200`), and the service layer is the only place that conversion happens, via `money.rupeesToPaise()`, before a value is validated against a rule type's required fields or ever reaches a repository. Responses return the stored `_paise` integers directly; the pricing-rules preview endpoint additionally returns a `formatted` object with human-readable `_rupees` strings (`money.formatINR()`, e.g. `"₹4,838.00"`) for display convenience.

## Consequences

Every calculation inside `src/domain/pricing/` — addition, multiplication by a count, comparison — operates on JavaScript integers, which are exact for any value within `Number.MAX_SAFE_INTEGER`, eliminating float rounding error from the pricing engine entirely. This is directly testable: `scripts/test-pricing-calc.js` asserts exact equality (`assert.equal`, not an epsilon-tolerant comparison) against real invoice numbers, which would not be reliable with float arithmetic in the mix.

The cost is a discipline requirement at every system boundary rather than a property the type system enforces automatically: every rupee value coming in has to be multiplied by 100 (`rupeesToPaise`), every value going out for display has to be divided back (`paiseToRupees`/`formatINR`), and the `_paise`/`_rupees` naming convention is the only thing preventing a value in one unit from being silently used as if it were the other. `rupeesToPaise` guards against the most common failure mode of this approach — float imprecision in the *input* itself (e.g. a client sending `14.999999999` due to its own float arithmetic) — by rounding to the nearest paise rather than truncating, but nothing in the type system stops a future contributor from, say, passing a `_rupees` value directly into a calculator that expects `_paise`; this is caught by convention and code review, not compilation.

Postgres's `INTEGER` columns (used for every `_paise` field in this schema) top out at roughly ±2.1 billion, i.e. roughly ₹21,474,836 as a single amount. Every value in this domain today — trip costs, driver battas, tolls — is comfortably within that range by orders of magnitude, so `INTEGER` rather than `BIGINT` was used without further consideration. This should be revisited if a future feature (e.g. an annual corporate-fleet contract value, rather than a single trip) could plausibly need to represent an amount anywhere near that ceiling.
