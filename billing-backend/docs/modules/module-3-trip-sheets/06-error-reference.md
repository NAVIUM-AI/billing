# Error code reference

_Last updated: 2026-07-19. Reviewers: TBD._

Every `apiError(...)` call site in `src/services/tripSheet.service.js`, `src/services/performanceSheet.service.js`, `src/repositories/tripSheet.repository.js`, and `src/repositories/tripToll.repository.js` (`src/validators/tripSheet.validator.js` raises no `apiError` of its own — Joi validation failures are all wrapped into `VALIDATION_ERROR` by the shared `validate` middleware, listed below under "Codes shared with Module 1"), verified by grepping every file for `apiError(status, "CODE"` and cross-checking the result set is exhaustive. Every error response follows `{ "error": { "code", "message", "details"? } }` (`src/middleware/errorHandler.js`).

## Module 3 specific error codes

| Code | HTTP | When it fires | Where (file) | Fix |
| --- | --- | --- | --- | --- |
| `EMPTY_PATCH` | 400 | `PATCH /trips/:id`'s body, after the repository's `DRAFT_UPDATABLE_COLUMNS` whitelist is applied, contains zero updatable keys | `src/repositories/tripSheet.repository.js` (`updateDraft`) | In practice unreachable from a real request — `updateTripSheetSchema`'s own `.min(1)` already rejects an empty body at the Joi layer before this code path is reached |
| `EXPORT_TOO_LARGE` | 400 | The performance sheet's filtered row count exceeds the 10,000-row cap (`MAX_ROWS`) — applies to both the JSON and CSV endpoints, since the CSV endpoint calls the same underlying function | `src/services/performanceSheet.service.js` (`getPerformanceSheet`) | `error.details.max_rows` names the cap; narrow the request with `from_date`/`to_date` or `customer_id` |
| `INVALID_CALCULATION_INPUT` | 400 | `calculate()` (the pricing domain) throws `DomainInputError` while creating or PATCHing a trip — the resolved rule's calculator was given usage values it can't compute against | `src/services/tripSheet.service.js` (`computeTripTotals`, called from both `createTripSheet` and `updateTripSheet`) | `error.details.field` and `error.details.reason` name the exact input at fault (same translation pattern as Module 2's identically-named code — see ADR-006); `error.details.rule_type` names which calculator rejected it |
| `INVALID_DATETIME_RANGE` | 400 | The DB CHECK `trip_sheets_datetime_range` fires (`end_datetime < start_datetime`) — reachable only if a request bypasses the Joi-level equivalent, since the validator doesn't cross-check this pair itself (only `opening_km`/`closing_km` is checked at the service layer pre-write) | `src/repositories/tripSheet.repository.js` (`insert`, `updateDraft`) | Ensure `end_datetime >= start_datetime` |
| `INVALID_KM_RANGE` | 400 | `closing_km < opening_km`, checked at the service layer before the write (both create and PATCH) with the DB CHECK `trip_sheets_km_range` as the backstop | `src/services/tripSheet.service.js` (pre-check), `src/repositories/tripSheet.repository.js` (DB CHECK backstop, `insert` and `updateDraft`) | Ensure `closing_km >= opening_km` |
| `INVALID_STATE_TRANSITION` | 409 | A requested status transition isn't legal per `src/domain/tripLifecycle`'s `TRANSITIONS` map — fires from `finalizeTripSheet`, `cancelTripSheet`, and the unrouted `markTripInvoiced` | `src/services/tripSheet.service.js` (`assertTransition`) | `error.details.allowed_transitions` lists what WOULD have worked from the trip's current `error.details.current_status`; reload the trip and act accordingly |
| `NO_APPLICABLE_PRICING_RULE` | 400 | No `pricing_rules` row covers the trip's `(vehicle_type, rule_type, trip_date)` at creation or PATCH-triggered recompute time | `src/services/tripSheet.service.js` (`createTripSheet`) | `error.details.vehicle_type` and `error.details.rule_type` name the missing combination; configure a rule in Settings → Pricing for that vehicle type and date |
| `TOLL_INPUT_CONFLICT` | 400 | Both a nonzero `toll_rupees` and a non-empty itemized `tolls` array were supplied on the same create or PATCH request | `src/services/tripSheet.service.js` (`createTripSheet`, `updateTripSheet`) | Provide either a lump-sum `toll_rupees` or an itemized `tolls` array, not both. On PATCH specifically, an explicitly-empty `tolls: []` alongside a new `toll_rupees` is NOT a conflict — that's read as "switch from itemized to lump-sum" |
| `TRIP_NOT_EDITABLE` | 409 | `PATCH /trips/:id` targets a trip whose `status` is not `DRAFT` | `src/services/tripSheet.service.js` (`updateTripSheet`) | `error.details.current_status` names the trip's actual status; only `DRAFT` trips can be edited — finalize/cancel are the only paths off `DRAFT` |
| `TRIP_NOT_FOUND` | 404 | `tripId` doesn't exist, or belongs to a different tenant (indistinguishable by design — RLS-scoped lookups return the same 404 either way) | `src/services/tripSheet.service.js` (every function that resolves a trip by id) | Verify the id and that you're authenticated as the owning tenant |
| `TRIP_NUMBER_COLLISION` | 409 | The DB unique constraint `trip_sheets_number_per_tenant_unique` fires — should never happen under normal operation, since `trip_sheet_sequences`' atomic allocation guarantees a fresh number every time | `src/repositories/tripSheet.repository.js` (`insert`) | Retry the request; if this recurs, it indicates a bug in sequence allocation, not routine contention — see `07-debugging-playbook.md` |
| `TRIP_STATUS_CHANGED` | 409 | `finalizeTripSheet`/`cancelTripSheet`'s guarded `UPDATE ... WHERE status = $from` matched zero rows — someone else transitioned the trip between the row-lock read and the write. Defensive; should not occur given the row lock actually held for the transaction's duration | `src/services/tripSheet.service.js` (`finalizeTripSheet`, `cancelTripSheet`) | Reload the trip and retry the intended transition |
| `TRIP_STATUS_CHANGED_DURING_UPDATE` | 409 | Same defensive case as `TRIP_STATUS_CHANGED`, for `PATCH /trips/:id`'s guarded `updateDraft` call specifically | `src/services/tripSheet.service.js` (`updateTripSheet`) | Reload the trip and retry the edit |

## Codes shared with Module 2

These originate in Module 2 services/repositories but are raised directly by Module 3 code (trip creation resolves a customer, vehicle, driver, and pricing rule, and surfaces each one's own not-found code verbatim) — full definitions are in `docs/modules/module-2-master-data/06-error-reference.md`.

| Code | HTTP | When it fires in Module 3 |
| --- | --- | --- |
| `CUSTOMER_NOT_FOUND` | 404 | `customer_id` on a create doesn't resolve to an active customer in the tenant |
| `VEHICLE_NOT_FOUND` | 404 | `vehicle_id` on a create doesn't resolve to an active vehicle in the tenant |
| `DRIVER_NOT_FOUND` | 404 | `driver_id`, if supplied on create or PATCH, doesn't resolve to any driver in the tenant (inactive drivers ARE accepted — only a genuinely missing id is rejected) |

`NO_APPLICABLE_PRICING_RULE` is listed above under Module 3's own table rather than here, since — unlike the three codes above, which are Module 2's own not-found errors surfaced verbatim — it's raised directly by `tripSheet.service.js` itself (Module 2's equivalent pricing-lookup miss is a differently-named code, `NO_APPLICABLE_RULE`, raised by `pricingRule.service.js` for `GET /pricing/rules/applicable` and `POST /pricing/preview`).

## Codes shared with Module 1

Every Module 3 endpoint requires authentication and a tenant context, so any request can surface these regardless of which trip-sheet route it hit. Full definitions are in `docs/modules/module-2-master-data/06-error-reference.md`, which documents them as **(shared)** entries.

| Code | HTTP | When it fires |
| --- | --- | --- |
| `AUTH_REQUIRED` | 401 | No `Authorization` header, or a permission check ran before `authenticate` populated `req.user` (should be unreachable — every Module 3 route mounts `authenticate` first) |
| `ACCESS_TOKEN_EXPIRED` | 401 | The JWT access token's `exp` has passed |
| `FORBIDDEN` | 403 | The authenticated user's role isn't listed for the permission key the route requires (`trips:read`, `trips:write`, `trips:finalize`, or `trips:cancel` in `src/config/accessMatrix.js`) — `error.details.required` names the key |
| `VALIDATION_ERROR` | 400 | Any Joi schema validation failure across every Module 3 validator (`createTripSheetSchema`, `updateTripSheetSchema`, `cancelTripSchema`, `tripIdParamSchema`, `listTripsQuerySchema`, `performanceSheetQuerySchema`, `performanceSheetCsvQuerySchema`) | 
| `NOT_FOUND` | 404 | No route matches the request path at all (e.g. `POST /trips/:id/invoice`, which is deliberately never registered) |
