# Debugging playbook

_Last updated: 2026-07-18. Reviewers: TBD._

Concrete scenarios, written as "when you see X, check Y." Every check below is something to actually run, not a hypothesis to consider.

## "The list endpoint returns nothing but I know rows exist"

- Is the request authenticated at all? RLS filters every business table on `app.current_tenant_id`; if that session variable is never set (no valid JWT reached `authenticate`), every `SELECT` against `vehicles`/`drivers`/`customers`/`pricing_rules` returns zero rows — not an error, just an empty result, which looks identical to "there really are no rows" from the client's perspective.
- Is `includeArchived=false` (the default on every list endpoint) hiding the rows you're looking for? Confirm with `includeArchived=true`.
- Was the search string normalized the way you expect? Every `listXxx` service normalizes the query-string `search` exactly once (`02-architecture.md`, "The normalize-once boundary") — if you're searching a phone number, remember the canonical form is `91`-prefixed, so `search=98765` will substring-match fine, but comparing what you *expect* to match against the raw column value (not the canonical form) will mislead you.
- Is the JWT's tenant actually the tenant that owns the data you're looking for? Easy to get wrong when juggling multiple test accounts across terminals.
- Fastest way to check what's really in the table, bypassing the API and RLS together (dev/superuser only — this is exactly the kind of access RLS exists to prevent in production):

  ```sql
  -- As a superuser (e.g. local 'apple' role), RLS doesn't apply at all.
  SELECT * FROM vehicles WHERE tenant_id = '<uuid>';

  -- As the app role (billing_app), RLS DOES apply — set the session var
  -- yourself to see what the app would see:
  SET LOCAL app.current_tenant_id = '<uuid>';
  SELECT * FROM vehicles;
  ```

## "Duplicate detection isn't catching a duplicate"

- Check what `normalize()` actually produces for both inputs — `src/utils/vehicleNumber.js`, `src/utils/phoneNumber.js`, or `src/utils/gstin.js` depending on the field. Two values that look different to a human can normalize to the same canonical string, and two values that look the same to a human (e.g. a phone number with a typo'd digit) will not.
- Is the existing record archived? An archived row still holds its unique constraint — Postgres doesn't care that `is_active = false` — but the *service-layer* pre-check that gives a friendly `*_ARCHIVED_EXISTS` error only fires when it specifically looks for an archived match (`findByPhone`/`findByGstin`/`findByNumber` + `!existing.is_active`). If you're not seeing an archived-exists error where you expect one, confirm the pre-check ran at all rather than assuming duplicate detection is broken outright — a genuine duplicate against an *active* record still gets caught by the database's own unique constraint either way, just with a plainer error.
- Reproduce directly in `psql`:

  ```sql
  SET LOCAL app.current_tenant_id = '<uuid>';
  SELECT id, is_active, vehicle_number FROM vehicles
    WHERE tenant_id = '<uuid>' AND vehicle_number = '<canonical>';
  ```

## "409 PRICING_RULE_OVERLAP on a first-time create"

- The migration didn't seed any rules — check for prior test data instead. This is the single most common cause when running `verify-pricing.sh` or manual testing repeatedly against the same tenant: an earlier run already created an open-ended (`effective_to IS NULL`) rule for the same `(tenant, rule_type, vehicle_type)`, and *any* new `effective_from` you try will fall inside that already-open range.

  ```sql
  SET LOCAL app.current_tenant_id = '<uuid>';
  SELECT id, rule_type, vehicle_type, effective_from, effective_to
    FROM pricing_rules
    WHERE rule_type = 'LOCAL_PACKAGE' AND vehicle_type = 'SEDAN'
    ORDER BY effective_from;
  ```
- If a rule genuinely exists and you meant to change its rate, use `POST /pricing/rules/:id/supersede`, not another `POST /pricing/rules`.

## "GSTIN_STATE_MISMATCH but I typed the state correctly"

- The GSTIN's first two digits encode the state it was *issued in* by the tax department — not the tenant's own operating state, and not necessarily the customer's mailing address state. Decode the GSTIN yourself: `gstin.slice(0, 2)` against `src/utils/gstin.js`'s `GST_STATE_MAP` (e.g. `"29"` → `"KA"`).
- If the mapping looks wrong for a real, valid GSTIN, check whether `GST_STATE_MAP` is simply missing that numeric code — it covers all current Indian states and union territories as of when it was written, but a State reorganization or new UT code would need a corresponding update there.

## "Enum operator does not exist: X = text"

- A query parameter is being compared against an `enum`-typed column without an explicit cast. Postgres has no implicit cast from `text` to a custom enum type, so `WHERE rule_type = $1` fails outright if `$1` arrives as plain text — it has to be `WHERE rule_type = $1::pricing_rule_type_enum` (or `::vehicle_type_enum`, `::customer_type_enum`). This is a recurring class of bug across this module — it first showed up in `customer.repository.js#list`'s `customer_type` filter and was fixed by adding the cast; every enum comparison written since has the cast from the start. If you add a new query against `vehicle_type`, `customer_type`, or `rule_type`, cast it.

## "Preview endpoint total doesn't match my calculation"

- Are you comparing rupees to paise? Every internal total in `result` is integer paise; `result.formatted` has the same values as human-readable rupee strings for convenience, but if you're eyeballing `result.total_paise` directly, remember to divide by 100.
- Did the applicable rule change between the date you're querying and today? `POST /pricing/preview`'s `on_date` selects which *version* of the rule applies — if a supersede happened between the invoice date you're checking and now, an `on_date` before the supersede's `effective_from` uses the old rate, and on/after uses the new one. Confirm which rule actually resolved via the `rule` object in the response (`rule.id`, `rule.effective_from`, `rule.effective_to`) before assuming the math is wrong.

## "Cross-tenant test passes locally but I'm worried"

- Run `npm run verify:tenants` (Task 1.4's script) — it proves isolation on the throwaway `tenant_pings` table specifically, independent of any Module 2 table.
- Run `npm run verify:vehicles` / `verify:drivers` / `verify:customers` / `verify:pricing` — each includes an explicit cross-tenant leak test (tenant B reading tenant A's record via a direct HTTP request) and a DB-layer check connecting as the app role with no tenant context set.
- Confirm `FORCE ROW LEVEL SECURITY` is actually set on every Module 2 table — `ENABLE` alone is not enough (see ADR-003); a table with RLS enabled but not forced silently exempts the owning role, which is exactly the role this application connects as:

  ```sql
  SELECT relname, relforcerowsecurity
    FROM pg_class
    WHERE relname IN ('vehicles', 'drivers', 'customers',
                       'customer_contacts', 'pricing_rules');
  ```

  Every row must show `t` in `relforcerowsecurity`.

## "PATCH request succeeds (200) but nothing seems to have changed"

- Every repository's `update`/`updatePatchable` function whitelists which columns a patch is allowed to touch, and silently drops anything not on that list — the request can still succeed if at least one *allowed* field was also present. If you sent `{ "vehicle_number": "NEW123", "notes": "updated" }` to `PATCH /vehicles/:id`, the `notes` change lands and `vehicle_number` is quietly ignored, because `vehicle_number` was never in `updateVehicleSchema` to begin with — it fails Joi validation as an unknown-but-stripped field rather than reaching the repository at all in that specific case, but the general shape (some fields in a patch are immutable and silently rejected or stripped) applies across every master. Check the specific validator's schema (`updateVehicleSchema`, `updateDriverSchema`, `updateCustomerSchema`, `updateRuleSchema`) for which fields are actually editable before assuming a bug.

## "A date came back one day off from what I stored"

- This class of bug has bitten this module twice already, both fixed, but worth knowing the shape of if a new one shows up: Postgres `DATE` columns and JavaScript `Date` objects don't agree on what "the same calendar date" means once a timezone conversion happens anywhere in the pipeline. `src/config/db.js` installs a custom type parser (`types.setTypeParser(types.builtins.DATE, ...)`) so `pg` returns `DATE` columns as plain `'YYYY-MM-DD'` strings instead of JS `Date` objects — if you ever see a date shift by exactly one day, check whether something downstream is calling `new Date(dateString)` on one of these values and then formatting it back out with a timezone-sensitive method (`.toISOString()`, `.toLocaleDateString()` without an explicit UTC option). The pricing-rules validator (`src/validators/pricingRule.validator.js`) has a longer write-up of the same class of bug on the *write* path (Joi's `.isoDate()` silently reformats a plain date into a full UTC datetime string) and why every date field in this module is validated as a hand-rolled plain string instead.

## "Superseding a pricing rule fails validation even though the date looks right"

- `supersedeSchema` requires `effective_from` to be today or later — you cannot retroactively supersede a rate for a date that has already passed (see `05-design-decisions.md`, "Why pricing rate values are immutable"). If you're working from an example or an old test fixture with a hardcoded date, that date is almost certainly in the past relative to whenever you're actually running the request now; use the actual current date (or later) instead of a fixed literal.

## "The preview endpoint returned a 500, not a 400"

- This is a known, currently-unmapped gap, not a code you should expect to see documented as a deliberate error — see `06-error-reference.md`'s closing note and `known-issues.md`. If `usage` is missing a field the resolved rule's calculator actually needs (e.g. `total_hours` for a `LOCAL_PACKAGE` rule, `total_days` for `OUTSTATION_SLAB`), the calculator throws a plain `TypeError`, which isn't an `apiError` and so falls through to the generic `500 INTERNAL_ERROR` handler. Check the response body's `error.details.stack` (only present outside `NODE_ENV=production`) — it will name the exact missing field via the calculator's own `assertNonNegInteger`/`assertLocalRule`-style guards.
