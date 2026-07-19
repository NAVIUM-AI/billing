# ADR-007: Selective 5xx message masking in the global error handler

_Last updated: 2026-07-19. Reviewers: TBD._

## Status

Accepted (2026-07-19)

## Context

The global error handler (`src/middleware/errorHandler.js`) masked the message for any status code 500 or above, replacing it unconditionally with the string `"Internal server error"`. The intent was defensive: a 5xx status is, in the common case, the result of an uncaught exception — a database driver error, a null-pointer bug, a third-party library throwing something unexpected — and that exception's `.message` can easily contain a SQL fragment, a file path, or other internal detail that shouldn't reach a client. Blanket-masking every status `>= 500` was a reasonable first pass at that concern.

RFC 7231 defines `501 Not Implemented` differently from the rest of the 5xx range, though: it's not a failure at all in the sense the other codes are. The server understood the request perfectly well and is deliberately declining to handle it, because the capability doesn't exist yet. Every other 5xx code in common use (500, 502, 503, 504) describes something going wrong that the server did not choose; 501 describes a choice. Its message is therefore not exception leakage to be defended against — it's the entire point of the response, analogous to a 400 or 404 message in that it's written by the developer, for the client, on purpose.

Task 3.1 hit this concretely: `POST /trips` with `service_type: "OUTSTATION"` returned `501` with a message explaining that outstation trip creation shipped in Task 3.2, plus `details.service_type` for programmatic handling. The blanket mask stripped the message down to `"Internal server error"` before it reached the client, so a caller had only the `details` object to go on — the human-readable half of the response, which existed specifically to be human-readable, never arrived. The stub itself was replaced by a real implementation in Task 3.2, so no live code path in this codebase returns 501 today, but the masking bug in `errorHandler.js` would silently recur the next time any endpoint used `apiError(501, ...)` for a genuine "not implemented yet" response — a plausible pattern for a codebase that ships features task-by-task.

## Decision

Mask messages selectively, gated by a fixed set of status codes rather than a `>= 500` range check:

- `500` (Internal Server Error) → mask
- `502` (Bad Gateway) → mask
- `503` (Service Unavailable) → mask
- `504` (Gateway Timeout) → mask
- `501` (Not Implemented) → passthrough
- Any other 5xx code not in the masked set → passthrough

The masked set — `MASK_STATUSES = new Set([500, 502, 503, 504])` in `errorHandler.js` — is exactly "the status codes this codebase can plausibly produce by way of an uncaught exception or an unavailable dependency, where the message is not authored for the client." Everything outside that set is treated the same way 4xx messages already are: written by a developer via `apiError(...)`, safe to show, and part of the response's actual content rather than an accident of implementation.

Alternatives considered: keeping the blanket `>= 500` mask and instead attaching the intended message to `details` rather than `message` for 501 responses specifically. Rejected — it special-cases one status code's response shape relative to every other status in the system, which every future 5xx-with-a-deliberate-message case (a hypothetical `503` used deliberately for planned maintenance, for instance) would also need to special-case individually, rather than being covered by the same general rule as 501.

## Consequences

`501` responses now carry their actual reason, restoring parity with how every 4xx code already behaves — a client reading `error.message` gets the same experience regardless of whether the server refused deliberately (4xx, 501) or failed unexpectedly (500/502/503/504). Clients can branch on `error.code` for either case as they already could, but no longer lose the human-readable half of a deliberate-refusal response. The defensive posture on the four codes that actually correspond to unexpected failure in this codebase is preserved exactly as before — nothing about `500`/`502`/`503`/`504` handling changed.

The cost is a small ongoing review discipline: any future callsite using `apiError(501, ...)` or any other passthrough-eligible 5xx code is now responsible for making sure its message is genuinely client-safe, the same discipline `apiError(4xx, ...)` callsites already carry. There is also a maintenance point — `MASK_STATUSES` is a literal set, not a formula, so adding support for a new 5xx-family status (a hypothetical `507 Insufficient Storage`, say) requires an explicit decision about which bucket it belongs in rather than falling out automatically from a `>= 500` check the way it used to. This is accepted as the right trade: the previous automatic behavior was exactly the bug this ADR fixes, so removing that automatism is the point, not a regression.

## Consulted

Standing Rule 5 (domain-error translation is a service responsibility; only truly unexpected errors bubble to the global handler as 500s) and Standing Rule 6 (fail early with codes the caller can act on) — both describe the same underlying principle this ADR applies at the transport layer: a deliberate, developer-authored response should read as one to the client, not be flattened into the same shape as an accident.
