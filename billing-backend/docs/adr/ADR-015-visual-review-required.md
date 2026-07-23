# ADR-015: Tasks that render a human-consumable document require visual review as an acceptance criterion

_Last updated: 2026-07-23. Reviewers: TBD._

## Status

Accepted (Task 4.5).

## Context

Task 4.5's PDF-rendering work initially shipped with a real content bug: the GST "Place of Supply" lookup was keyed by the official numeric CBIC state code (`"29"` → Karnataka), but this application's own `tenants.state_code`/`customers.state_code` columns store a 2-letter abbreviation (`"KA"`), derived from a GSTIN's leading digits by `src/utils/gstin.js#GST_STATE_MAP` and compared as a plain string by `src/domain/gst/index.js#isSameState`. The numeric code the lookup was keyed on never appears anywhere in this schema, so every lookup silently missed, and "Place of Supply" simply never rendered on any generated PDF — not a crash, not an error, just a quietly absent line.

Every automated check for this feature passed regardless: the PDF file existed on disk, had the correct MIME type and `%PDF` byte signature, had a nonzero size, and was correctly isolated per tenant. None of those checks — by design, per the standing rule that tests should verify a component did what it claims rather than pin exact rendered content to a specific Chromium version — inspect *which fields actually appear* in the rendered page. The gap between "a PDF was generated" and "the PDF is content-correct" is not something any number of file-existence or byte-count assertions can close; the only thing that actually catches a silently-missing field is looking at the rendered output. This was caught by rendering a sample PDF to an image and reading it, not by any assertion in `verify-pdf.sh`.

## Decision

Any task that produces a human-consumable rendered document — a PDF, an HTML email, an exported spreadsheet, a printed report — requires visual review as an explicit acceptance criterion, in addition to (not instead of) whatever automated generation checks already exist. The task's own debrief states that this review happened and names what it covered — "visually verified against a real generated PDF for each of the four templates" or equivalent — and lists any content defect the review found and fixed, the same way a functional bug is reported. Automated checks continue to assert that generation *happens correctly* (file exists, correct type, correct size, correct access control); they are not expected to, and should not try to, assert exact rendered byte content, since that remains a Chromium-version concern rather than an application-logic one.

## Consequences

Content-level bugs — a missing field, a mislabeled column, an incorrect GST split rendered on the page even though the underlying stored number is correct — get caught before the work ships, rather than surfacing later when a real user or a real tax authority notices a document doesn't say what it should. The cost is a small, fixed amount of debrief overhead per document-producing task (on the order of five to ten minutes to render a sample, look at it, and note the result) — judged clearly worth paying, since the alternative is shipping silent content defects in a system whose entire purpose is producing legally-relevant tax documents. This applies going forward to any further PDF-template work, any future email-template work, and any Module 5+ feature that renders a document a human is expected to read and trust.

## References

Task 4.5 debrief (the state-code lookup bug, caught by rendering and reading a sample PDF rather than by any of the 18 automated `verify-pdf.sh` checks, all of which passed regardless); Standing Rule 13.
