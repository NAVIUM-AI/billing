# Reference PDFs — ground truth for invoice PDF layout

These three PDFs were provided by the client (Pravasi Tours & Travels) as real examples of what an invoice from their business should look like. They are the ground truth for `src/templates/pdf/`'s layout — not the task specs that describe the templates in prose, and not the automated `verify-pdf.sh` checks, both of which can drift from what the client actually needs (see Rule 10 in Task 4.7's spec, and ADR-015 on why document-rendering tasks require visual review, not automation alone).

| File | Represents | Used as the reference for |
| --- | --- | --- |
| `PTT-150.pdf` | Tax Invoice, LOCAL service, B2B customer | `invoice-local-tax.hbs` |
| `PTT-151.pdf` | Tax Invoice, OUTSTATION service, B2B customer | `invoice-outstation-tax.hbs` |
| `PTT-152.pdf` | Proforma Invoice, LOCAL service, B2B customer | `invoice-proforma-local.hbs` |

There is no client-provided reference for a Proforma OUTSTATION invoice or for any B2C variant — `invoice-proforma-outstation.hbs` was built by carrying `invoice-outstation-tax.hbs`'s column set forward (minus GST) per Task 4.7's own instructions, and the B2C variants were verified by inspecting the Bill To block against what PTT-150/151/152 would render if the GSTIN/State fields were absent, not against a fourth reference document.

## How to use these

Any future change to `src/templates/pdf/*/invoice-local-tax.hbs`, `invoice-outstation-tax.hbs`, or `invoice-proforma-local.hbs` (or the shared partials they include) should be diffed visually against the matching PDF here — render a sample invoice, convert it to an image (`qlmanage -t` on macOS, or an equivalent PDF-to-image tool elsewhere), and compare side by side. Do not rely on `verify-pdf.sh`'s text-content assertions alone to catch a layout regression; they check that specific strings are present or absent, not that the page looks right (font sizes, column alignment, spacing, an orphaned label with nothing after it). Whichever of the two disagrees — a written template spec or one of these PDFs — the PDF wins.

## Known gaps between these PDFs and what the current schema can reproduce

The sender header on PTT-150/151 shows a tagline, a full postal address, and a phone/email line that no `tenants` column currently stores, plus a jurisdiction sentence in the footer that would need a tenant city/jurisdiction field. The Bank Details block shows a PAN distinct from the tenant's own PAN (likely the bank-account holder's), which `bank_details` doesn't have a field for. Both are documented in `docs/modules/module-4-invoices/known-issues.md` rather than fabricated — closing them requires new `tenants`/`bank_details` fields (a schema change), which was out of scope for the task that added these fixtures (Task 4.7).
