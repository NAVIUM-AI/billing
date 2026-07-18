# ADR-006: Pure domain modules throw a dedicated DomainInputError class; services translate to apiError at their boundary

_Last updated: 2026-07-18. Reviewers: TBD._

## Status

Accepted (2026-07-18)

## Context

Pure domain modules (`src/domain/pricing/` is the first and, as of this writing, only one) must not import framework-specific error helpers like `apiError` — doing so would pull an HTTP/Express-shaped dependency into code whose entire value proposition is being framework-free, testable with plain `node`, and portable to a context that isn't an HTTP request at all (see ADR's discussion of the pricing domain's design in `docs/modules/module-2-master-data/02-architecture.md` and `05-design-decisions.md`). But when a service calls into the domain and the domain signals a problem by throwing a bare `TypeError`, the global error handler (`src/middleware/errorHandler.js`) has no way to distinguish "the caller sent bad input" from "something genuinely broke" — a `TypeError` carries none of the `.status`/`.code` metadata `apiError()` attaches, so it falls through to the handler's generic `500 INTERNAL_ERROR` fallback. Task 2.5's documentation work surfaced a concrete instance of this: `POST /pricing/preview` returned a raw `500` whenever `usage` was missing a field the resolved rule's calculator required, instead of a clean `400` naming the problem — a client-input error masquerading as a server fault, and consequently invisible to callers as anything but a broken endpoint, and indistinguishable from a real bug in an on-call 500 stream.

## Decision

Domain modules throw a dedicated error class defined *inside* the domain, with zero external dependencies: `DomainInputError extends Error`, carrying an optional `field` (which input was bad) and `reason` (a stable, enum-ish machine-readable cause string such as `RULE_FIELD_MISSING`, `USAGE_INVALID`, `RULE_TYPE_UNKNOWN`). Services that call into a domain module wrap the call in `try/catch`: a caught `DomainInputError` is translated into `apiError(400, '<SPECIFIC_CODE>', err.message, { field: err.field, reason: err.reason, ...context })`; any other caught error is re-thrown untouched, so it continues to reach the global handler and correctly surfaces as a `500` — this is deliberate and load-bearing, not an oversight: only a *known* domain-input failure mode gets translated, everything else stays a loud, visible bug.

`src/domain/pricing/errors.js` is the first implementation; `pricingRule.service.js#previewCalculation` is the first (and, as of this writing, only) translation boundary, wrapping its one call into `calculate()`. This pattern is intended to generalize: any future pure domain module (a discount-calculation module, a route-optimization module, whatever comes next) that needs to signal "the input was bad" defines its own dependency-free `*InputError` class following the same `field`/`reason` shape, and the service consuming it performs the same catch-and-translate at its own boundary — there's no shared base class or registry to update, each domain module and its consuming service own their own vocabulary independently.

## Consequences

The domain layer stays genuinely pure — `DomainInputError` is defined in `src/domain/pricing/errors.js`, imported only by other files inside `src/domain/pricing/`, with no dependency on `src/utils`, `src/middleware`, or anything HTTP-shaped. Clients of the API now receive precise, actionable `4xx` errors (`error.details.field` names exactly which input was wrong, `error.details.reason` is stable enough for a frontend to branch on) instead of an opaque `500` that gives no hint the problem was on the caller's side. On-call/monitoring benefits symmetrically: a `500` in the logs now reliably means something unexpected actually broke, not "a client forgot a field" — the noise that would otherwise pollute that signal is filtered out at the exact point it's identified.

The cost is two failure vocabularies that now have to be kept in sync by hand: the domain's `reason` strings, and the service's `apiError` codes that a given `reason` maps to. There is no compiler-enforced link between them — a new `reason` value added in the domain silently does nothing useful until the service's `catch` block (or, in this case, the direct pass-through of `err.field`/`err.reason` into `apiError`'s `details`) is updated to account for it, though the current implementation sidesteps most of this by forwarding `field`/`reason` directly into the response `details` rather than switching on `reason` to pick a different `apiError` code per case — the translation is deliberately generic (every `DomainInputError` becomes the same `INVALID_CALCULATION_INPUT` code, with `reason` as a sub-classification inside `details`) rather than maintaining a `reason` → code mapping table, which was judged not worth the added indirection for a single call site. This also adds a small amount of boilerplate at every service-domain boundary (the `try/catch` plus translation block) — accepted as the price of keeping the domain layer's isolation real rather than aspirational.

## Consulted

Standing Rule 5: "Domain-error translation is a service responsibility. Services wrap domain calls in try/catch and translate known error types to apiError. Only truly unexpected errors bubble as 500s."
