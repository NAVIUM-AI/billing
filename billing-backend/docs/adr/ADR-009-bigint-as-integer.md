# ADR-009: Global type parser converts BIGINT columns to JS numbers at the pg driver layer

_Last updated: 2026-07-23. Reviewers: TBD._

## Status

Accepted (Task 4.1).

## Context

`node-postgres` returns a `BIGINT` column (OID 20/`int8`) as a JavaScript string by default, not a number. This is a deliberate safety default in the driver, not an oversight: `BIGINT` can hold values beyond `Number.MAX_SAFE_INTEGER` (2^53 − 1), and silently parsing every such value to a JS number would risk quiet precision loss for the rare column that actually needs the full 64-bit range.

Task 4.1 introduced the first `BIGINT` money columns in this schema — `invoices.subtotal_paise`, `net_payable_paise`, and every other `*_paise` column on `invoices`/`credit_notes`/`payments`, declared `BIGINT` rather than `INTEGER` for headroom against a very large invoice. Every realistic value in this domain is nowhere near the ceiling that motivates the driver's default: the largest plausible invoice is on the order of ₹1 crore (10^11 paise), several orders of magnitude below 2^53 (roughly 9×10^15). Left as strings, though, plain arithmetic on these values breaks silently rather than loudly — `taxableAmountPaise + totalGstPaise` doesn't throw when one operand is a string returned from a `BIGINT` column, it string-concatenates (`220000 + "0"` → `"2200000"`), and the corruption doesn't surface until several steps downstream, typically as the pure GST domain module rejecting a garbled, concatenated value with a confusing "not an integer" error that points nowhere near the actual cause.

## Decision

Register a global type parser at pool creation time in `src/config/db.js`, immediately alongside the existing `DATE`-column parser this same file already establishes:

```js
types.setTypeParser(types.builtins.INT8, (val) => parseInt(val, 10));
```

This applies to every `BIGINT` read across every repository in the codebase, present and future — there is no per-query or per-column opt-in. Every layer above the driver (services, tests, API responses) sees a plain JS number for a `*_paise` column, exactly as it already does for the `INTEGER` money columns that predate Task 4.1 (`trip_sheets`' own paise columns, all `INTEGER`).

## Consequences

Money arithmetic across the codebase works with the plain `+`/`-` operators everywhere, with no special-casing for which underlying column type produced a given value — `subtotalPaise + totalGstPaise + tollPaise` behaves identically whether every operand came from an `INTEGER` or a `BIGINT` column. Without this parser, every service function that touches an invoice/payment total would need to remember which specific columns are `BIGINT` and wrap them in `Number(...)` (or worse, `BigInt(...)`, a different type entirely that doesn't mix with plain numbers at all) at every read site — a class of bug that would recur at every new call site rather than being closed off once at the driver boundary.

The cost is symmetric with the driver's own reasoning for defaulting to strings: any `BIGINT` value that genuinely exceeds `Number.MAX_SAFE_INTEGER` will silently lose precision once parsed this way, with no error raised. This is accepted as a non-issue for this schema specifically — no domain value here (invoice totals, payment amounts, sequence counters) approaches that ceiling, and every such column carries its own separate `CHECK (... >= 0)` constraint that would catch a value gone absurdly wrong for other reasons well before precision loss became the actual problem. If this system's domain ever expanded to include a genuinely large-integer concept (cryptocurrency wei-denominated amounts, for instance), this global parser would need to be revisited — probably by parsing only per-query with an explicit column-type map, rather than reverting the global default and reintroducing the string-concatenation failure mode this ADR exists to prevent.

## References

Task 4.1 debrief. Precedent: the `DATE`-column parser in the same file (`src/config/db.js`), which this ADR's parser sits directly beneath, solving a structurally similar "the driver's safe default doesn't match this schema's actual value range" problem for calendar dates instead of large integers.
