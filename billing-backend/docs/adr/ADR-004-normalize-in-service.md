# ADR-004: Normalization is a service-layer responsibility; repositories operate on primitives

_Last updated: 2026-07-18. Reviewers: TBD._

## Status

Accepted (2026-07-18)

## Context

Several fields in this schema accept the same real-world value in more than one valid input format — a vehicle registration typed with or without spaces, a phone number with or without a leading country code, a GSTIN typed in lowercase, a free-text search term that might match a canonical form of a stored value rather than its display form. Normalization logic for a given field — turning a raw input into the canonical form used for storage, comparison, and lookup — could plausibly live in the Joi validator, the service, or the repository. Placing it in more than one of those layers, or in an inconsistent layer across different call sites for the same field, invites two specific bugs: double-normalization (a value gets normalized twice, and the second pass produces something subtly different from the first — an actual risk for e.g. a normalization function that isn't perfectly idempotent), and normalization drift (two call sites for logically the same field normalize it with slightly different logic because they were written at different times by different reasoning about where normalization "should" happen).

## Decision

The service layer normalizes a value exactly once, at its input boundary, and everything below it — the repository, and the SQL it writes — receives already-normalized primitives and never normalizes again. Two-form fields (vehicle number, phone, GSTIN) are handled with a Joi `.custom()` transform in the validator that produces a rich value (`{ canonical, display }` for two-column fields; a plain canonical string for GSTIN, which has no separate display form) *before* the service even sees the raw string — so by the time a service function's normalize step runs, it's typically just destructuring `input.phone.canonical` / `input.phone.display` rather than re-deriving them, and its actual normalization work is for values Joi couldn't reasonably transform itself (rupee-to-paise conversion, deriving a search term's multiple canonical forms). Repository functions accept these already-normalized values as plain function parameters and are, by convention enforced through code review rather than a type system, never allowed to call a `normalize()` function themselves.

## Consequences

There is exactly one place to look when a normalization bug is suspected for a given field: the service function's normalize step (or, for the two-form fields, the validator's `.custom()` transform), never a scattered set of call sites. Repositories stay simpler as a direct consequence — they're pure SQL-plus-parameter-binding, with no business logic to reason about, which also makes them easier to reuse from a context that isn't a normal HTTP request (a background job recalculating something, a one-off data migration script) without dragging in normalization logic that assumes an HTTP request's input shape.

The most visible instance of this pattern is search: `customer.service.js#listCustomers` computes `searchOriginal`, `searchPhoneCanonical`, and `searchGstinCanonical` — three different canonical forms of one incoming query string — exactly once, and hands all three to `customer.repository.js#list`, which matches each against the column it's relevant for (`name`/`company_name`/`email` against the original, `phone` against the phone-canonical form, `gstin` against the GSTIN-canonical form) without ever calling a normalize function of its own. The same shape (service computes `searchOriginal` + `searchPhoneCanonical`, repository just consumes both) repeats for drivers and, in a fixed-arity `WHERE` clause rather than a dynamically-built one, for pricing rules' non-search filters.

The cost is a small amount of duplication where two different services normalize the same kind of field in essentially the same way — `driver.service.js` and `customer.service.js` both derive a `phoneCanonical`/`phoneDisplay` pair from a validated `{ canonical, display }` input in nearly identical fashion, for instance. This was accepted rather than immediately factored into a shared helper, following a rule of three: duplicate logic gets extracted into a shared utility once it shows up independently three or more times, not preemptively at the second occurrence, since a shared abstraction introduced too early tends to guess wrong about what the third and fourth call sites will actually need.
