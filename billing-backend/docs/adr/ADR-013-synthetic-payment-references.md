# ADR-013: Synthetic payment references include every parameter of the business event they represent

_Last updated: 2026-07-23. Reviewers: TBD._

## Status

Accepted (Task 4.4).

## Context

Task 4.4 added an idempotency guard on `payments`: a unique index on `(tenant_id, payment_mode, reference_number)`, scoped to `RECORDED` non-`CASH` payments, so the same NEFT UTR or UPI transaction ID can never be recorded twice as an active payment. Two payment-service code paths generate their own synthetic reference for a derived row rather than accepting one from the caller, and both need that synthetic string to itself be unique under the same index, or the very feature meant to prevent duplicate recording would instead produce a spurious `PAYMENT_REFERENCE_DUPLICATE` on a second, entirely legitimate event:

- **Over-payment split** (`recordPaymentOnInvoice`): when a payment exceeds an invoice's outstanding balance, the excess spills into a new unallocated advance row, linked back to the applied portion via `parent_payment_id`.
- **Partial advance application** (`applyAdvanceToInvoice`): when an advance larger than an invoice's outstanding balance is applied, only part of it is consumed, leaving a decremented advance row available for a later application to a *different* invoice.

A reference generated from only the originating payment's own id — `applied-from-advance-{advance.id}`, for instance — is stable across every future partial application of that same advance, since `advance.id` never changes. The first partial application of a large advance to invoice A would insert that reference successfully; a later partial application of the *same* remaining advance to invoice B would generate the identical string and collide with the very idempotency index meant to catch actual duplicates, rejecting a legitimate second application as if it were a repeat of the first.

## Decision

Every synthetically-generated payment reference includes every parameter that distinguishes one occurrence of its business event from another — not just the originating payment's id, but also whichever other identifier the event is scoped by:

- Over-payment spillover: `` `${originalReferenceNumber}#advance-of-{appliedPortion.id}` ``, keyed off the just-inserted applied-portion payment's own id so it never collides with the (already-recorded) applied row's own reference.
- Partial advance application: `` `applied-from-advance-{advance.id}-to-{invoice.id}` ``, including the target invoice's id specifically so repeated partial applications of the *same* advance to *different* invoices each get a distinct, non-colliding reference.

If N independent parameters together define what makes one occurrence of an event unique from another, all N appear in the generated reference string.

## Consequences

Synthetic reference strings are guaranteed unique across the full key space of the business events that generate them, so the idempotency index continues to do its intended job — catching genuine accidental duplicates — without also rejecting legitimate, distinct events that happen to share one but not all of their originating identifiers. As a side benefit, the reference strings stay human-readable as an audit trail: `applied-from-advance-<uuid>-to-invoice-<uuid>` tells a reader exactly what happened without needing to cross-reference `parent_payment_id` separately.

The cost is that these synthetic references are longer and more verbose than the naive, single-parameter version — acceptable, since they're internal audit strings assembled by the service layer and never something a user types in or needs to read at a glance the way a real NEFT UTR is.

## References

Task 4.4 debrief; `src/services/payment.service.js`'s own top-of-file comment (documents both concrete collisions this ADR generalizes from, caught during verify-script development before shipping).
