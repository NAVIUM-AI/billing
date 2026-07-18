# Architecture

_Last updated: 2026-07-18. Reviewers: TBD._

## Layered architecture

Every write and read in Module 2 flows through the same four layers, in the same order, for every entity:

```
HTTP → Route → Validator → Service → Repository → SQL
                  │           │           │
                  ▼           ▼           ▼
               Joi schema  Business    Postgres +
                           rules       RLS
```

The **route** (`src/api/v1/*.routes.js`) is deliberately thin: it wires `authenticate` + `tenantContext` + `requirePermission(key)` + `validate(schema)` in front of a handler that does nothing but call a service function and shape the HTTP response. No business logic and no SQL live here.

The **validator** (`src/validators/*.validator.js`) defines the shape of a request with Joi — required fields, types, formats, and, for a handful of two-form fields (vehicle number, phone, GSTIN), a `.custom()` transform that normalizes the raw string into a richer value before the service ever sees it. Validators do not decide *whether* a field is required given another field's value (e.g. "GSTIN is required for B2B but not B2C") — that's a service-layer concern, because it depends on data the validator doesn't have context for cleanly.

The **service** (`src/services/*.service.js`) is where the business rules live: cross-field validation, duplicate/archived-record pre-checks, unit conversion (rupees to paise), and the transaction boundary (`db.withTenantContext`). Every service function that creates or updates a record follows the same internal order — see "The service-order rule" below.

The **repository** (`src/repositories/*.repository.js`) holds every line of SQL for its table and nothing else. It accepts already-normalized primitives (not raw request bodies) and a `client` — a pg client that the service obtained via `db.withTenantContext()`, already scoped to the caller's tenant. Repositories never normalize input and never decide business rules; their only "cleverness" is mapping a Postgres constraint violation (unique, check, exclusion) to a specific `apiError` code so the caller gets something more useful than a raw SQLSTATE.

## The service-order rule

Every create/update service function in Module 2 follows the same five-step order, first articulated while building the customers module (Task 2.3) and applied consistently to pricing rules (Task 2.4) afterward:

1. **Normalize** inputs — convert wire-format values (rupee decimals, raw phone strings) into their canonical internal form (paise integers, `{ canonical, display }` pairs).
2. **Derive** missing fields from the ones that were provided.
3. **Cross-field validation** — reject combinations that don't make sense together.
4. **Persistence checks** — look for existing/archived records that would conflict.
5. **Transactional write** — the actual `INSERT`/`UPDATE`, inside `db.withTenantContext`.

Step 2 has to run *before* step 3, not after, and the clearest illustration is `pricingRule.service.js#createRule` for a B2B-style required-fields check (the same shape shows up in `customer.service.js#createCustomer` for GSTIN/state_code). A caller creating a pricing rule can supply `gstin`-equivalent context implicitly — concretely, in the customer case: a B2B customer can submit a GSTIN without a `state_code`, and `state_code` is required for B2B. If the required-fields check (step 3) ran before derivation (step 2), a perfectly valid request — GSTIN provided, state code omittable because it's derivable from the GSTIN — would be rejected for "missing" a field the service was fully capable of filling in itself. `customer.service.js#createCustomer` derives `stateCode` from `gstinUtil.stateFromGstin(gstin)` *before* running the B2B required-fields check specifically so that this case succeeds instead of bouncing the caller for no real reason:

```js
// Auto-derive BEFORE the B2B required-fields check below: a B2B
// customer that supplies gstin but omits state_code should succeed,
// with state_code filled in for them, rather than be rejected for a
// field we can derive ourselves.
if (gstin && !stateCode) {
  stateCode = gstinUtil.stateFromGstin(gstin);
}

if (input.customer_type === "B2B") {
  if (!input.company_name || !gstin || !stateCode) {
    throw apiError(400, "B2B_REQUIRED_FIELDS", ...);
  }
}
```

Getting this ordering backwards doesn't just produce worse error messages — it produces *wrong* rejections for legitimately complete requests.

## The normalize-once boundary

A field that has more than one valid input format — a phone number, a vehicle registration, a GSTIN — is normalized exactly once, at the service's input boundary, and the repository never re-derives it. This applies both to values being written and to search terms being read. `customer.service.js#listCustomers` is the clearest example, because a single free-text `search` query string has to be checked against three different columns, each of which wants the term in a different canonical form:

```js
// Normalized once here, mirroring listVehicles/listDrivers — the repo
// receives all forms and does not re-normalize.
const searchOriginal = search ? search.trim() : null;
const searchPhoneCanonical = searchOriginal
  ? phone.normalize(searchOriginal) || null
  : null;
// gstinUtil.normalize just uppercases + strips whitespace — safe to
// run on any input, even non-GSTIN search text.
const searchGstinCanonical = searchOriginal
  ? gstinUtil.normalize(searchOriginal)
  : null;
```

`customer.repository.js#list` receives all three forms as plain arguments and matches `name`/`company_name`/`email` against `searchOriginal`, `phone` against `searchPhoneCanonical`, and `gstin` against `searchGstinCanonical` — it never calls `phone.normalize()` or `gstinUtil.normalize()` itself. The alternative — letting the repository normalize — was rejected because it invites the two most common variants of this bug: normalizing twice with slightly different logic in two call sites, or a repository silently doing the "wrong" normalization for a caller that already normalized upstream. See ADR-004.

## Multi-tenancy: two-layer isolation

Every table in this module enforces tenant isolation at two independent layers, a pattern established in Module 1 and continued here without exception:

- **Application layer** — `tenantContext` middleware reads the tenant id off the authenticated user's JWT and sets it as a Postgres session variable (`app.current_tenant_id`) for the duration of the request's transaction.
- **Database layer** — every business table (`vehicles`, `drivers`, `customers`, `customer_contacts`, `pricing_rules`) has a row-level security policy that filters on that same session variable, and — critically — `FORCE ROW LEVEL SECURITY` is set on every one of them, because Postgres normally exempts a table's owning role from its own RLS policies, and the application connects as that owning role.

Module 1's docs (not yet written) will cover the middleware and RLS mechanics in depth; `docs/modules/module-2-master-data/03-database-schema.md` reproduces each table's actual policy SQL.

## Pure domain: pricing calculators

`src/domain/pricing/` has zero imports from `express`, `pg`, or any other framework or infrastructure code — every file in that folder is plain functions operating on plain JavaScript objects. This is deliberate for three reasons: it's **testable** without a database, a server, or even an HTTP client (`scripts/test-pricing-calc.js` runs the calculators directly with `node`, asserting against known invoice numbers, in well under a second); it's **auditable**, since the entire pricing formula for a rule type is readable top to bottom in one small file with no framework indirection to trace through; and it's **portable** — the same calculator could run in a different context (a batch job recalculating historical trips, a frontend doing a client-side estimate) without dragging in the HTTP/database stack that the rest of the module depends on.
