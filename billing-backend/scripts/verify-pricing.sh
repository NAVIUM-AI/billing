#!/usr/bin/env bash
#
# End-to-end verification of the Task 2.4 pricing rules engine: RBAC
# (only owner/admin can write rates), rupee-to-paise normalization,
# the non-overlap exclusion constraint, per-rule-type required-field
# validation, list/filter, applicable-rule lookup (date-scoped),
# immutable rate fields (PATCH only allows label/notes/effective_to),
# atomic supersede (versioning), the preview/calculation endpoint
# against the known Yellow UI reference numbers, cross-tenant
# isolation, and DB-layer RLS. Mirrors scripts/verify-customers.sh
# (Task 2.3) in structure. Prints a PASS/FAIL summary and exits 1 if
# anything failed.
#
# Dates: the task's own worked example hardcodes 2026-01-01/2026-04-01
# style absolute dates for the supersede flow, which only works if
# "today" is before those dates. supersedeSchema enforces
# effective_from >= today (you can't retroactively supersede a rate
# for a date that's already passed), so this script computes all
# supersede-related dates RELATIVE to the actual current date instead
# of hardcoding ones that would silently go stale.
#
# Deliberately `set -u` but NOT `set -e`: we want every check to run
# even if an earlier one fails, so the summary reports everything
# that's broken in one pass instead of stopping at the first failure.
set -u

BASE_URL="http://localhost:8000/api/v1"
# See scripts/verify-tenant-isolation.sh for why this is direct
# Homebrew Postgres (no Docker container) connected to as the
# dedicated non-superuser 'billing_app' role — matches DATABASE_URL.
DB_NAME="${DB_NAME:-billing_dev}"
DB_ROLE="${DB_ROLE:-billing_app}"

TEST_PASSWORD="Passw0rd123"
OWNER_EMAIL="verify-price-owner-$(date +%s)@example.com"
STAFF_EMAIL="verify-price-staff-$(date +%s)-2@example.com"
OWNER_B_EMAIL="verify-price-owner-b-$(date +%s)-3@example.com"

# Safely in the past regardless of when this script runs, so the
# initial rule's effective_from never collides with "today must be >=
# effective_from" logic anywhere. WAY_PAST is before that again, used
# for the "no rule active on this date" miss case.
PAST_DATE="2020-01-01"
WAY_PAST_DATE="2015-01-01"
TODAY=$(date +%Y-%m-%d)
YESTERDAY=$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d 'yesterday' +%Y-%m-%d)

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
TOTAL_CHECKS=20
# See scripts/verify-auth.sh for why FAILED_STEPS is only ever expanded
# with [@]/[*] behind a length check (bash 3.2 + `set -u` compatibility).
FAILED_STEPS=()

pass() {
  PASS=$((PASS + 1))
  printf '%s✓ %s%s\n' "$GREEN" "$1" "$RESET"
}

fail() {
  FAIL=$((FAIL + 1))
  FAILED_STEPS+=("$1: $2")
  printf '%s✗ %s — %s%s\n' "$RED" "$1" "$2" "$RESET"
}

echo "Preflight checks"
echo "----------------"

SERVER_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL")
if [ "$SERVER_STATUS" != "200" ]; then
  printf '%sServer not reachable at %s.\nRun '\''npm run dev'\'' first.%s\n' "$RED" "$BASE_URL" "$RESET"
  exit 1
fi
echo "  server reachable at $BASE_URL"

if ! command -v psql >/dev/null 2>&1; then
  printf '%spsql is required for this script.%s\n' "$RED" "$RESET"
  exit 1
fi
if ! psql -U "$DB_ROLE" -d "$DB_NAME" -tAc 'SELECT 1' >/dev/null 2>&1; then
  printf '%sCould not connect to database "%s" as role "%s".%s\n' "$RED" "$DB_NAME" "$DB_ROLE" "$RESET"
  exit 1
fi
echo "  connected to database '$DB_NAME' as role '$DB_ROLE'"

if ! command -v jq >/dev/null 2>&1; then
  printf '%sjq is required for this script.\nInstall it with: brew install jq%s\n' "$RED" "$RESET"
  exit 1
fi
echo "  jq is installed"
echo "  using dates: past=$PAST_DATE, way_past=$WAY_PAST_DATE, yesterday=$YESTERDAY, today=$TODAY"
echo

# ─── SETUP: tenant A (owner + staff), tenant B (owner) ───
SIGNUP_STATUS=$(curl -s -o "$WORK_DIR/signup.json" -w '%{http_code}' -X POST "$BASE_URL/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Pricing Co\",\"email\":\"$OWNER_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner\"}")
if [ "$SIGNUP_STATUS" != "201" ]; then
  printf '%sSetup signup failed (status %s):%s\n' "$RED" "$SIGNUP_STATUS" "$RESET"
  cat "$WORK_DIR/signup.json"; echo
  exit 1
fi

OWNER_LOGIN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")
OWNER_TOKEN=$(echo "$OWNER_LOGIN" | jq -r '.accessToken // empty')

if [ -z "$OWNER_TOKEN" ]; then
  printf '%sSetup did not yield an owner token. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

CREATE_STAFF=$(curl -s -X POST "$BASE_URL/users" -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$STAFF_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Staff\",\"role\":\"staff\"}")
if [ "$(echo "$CREATE_STAFF" | jq -r '.user.id // empty')" = "" ]; then
  printf '%sSetup could not create staff. Aborting.%s\n' "$RED" "$RESET"
  echo "$CREATE_STAFF"
  exit 1
fi

STAFF_LOGIN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$STAFF_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")
STAFF_TOKEN=$(echo "$STAFF_LOGIN" | jq -r '.accessToken // empty')

SIGNUP_B_STATUS=$(curl -s -o "$WORK_DIR/signup-b.json" -w '%{http_code}' -X POST "$BASE_URL/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Pricing Co B\",\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner B\"}")
if [ "$SIGNUP_B_STATUS" != "201" ]; then
  printf '%sSetup signup (tenant B) failed (status %s):%s\n' "$RED" "$SIGNUP_B_STATUS" "$RESET"
  cat "$WORK_DIR/signup-b.json"; echo
  exit 1
fi
OWNER_B_LOGIN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")
OWNER_B_TOKEN=$(echo "$OWNER_B_LOGIN" | jq -r '.accessToken // empty')

if [ -z "$STAFF_TOKEN" ] || [ -z "$OWNER_B_TOKEN" ]; then
  printf '%sSetup did not yield all required tokens. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi
echo "Setup: tenant A (owner + staff) and tenant B (owner) signed up and logged in"
echo

echo "Checks"
echo "------"

# ─── Step 1: staff cannot write ───
STAFF_WRITE_STATUS=$(curl -s -o "$WORK_DIR/staff-write.json" -w '%{http_code}' -X POST "$BASE_URL/pricing/rules" \
  -H "Authorization: Bearer $STAFF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"rule_type\":\"LOCAL_PACKAGE\",\"vehicle_type\":\"SEDAN\",\"label\":\"Staff Attempt\",\"base_hours\":8,\"base_km\":80,\"base_price_rupees\":2200,\"extra_km_rate_rupees\":14,\"extra_hr_rate_rupees\":180,\"effective_from\":\"$PAST_DATE\"}")
STAFF_WRITE_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/staff-write.json")
STAFF_WRITE_REQUIRED=$(jq -r '.error.details.required // empty' "$WORK_DIR/staff-write.json")

STEP1_REASONS=()
[ "$STAFF_WRITE_STATUS" = "403" ] || STEP1_REASONS+=("expected status 403, got '$STAFF_WRITE_STATUS'")
[ "$STAFF_WRITE_CODE" = "FORBIDDEN" ] || STEP1_REASONS+=("expected code FORBIDDEN, got '$STAFF_WRITE_CODE'")
[ "$STAFF_WRITE_REQUIRED" = "pricing:write" ] || STEP1_REASONS+=("expected details.required 'pricing:write', got '$STAFF_WRITE_REQUIRED'")

if [ ${#STEP1_REASONS[@]} -eq 0 ]; then
  pass "Staff cannot create pricing rules: 403 FORBIDDEN, details.required = pricing:write"
else
  fail "Staff cannot create pricing rules: 403 FORBIDDEN, details.required = pricing:write" "$(IFS='; '; echo "${STEP1_REASONS[*]}")"
fi

# ─── Step 2: create LOCAL rule ───
CREATE1_STATUS=$(curl -s -o "$WORK_DIR/create1.json" -w '%{http_code}' -X POST "$BASE_URL/pricing/rules" \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"rule_type\":\"LOCAL_PACKAGE\",\"vehicle_type\":\"SEDAN\",\"label\":\"SEDAN 8H/80KM\",\"base_hours\":8,\"base_km\":80,\"base_price_rupees\":2200,\"extra_km_rate_rupees\":14,\"extra_hr_rate_rupees\":180,\"effective_from\":\"$PAST_DATE\"}")
RULE_ID_LOCAL_V1=$(jq -r '.rule.id // empty' "$WORK_DIR/create1.json")
C1_BASE_PRICE=$(jq -r '.rule.base_price_paise // empty' "$WORK_DIR/create1.json")

if [ "$CREATE1_STATUS" = "201" ] && [ "$C1_BASE_PRICE" = "220000" ]; then
  pass "Create LOCAL_PACKAGE rule: 201, base_price_paise = 220000"
else
  fail "Create LOCAL_PACKAGE rule: 201, base_price_paise = 220000" "status '$CREATE1_STATUS', base_price_paise '$C1_BASE_PRICE'"
fi
[ -n "$RULE_ID_LOCAL_V1" ] || RULE_ID_LOCAL_V1="00000000-0000-0000-0000-000000000000"

# ─── Step 3: reject overlapping LOCAL rule ───
OVERLAP_STATUS=$(curl -s -o "$WORK_DIR/overlap.json" -w '%{http_code}' -X POST "$BASE_URL/pricing/rules" \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"rule_type\":\"LOCAL_PACKAGE\",\"vehicle_type\":\"SEDAN\",\"label\":\"Overlap Attempt\",\"base_hours\":8,\"base_km\":80,\"base_price_rupees\":2200,\"extra_km_rate_rupees\":14,\"extra_hr_rate_rupees\":180,\"effective_from\":\"$TODAY\"}")
OVERLAP_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/overlap.json")

if [ "$OVERLAP_STATUS" = "409" ] && [ "$OVERLAP_CODE" = "PRICING_RULE_OVERLAP" ]; then
  pass "Reject overlapping LOCAL rule (same vehicle_type+rule_type, overlapping range): 409 PRICING_RULE_OVERLAP"
else
  fail "Reject overlapping LOCAL rule (same vehicle_type+rule_type, overlapping range): 409 PRICING_RULE_OVERLAP" "status '$OVERLAP_STATUS', code '$OVERLAP_CODE'"
fi

# ─── Step 4: missing LOCAL fields ───
MISSING_LOCAL_STATUS=$(curl -s -o "$WORK_DIR/missing-local.json" -w '%{http_code}' -X POST "$BASE_URL/pricing/rules" \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"rule_type\":\"LOCAL_PACKAGE\",\"vehicle_type\":\"SUV\",\"label\":\"SUV Local\",\"effective_from\":\"$PAST_DATE\"}")
MISSING_LOCAL_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/missing-local.json")
MISSING_LOCAL_FIELDS=$(jq -r '.error.details.missing_fields // [] | join(",")' "$WORK_DIR/missing-local.json")

STEP4_REASONS=()
[ "$MISSING_LOCAL_STATUS" = "400" ] || STEP4_REASONS+=("expected status 400, got '$MISSING_LOCAL_STATUS'")
[ "$MISSING_LOCAL_CODE" = "LOCAL_FIELDS_MISSING" ] || STEP4_REASONS+=("expected code LOCAL_FIELDS_MISSING, got '$MISSING_LOCAL_CODE'")
for f in base_hours base_km base_price_paise; do
  echo "$MISSING_LOCAL_FIELDS" | grep -q "$f" || STEP4_REASONS+=("missing_fields should include '$f' (got '$MISSING_LOCAL_FIELDS')")
done

if [ ${#STEP4_REASONS[@]} -eq 0 ]; then
  pass "Missing LOCAL fields: 400 LOCAL_FIELDS_MISSING with missing_fields listing base_hours/base_km/base_price_paise/..."
else
  fail "Missing LOCAL fields: 400 LOCAL_FIELDS_MISSING with missing_fields listing base_hours/base_km/base_price_paise/..." "$(IFS='; '; echo "${STEP4_REASONS[*]}")"
fi

# ─── Step 5: create OUTSTATION rule ───
CREATE5_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/pricing/rules" \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"rule_type\":\"OUTSTATION_SLAB\",\"vehicle_type\":\"KIA_CARNIVAL\",\"label\":\"Carnival Outstation\",\"slab_rate_rupees\":50,\"min_km_per_day\":250,\"driver_batta_per_day_rupees\":960,\"effective_from\":\"$PAST_DATE\"}")

if [ "$CREATE5_STATUS" = "201" ]; then
  pass "Create OUTSTATION_SLAB rule: 201"
else
  fail "Create OUTSTATION_SLAB rule: 201" "expected 201, got '$CREATE5_STATUS'"
fi

# ─── Step 6: create PERFORMANCE rule ───
CREATE6_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/pricing/rules" \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"rule_type\":\"PERFORMANCE\",\"vehicle_type\":\"SEDAN\",\"label\":\"SEDAN Perf\",\"per_km_rate_rupees\":14,\"performance_batta_rupees\":300,\"effective_from\":\"$PAST_DATE\"}")

if [ "$CREATE6_STATUS" = "201" ]; then
  pass "Create PERFORMANCE rule: 201"
else
  fail "Create PERFORMANCE rule: 201" "expected 201, got '$CREATE6_STATUS'"
fi

# ─── Step 7: list all rules ───
LIST1_TOTAL=$(curl -s "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_TOKEN" | jq -r '.pagination.total // -1')

if [ "$LIST1_TOTAL" -ge 3 ] 2>/dev/null; then
  pass "List pricing rules, no filters: total >= 3 (got $LIST1_TOTAL)"
else
  fail "List pricing rules, no filters: total >= 3" "got total '$LIST1_TOTAL'"
fi

# ─── Step 8: list filtered by type ───
LIST2_TOTAL=$(curl -s "$BASE_URL/pricing/rules?rule_type=LOCAL_PACKAGE" -H "Authorization: Bearer $OWNER_TOKEN" | jq -r '.pagination.total // -1')

if [ "$LIST2_TOTAL" = "1" ]; then
  pass "List pricing rules, rule_type=LOCAL_PACKAGE filter: total 1"
else
  fail "List pricing rules, rule_type=LOCAL_PACKAGE filter: total 1" "got total '$LIST2_TOTAL'"
fi

# ─── Step 9: applicable-rule lookup — hit ───
HIT_STATUS=$(curl -s -o "$WORK_DIR/hit.json" -w '%{http_code}' "$BASE_URL/pricing/rules/applicable?rule_type=LOCAL_PACKAGE&vehicle_type=SEDAN&on_date=$TODAY" \
  -H "Authorization: Bearer $OWNER_TOKEN")
HIT_ID=$(jq -r '.rule.id // empty' "$WORK_DIR/hit.json")

if [ "$HIT_STATUS" = "200" ] && [ "$HIT_ID" = "$RULE_ID_LOCAL_V1" ]; then
  pass "Applicable-rule lookup (hit): 200, returns the LOCAL rule just created"
else
  fail "Applicable-rule lookup (hit): 200, returns the LOCAL rule just created" "status '$HIT_STATUS', id '$HIT_ID' (expected '$RULE_ID_LOCAL_V1')"
fi

# ─── Step 10: applicable-rule lookup — miss (date before) ───
MISS1_STATUS=$(curl -s -o "$WORK_DIR/miss1.json" -w '%{http_code}' "$BASE_URL/pricing/rules/applicable?rule_type=LOCAL_PACKAGE&vehicle_type=SEDAN&on_date=$WAY_PAST_DATE" \
  -H "Authorization: Bearer $OWNER_TOKEN")
MISS1_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/miss1.json")

if [ "$MISS1_STATUS" = "404" ] && [ "$MISS1_CODE" = "NO_APPLICABLE_RULE" ]; then
  pass "Applicable-rule lookup (miss, date before effective_from): 404 NO_APPLICABLE_RULE"
else
  fail "Applicable-rule lookup (miss, date before effective_from): 404 NO_APPLICABLE_RULE" "status '$MISS1_STATUS', code '$MISS1_CODE'"
fi

# ─── Step 11: applicable-rule lookup — miss (vehicle type) ───
MISS2_STATUS=$(curl -s -o "$WORK_DIR/miss2.json" -w '%{http_code}' "$BASE_URL/pricing/rules/applicable?rule_type=LOCAL_PACKAGE&vehicle_type=BUS_50_SEATER&on_date=$TODAY" \
  -H "Authorization: Bearer $OWNER_TOKEN")
MISS2_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/miss2.json")

if [ "$MISS2_STATUS" = "404" ] && [ "$MISS2_CODE" = "NO_APPLICABLE_RULE" ]; then
  pass "Applicable-rule lookup (miss, no rule for this vehicle_type): 404 NO_APPLICABLE_RULE"
else
  fail "Applicable-rule lookup (miss, no rule for this vehicle_type): 404 NO_APPLICABLE_RULE" "status '$MISS2_STATUS', code '$MISS2_CODE'"
fi

# ─── Step 12: PATCH allowed fields ───
PATCH1_STATUS=$(curl -s -o "$WORK_DIR/patch1.json" -w '%{http_code}' -X PATCH "$BASE_URL/pricing/rules/$RULE_ID_LOCAL_V1" \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"label":"SEDAN 8H/80KM (Q1-26)","notes":"init rates"}')

if [ "$PATCH1_STATUS" = "200" ]; then
  pass "PATCH allowed fields (label, notes): 200"
else
  fail "PATCH allowed fields (label, notes): 200" "expected 200, got '$PATCH1_STATUS'"
fi

# ─── Step 13: PATCH forbidden field is rejected ───
PATCH2_STATUS=$(curl -s -o "$WORK_DIR/patch2.json" -w '%{http_code}' -X PATCH "$BASE_URL/pricing/rules/$RULE_ID_LOCAL_V1" \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"base_price_rupees":9999}')
PATCH2_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/patch2.json")

if [ "$PATCH2_STATUS" = "400" ] && [ "$PATCH2_CODE" = "VALIDATION_ERROR" ]; then
  pass "PATCH rate field (base_price_rupees) rejected: 400 VALIDATION_ERROR"
else
  fail "PATCH rate field (base_price_rupees) rejected: 400 VALIDATION_ERROR" "status '$PATCH2_STATUS', code '$PATCH2_CODE'"
fi

# ─── Step 14: supersede LOCAL rule ───
SUPERSEDE_STATUS=$(curl -s -o "$WORK_DIR/supersede.json" -w '%{http_code}' -X POST "$BASE_URL/pricing/rules/$RULE_ID_LOCAL_V1/supersede" \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"label\":\"SEDAN 8H/80KM (Q2-26 hike)\",\"base_hours\":8,\"base_km\":80,\"base_price_rupees\":2500,\"extra_km_rate_rupees\":15,\"extra_hr_rate_rupees\":200,\"effective_from\":\"$TODAY\"}")
SUPERSEDED_TO=$(jq -r '.superseded.effective_to // empty' "$WORK_DIR/supersede.json")
NEW_RULE_ID=$(jq -r '.new_rule.id // empty' "$WORK_DIR/supersede.json")
NEW_RULE_FROM=$(jq -r '.new_rule.effective_from // empty' "$WORK_DIR/supersede.json")
NEW_RULE_TO=$(jq -r '.new_rule.effective_to' "$WORK_DIR/supersede.json")

STEP14_REASONS=()
[ "$SUPERSEDE_STATUS" = "200" ] || STEP14_REASONS+=("expected status 200, got '$SUPERSEDE_STATUS'")
[ "$SUPERSEDED_TO" = "$TODAY" ] || STEP14_REASONS+=("expected superseded.effective_to '$TODAY', got '$SUPERSEDED_TO'")
[ "$NEW_RULE_FROM" = "$TODAY" ] || STEP14_REASONS+=("expected new_rule.effective_from '$TODAY', got '$NEW_RULE_FROM'")
[ "$NEW_RULE_TO" = "null" ] || STEP14_REASONS+=("expected new_rule.effective_to null, got '$NEW_RULE_TO'")

if [ ${#STEP14_REASONS[@]} -eq 0 ]; then
  pass "Supersede LOCAL rule: 200, old rule closes exactly at new rule's effective_from, new rule is open-ended"
else
  fail "Supersede LOCAL rule: 200, old rule closes exactly at new rule's effective_from, new rule is open-ended" "$(IFS='; '; echo "${STEP14_REASONS[*]}")"
fi
[ -n "$NEW_RULE_ID" ] || NEW_RULE_ID="00000000-0000-0000-0000-000000000000"

# ─── Step 15: applicable-rule lookup — pre-hike date returns V1 ───
PREHIKE_PRICE=$(curl -s "$BASE_URL/pricing/rules/applicable?rule_type=LOCAL_PACKAGE&vehicle_type=SEDAN&on_date=$YESTERDAY" \
  -H "Authorization: Bearer $OWNER_TOKEN" | jq -r '.rule.base_price_paise // empty')

if [ "$PREHIKE_PRICE" = "220000" ]; then
  pass "Applicable-rule lookup, pre-hike date ($YESTERDAY): returns V1 (base_price_paise 220000)"
else
  fail "Applicable-rule lookup, pre-hike date ($YESTERDAY): returns V1 (base_price_paise 220000)" "got base_price_paise '$PREHIKE_PRICE'"
fi

# ─── Step 16: applicable-rule lookup — post-hike date returns V2 ───
POSTHIKE_PRICE=$(curl -s "$BASE_URL/pricing/rules/applicable?rule_type=LOCAL_PACKAGE&vehicle_type=SEDAN&on_date=$TODAY" \
  -H "Authorization: Bearer $OWNER_TOKEN" | jq -r '.rule.base_price_paise // empty')

if [ "$POSTHIKE_PRICE" = "250000" ]; then
  pass "Applicable-rule lookup, post-hike date ($TODAY): returns V2 (base_price_paise 250000)"
else
  fail "Applicable-rule lookup, post-hike date ($TODAY): returns V2 (base_price_paise 250000)" "got base_price_paise '$POSTHIKE_PRICE'"
fi

# ─── Step 17: preview endpoint — Yellow UI numbers (pre-hike) ───
PREVIEW1=$(curl -s -X POST "$BASE_URL/pricing/preview" -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"rule_type\":\"LOCAL_PACKAGE\",\"vehicle_type\":\"SEDAN\",\"on_date\":\"$YESTERDAY\",\"usage\":{\"total_km\":217,\"total_hours\":12,\"toll_rupees\":0}}")
PREVIEW1_TOTAL=$(echo "$PREVIEW1" | jq -r '.result.total_paise // empty')
PREVIEW1_FORMATTED=$(echo "$PREVIEW1" | jq -r '.result.formatted.total_rupees // empty')

STEP17_REASONS=()
[ "$PREVIEW1_TOTAL" = "483800" ] || STEP17_REASONS+=("expected result.total_paise 483800, got '$PREVIEW1_TOTAL'")
[ "$PREVIEW1_FORMATTED" = "₹4,838.00" ] || STEP17_REASONS+=("expected result.formatted.total_rupees '₹4,838.00', got '$PREVIEW1_FORMATTED'")

if [ ${#STEP17_REASONS[@]} -eq 0 ]; then
  pass "Preview endpoint (pre-hike, Yellow UI reference): total_paise 483800, formatted.total_rupees ₹4,838.00"
else
  fail "Preview endpoint (pre-hike, Yellow UI reference): total_paise 483800, formatted.total_rupees ₹4,838.00" "$(IFS='; '; echo "${STEP17_REASONS[*]}")"
fi

# ─── Step 18: preview after hike returns different total ───
PREVIEW2_TOTAL=$(curl -s -X POST "$BASE_URL/pricing/preview" -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"rule_type\":\"LOCAL_PACKAGE\",\"vehicle_type\":\"SEDAN\",\"on_date\":\"$TODAY\",\"usage\":{\"total_km\":217,\"total_hours\":12,\"toll_rupees\":0}}" \
  | jq -r '.result.total_paise // empty')

if [ -n "$PREVIEW2_TOTAL" ] && [ "$PREVIEW2_TOTAL" != "483800" ]; then
  pass "Preview endpoint (post-hike): total_paise differs from pre-hike (got $PREVIEW2_TOTAL, uses V2 rates)"
else
  fail "Preview endpoint (post-hike): total_paise differs from pre-hike" "got '$PREVIEW2_TOTAL'"
fi

# ─── Step 19: cross-tenant leak test ───
LEAK_STATUS=$(curl -s -o "$WORK_DIR/leak.json" -w '%{http_code}' "$BASE_URL/pricing/rules/$RULE_ID_LOCAL_V1" \
  -H "Authorization: Bearer $OWNER_B_TOKEN")
LEAK_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/leak.json")

if [ "$LEAK_STATUS" = "404" ] && [ "$LEAK_CODE" = "PRICING_RULE_NOT_FOUND" ]; then
  pass "Cross-tenant GET /pricing/rules/{id} (tenant B reading tenant A's rule): 404 PRICING_RULE_NOT_FOUND"
else
  fail "Cross-tenant GET /pricing/rules/{id} (tenant B reading tenant A's rule): 404 PRICING_RULE_NOT_FOUND" "status '$LEAK_STATUS', code '$LEAK_CODE'"
fi

# ─── Step 20: DB-layer isolation check ───
DB_COUNT=$(psql -U "$DB_ROLE" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM pricing_rules;" 2>/dev/null | tr -d '[:space:]')

if [ "$DB_COUNT" = "0" ]; then
  pass "DB-layer isolation: direct psql as '$DB_ROLE' with no tenant context set sees 0 rows"
else
  fail "DB-layer isolation: direct psql as '$DB_ROLE' with no tenant context set sees 0 rows" "expected 0, got '$DB_COUNT'"
fi

# ─── SUMMARY ───
echo
printf '%s══════════════════════════════════════════════%s\n' "$YELLOW" "$RESET"
echo "VERIFICATION SUMMARY"
printf '%s══════════════════════════════════════════════%s\n' "$YELLOW" "$RESET"
echo "Passed: $PASS/$TOTAL_CHECKS"
echo "Failed: $FAIL/$TOTAL_CHECKS"
echo

if [ "$FAIL" -gt 0 ]; then
  echo "Failed steps:"
  for step in "${FAILED_STEPS[@]}"; do
    printf '  %s✗ %s%s\n' "$RED" "$step" "$RESET"
  done
  echo
  echo "Owner: $OWNER_EMAIL"
  echo "Staff: $STAFF_EMAIL"
  echo "Owner B: $OWNER_B_EMAIL"
  exit 1
else
  printf '%s✓ All %s checks passed. Pricing rules engine is working correctly.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
  echo
  echo "Owner: $OWNER_EMAIL"
  echo "Staff: $STAFF_EMAIL"
  echo "Owner B: $OWNER_B_EMAIL"
  exit 0
fi
