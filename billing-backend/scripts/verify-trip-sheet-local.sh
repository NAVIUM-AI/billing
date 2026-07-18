#!/usr/bin/env bash
#
# End-to-end verification of the Task 3.1 trip-sheet module: LOCAL/GST
# and LOCAL/PERFORMANCE trip creation via the Module 2 pricing engine,
# FY-based trip-sheet numbering (concurrency-safe sequence allocation),
# rule/vehicle/customer snapshotting (immutable even after the source
# rule is superseded), RBAC, and cross-tenant + DB-layer isolation.
# Step 4 originally asserted the OUTSTATION path returned its Task-3.1
# 501 stub; Task 3.2 replaced that stub with a real implementation, so
# Step 4 now just asserts OUTSTATION is reachable and produces a real
# pricing decision — full outstation coverage (Cauvery/Niriksha
# reference reproductions, itemized tolls, etc.) lives in
# scripts/verify-trip-sheet-outstation.sh. Mirrors
# scripts/verify-pricing.sh / verify-customers.sh (Tasks 2.1-2.6).
# Prints a PASS/FAIL summary and exits 1 if anything failed.
#
# Deliberately `set -u` but NOT `set -e`: we want every check to run
# even if an earlier one fails, so the summary reports everything
# that's broken in one pass instead of stopping at the first failure.
set -u

BASE_URL="http://localhost:8000/api/v1"
# Direct Homebrew Postgres (no Docker container), connected to as the
# dedicated non-superuser 'billing_app' role — see
# scripts/verify-tenant-isolation.sh for why. This deliberately does NOT
# use `docker exec billing-pg psql ...`; this project has no docker-pg
# container.
DB_NAME="${DB_NAME:-billing_dev}"
DB_ROLE="${DB_ROLE:-billing_app}"

TEST_PASSWORD="Passw0rd123"
OWNER_A_EMAIL="verify-trips-owner-a-$(date +%s)@example.com"
STAFF_A_EMAIL="verify-trips-staff-a-$(date +%s)-2@example.com"
VIEWER_A_EMAIL="verify-trips-viewer-a-$(date +%s)-3@example.com"
OWNER_B_EMAIL="verify-trips-owner-b-$(date +%s)-4@example.com"
# 'today' computed once, at run time — used for the supersede test's
# effective_from, which the pricingRule supersede schema requires to be
# today-or-later (see pricingRule.validator.js#supersedeSchema). Any
# fixed date hardcoded here would eventually be in the past.
TODAY=$(date +%Y-%m-%d)

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
TOTAL_CHECKS=14
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

# Runs a SQL string against $DB_NAME as $DB_ROLE with app.current_tenant_id
# set for the duration of the query — mirrors db.js#withTenantContext's
# SET LOCAL pattern, just from the psql side instead of the app side.
# Deliberately NOT wrapped in explicit BEGIN/COMMIT: Postgres already
# wraps a single multi-statement simple-query string (what -c sends) in
# an implicit transaction, so set_config's is_local=true scoping still
# applies across the statements that follow in the same -c string.
# Explicit BEGIN/COMMIT was tried first but rejected — psql's -t
# (tuples-only) suppresses column headers/footers for SELECT results,
# but NOT the command-completion tags ("BEGIN"/"COMMIT") that utility
# statements produce, so `tail -1` was picking up the literal string
# "COMMIT" instead of the query's actual last row.
query_as_tenant() {
  local tenant_id="$1"
  local sql="$2"
  psql -U "$DB_ROLE" -d "$DB_NAME" -tAc \
    "SELECT set_config('app.current_tenant_id', '$tenant_id', true); $sql" \
    2>/dev/null | tail -1
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
echo

# ─── SETUP ───
SIGNUP_A=$(curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Trips Co A\",\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner A\"}")
TENANT_A_ID=$(echo "$SIGNUP_A" | jq -r '.tenant.id // empty')
if [ -z "$TENANT_A_ID" ]; then
  printf '%sSetup signup (tenant A) failed:%s\n' "$RED" "$RESET"
  echo "$SIGNUP_A"
  exit 1
fi

OWNER_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
if [ -z "$OWNER_A_TOKEN" ]; then
  printf '%sSetup did not yield an owner A token. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

curl -s -X PATCH "$BASE_URL/settings/business" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H "Content-Type: application/json" -d '{"state_code":"KA","trip_sheet_prefix":"TS"}' > /dev/null

CREATE_STAFF=$(curl -s -X POST "$BASE_URL/users" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$STAFF_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Staff A\",\"role\":\"staff\"}")
if [ "$(echo "$CREATE_STAFF" | jq -r '.user.id // empty')" = "" ]; then
  printf '%sSetup could not create staff A. Aborting.%s\n' "$RED" "$RESET"
  echo "$CREATE_STAFF"
  exit 1
fi
STAFF_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$STAFF_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')

CREATE_VIEWER=$(curl -s -X POST "$BASE_URL/users" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$VIEWER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Viewer One\",\"role\":\"viewer\"}")
if [ "$(echo "$CREATE_VIEWER" | jq -r '.user.id // empty')" = "" ]; then
  printf '%sSetup could not create viewer A. Aborting.%s\n' "$RED" "$RESET"
  echo "$CREATE_VIEWER"
  exit 1
fi
VIEWER_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$VIEWER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')

SIGNUP_B=$(curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Trips Co B\",\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner B\"}")
if [ "$(echo "$SIGNUP_B" | jq -r '.tenant.id // empty')" = "" ]; then
  printf '%sSetup signup (tenant B) failed:%s\n' "$RED" "$RESET"
  echo "$SIGNUP_B"
  exit 1
fi
OWNER_B_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')

if [ -z "$STAFF_A_TOKEN" ] || [ -z "$VIEWER_A_TOKEN" ] || [ -z "$OWNER_B_TOKEN" ]; then
  printf '%sSetup did not yield all required tokens. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

VEH_SEDAN=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA51AK1031","vehicle_type":"SEDAN","seating_capacity":4}' | jq -r '.vehicle.id // empty')

CUST_B2C=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2C","name":"Ramesh Iyer","phone":"9876512345","state_code":"KA"}' | jq -r '.customer.id // empty')

CUST_B2B=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"Acme Logistics Pvt Ltd","gstin":"29ABCDE1234F1Z5","credit_days":30}' | jq -r '.customer.id // empty')

DRV=$(curl -s -X POST "$BASE_URL/drivers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"full_name":"Muralidhar N","phone":"9945692217"}' | jq -r '.driver.id // empty')

RULE_LOCAL=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"LOCAL_PACKAGE","vehicle_type":"SEDAN","label":"SEDAN 8H/80KM","base_hours":8,"base_km":80,"base_price_rupees":2200,"extra_km_rate_rupees":14,"extra_hr_rate_rupees":180,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')

curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"PERFORMANCE","vehicle_type":"SEDAN","label":"SEDAN Perf","per_km_rate_rupees":14,"performance_batta_rupees":300,"effective_from":"2026-01-01"}' > /dev/null

if [ -z "$VEH_SEDAN" ] || [ -z "$CUST_B2C" ] || [ -z "$CUST_B2B" ] || [ -z "$DRV" ] || [ -z "$RULE_LOCAL" ]; then
  printf '%sSetup did not yield all required fixtures. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

echo "Setup: tenant A (owner + staff + viewer, state_code=KA, trip_sheet_prefix=TS), tenant B (owner), SEDAN vehicle, B2C+B2B customers, driver, LOCAL_PACKAGE + PERFORMANCE rules"
echo

echo "Checks"
echo "------"

# ─── Step 1: LOCAL/GST trip (Yellow UI reference) ───
CREATE1_STATUS=$(curl -s -o "$WORK_DIR/trip1.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_B2B\",\"vehicle_id\":\"$VEH_SEDAN\",\"driver_id\":\"$DRV\",\"trip_date\":\"2026-06-01\",\"opening_km\":12000,\"closing_km\":12217,\"total_km\":217,\"total_hours\":12,\"toll_rupees\":0,\"booked_by\":\"Uma shankar\"}")
TRIP_1=$(jq -r '.trip.id // empty' "$WORK_DIR/trip1.json")
T1_NUMBER=$(jq -r '.trip.trip_sheet_number // empty' "$WORK_DIR/trip1.json")

STEP1_REASONS=()
[ "$CREATE1_STATUS" = "201" ] || STEP1_REASONS+=("expected status 201, got '$CREATE1_STATUS'")
echo "$T1_NUMBER" | grep -qE '^TS-[0-9]+/26-27$' || STEP1_REASONS+=("trip_sheet_number '$T1_NUMBER' does not match ^TS-\\d+/26-27\$")
[ "$(jq -r '.trip.service_type' "$WORK_DIR/trip1.json")" = "LOCAL" ] || STEP1_REASONS+=("service_type mismatch")
[ "$(jq -r '.trip.billing_mode' "$WORK_DIR/trip1.json")" = "GST" ] || STEP1_REASONS+=("billing_mode mismatch")
[ "$(jq -r '.trip.status' "$WORK_DIR/trip1.json")" = "DRAFT" ] || STEP1_REASONS+=("status mismatch")
[ "$(jq -r '.trip.snapshot_vehicle_number' "$WORK_DIR/trip1.json")" = "KA51AK1031" ] || STEP1_REASONS+=("snapshot_vehicle_number mismatch")
[ "$(jq -r '.trip.snapshot_customer_gstin' "$WORK_DIR/trip1.json")" = "29ABCDE1234F1Z5" ] || STEP1_REASONS+=("snapshot_customer_gstin mismatch")
[ "$(jq -r '.trip.snap_base_price_paise' "$WORK_DIR/trip1.json")" = "220000" ] || STEP1_REASONS+=("snap_base_price_paise mismatch")
[ "$(jq -r '.trip.snap_extra_km_rate_paise' "$WORK_DIR/trip1.json")" = "1400" ] || STEP1_REASONS+=("snap_extra_km_rate_paise mismatch")
[ "$(jq -r '.trip.snap_extra_hr_rate_paise' "$WORK_DIR/trip1.json")" = "18000" ] || STEP1_REASONS+=("snap_extra_hr_rate_paise mismatch")
[ "$(jq -r '.trip.base_amount_paise' "$WORK_DIR/trip1.json")" = "220000" ] || STEP1_REASONS+=("base_amount_paise mismatch")
[ "$(jq -r '.trip.extras_amount_paise' "$WORK_DIR/trip1.json")" = "263800" ] || STEP1_REASONS+=("extras_amount_paise mismatch")
[ "$(jq -r '.trip.subtotal_paise' "$WORK_DIR/trip1.json")" = "483800" ] || STEP1_REASONS+=("subtotal_paise mismatch")
[ "$(jq -r '.trip.gross_paise' "$WORK_DIR/trip1.json")" = "483800" ] || STEP1_REASONS+=("gross_paise mismatch")
[ "$(jq -r '.trip.net_payable_paise' "$WORK_DIR/trip1.json")" = "483800" ] || STEP1_REASONS+=("net_payable_paise mismatch")
[ "$(jq '.trip.breakdown | type' "$WORK_DIR/trip1.json")" = '"array"' ] || STEP1_REASONS+=("breakdown is not an array")

if [ ${#STEP1_REASONS[@]} -eq 0 ]; then
  pass "Create LOCAL/GST trip (Yellow UI ref): 201, number $T1_NUMBER, subtotal/gross/net = 483800 paise, snapshot correct"
else
  fail "Create LOCAL/GST trip (Yellow UI ref)" "$(IFS='; '; echo "${STEP1_REASONS[*]}")"
fi
[ -n "$TRIP_1" ] || TRIP_1="00000000-0000-4000-8000-000000000000"
T1_SEQ=$(echo "$T1_NUMBER" | sed -E 's#^TS-([0-9]+)/.*#\1#')

# ─── Step 2: second LOCAL/GST trip — sequence +1 ───
CREATE2_STATUS=$(curl -s -o "$WORK_DIR/trip2.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_B2B\",\"vehicle_id\":\"$VEH_SEDAN\",\"driver_id\":\"$DRV\",\"trip_date\":\"2026-06-02\",\"opening_km\":12217,\"closing_km\":12434,\"total_km\":217,\"total_hours\":12,\"toll_rupees\":0}")
T2_NUMBER=$(jq -r '.trip.trip_sheet_number // empty' "$WORK_DIR/trip2.json")
T2_SEQ=$(echo "$T2_NUMBER" | sed -E 's#^TS-([0-9]+)/.*#\1#')

STEP2_REASONS=()
[ "$CREATE2_STATUS" = "201" ] || STEP2_REASONS+=("expected status 201, got '$CREATE2_STATUS'")
[ "$T2_NUMBER" != "$T1_NUMBER" ] || STEP2_REASONS+=("trip_sheet_number did not change ('$T2_NUMBER')")
[ "$T2_SEQ" = "$((T1_SEQ + 1))" ] || STEP2_REASONS+=("expected seq $((T1_SEQ + 1)), got '$T2_SEQ' (first was '$T1_SEQ')")

if [ ${#STEP2_REASONS[@]} -eq 0 ]; then
  pass "Create second LOCAL/GST trip: 201, sequence advanced from $T1_SEQ to $T2_SEQ"
else
  fail "Create second LOCAL/GST trip: sequence +1" "$(IFS='; '; echo "${STEP2_REASONS[*]}")"
fi

# ─── Step 3: LOCAL/PERFORMANCE trip (Blue UI ref) ───
CREATE3_STATUS=$(curl -s -o "$WORK_DIR/trip3.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"PERFORMANCE\",\"customer_id\":\"$CUST_B2C\",\"vehicle_id\":\"$VEH_SEDAN\",\"trip_date\":\"2026-06-10\",\"total_km\":300,\"total_hours\":8,\"toll_rupees\":0}")

STEP3_REASONS=()
[ "$CREATE3_STATUS" = "201" ] || STEP3_REASONS+=("expected status 201, got '$CREATE3_STATUS'")
[ "$(jq -r '.trip.billing_mode' "$WORK_DIR/trip3.json")" = "PERFORMANCE" ] || STEP3_REASONS+=("billing_mode mismatch")
[ "$(jq -r '.trip.base_amount_paise' "$WORK_DIR/trip3.json")" = "420000" ] || STEP3_REASONS+=("base_amount_paise mismatch")
[ "$(jq -r '.trip.driver_batta_paise' "$WORK_DIR/trip3.json")" = "30000" ] || STEP3_REASONS+=("driver_batta_paise mismatch")
[ "$(jq -r '.trip.subtotal_paise' "$WORK_DIR/trip3.json")" = "450000" ] || STEP3_REASONS+=("subtotal_paise mismatch")
[ "$(jq -r '.trip.gross_paise' "$WORK_DIR/trip3.json")" = "450000" ] || STEP3_REASONS+=("gross_paise mismatch")

if [ ${#STEP3_REASONS[@]} -eq 0 ]; then
  pass "Create LOCAL/PERFORMANCE trip (Blue UI ref): 201, base 420000 + batta 30000 = subtotal/gross 450000 paise"
else
  fail "Create LOCAL/PERFORMANCE trip (Blue UI ref)" "$(IFS='; '; echo "${STEP3_REASONS[*]}")"
fi

# ─── Step 4: OUTSTATION trip creation is live (Task 3.2) ───
# Was "OUTSTATION -> 501 NOT_YET_IMPLEMENTED" through Task 3.1. Task 3.2
# replaced that stub with a real implementation (see
# scripts/verify-trip-sheet-outstation.sh for full outstation
# coverage), so this script's job shrinks to a regression check: the
# OUTSTATION code path is reachable and produces a real business
# decision, not the old stub. VEH_SEDAN has a LOCAL_PACKAGE rule (this
# script's setup) but no OUTSTATION_SLAB rule, so the correct outcome is
# NO_APPLICABLE_PRICING_RULE — proving the request reached real pricing
# logic instead of short-circuiting on service_type.
CREATE4_STATUS=$(curl -s -o "$WORK_DIR/trip4.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_B2B\",\"vehicle_id\":\"$VEH_SEDAN\",\"trip_date\":\"2026-06-20\",\"total_km\":1000,\"total_hours\":24,\"total_days\":3}")
CREATE4_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/trip4.json")
CREATE4_RTYPE=$(jq -r '.error.details.rule_type // empty' "$WORK_DIR/trip4.json")

if [ "$CREATE4_STATUS" = "400" ] && [ "$CREATE4_CODE" = "NO_APPLICABLE_PRICING_RULE" ] && [ "$CREATE4_RTYPE" = "OUTSTATION_SLAB" ]; then
  pass "OUTSTATION trip creation is live (Task 3.2): 400 NO_APPLICABLE_PRICING_RULE (no stub, no OUTSTATION_SLAB rule configured for SEDAN)"
else
  fail "OUTSTATION trip creation is live: 400 NO_APPLICABLE_PRICING_RULE" "status '$CREATE4_STATUS', code '$CREATE4_CODE', rule_type '$CREATE4_RTYPE'"
fi

# ─── Step 5: missing pricing rule -> clean 400 ───
VEH_SUV=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA02XX0001","vehicle_type":"SUV"}' | jq -r '.vehicle.id // empty')

CREATE5_STATUS=$(curl -s -o "$WORK_DIR/trip5.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_B2C\",\"vehicle_id\":\"$VEH_SUV\",\"trip_date\":\"2026-06-15\",\"total_km\":100,\"total_hours\":8}")
CREATE5_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/trip5.json")
CREATE5_VTYPE=$(jq -r '.error.details.vehicle_type // empty' "$WORK_DIR/trip5.json")

if [ "$CREATE5_STATUS" = "400" ] && [ "$CREATE5_CODE" = "NO_APPLICABLE_PRICING_RULE" ] && [ "$CREATE5_VTYPE" = "SUV" ]; then
  pass "Missing pricing rule (SUV, no rule configured): 400 NO_APPLICABLE_PRICING_RULE, details.vehicle_type = SUV"
else
  fail "Missing pricing rule: 400 NO_APPLICABLE_PRICING_RULE" "status '$CREATE5_STATUS', code '$CREATE5_CODE', vehicle_type '$CREATE5_VTYPE'"
fi

# ─── Step 6: invalid KM range ───
CREATE6_STATUS=$(curl -s -o "$WORK_DIR/trip6.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_B2C\",\"vehicle_id\":\"$VEH_SEDAN\",\"trip_date\":\"2026-06-16\",\"opening_km\":500,\"closing_km\":400,\"total_km\":100,\"total_hours\":8}")
CREATE6_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/trip6.json")

if [ "$CREATE6_STATUS" = "400" ] && [ "$CREATE6_CODE" = "INVALID_KM_RANGE" ]; then
  pass "Invalid KM range (closing < opening): 400 INVALID_KM_RANGE"
else
  fail "Invalid KM range: 400 INVALID_KM_RANGE" "status '$CREATE6_STATUS', code '$CREATE6_CODE'"
fi

# ─── Step 7: nonexistent customer -> 404 ───
# A well-formed v4 UUID that doesn't exist — NOT the all-zeros UUID a
# literal reading of the task spec might suggest, since an all-zeros
# UUID fails Joi's .guid({version:'uuidv4'}) format check before ever
# reaching the service layer (every entity-id field in this codebase is
# validated as uuidv4-only, matching what gen_random_uuid() actually
# produces — see tripSheet.validator.js). Using a real v4-shaped,
# nonexistent id is what actually exercises the CUSTOMER_NOT_FOUND path
# this step is meant to test.
CREATE7_STATUS=$(curl -s -o "$WORK_DIR/trip7.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"00000000-0000-4000-8000-000000000099\",\"vehicle_id\":\"$VEH_SEDAN\",\"trip_date\":\"2026-06-16\",\"total_km\":100,\"total_hours\":8}")
CREATE7_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/trip7.json")

if [ "$CREATE7_STATUS" = "404" ] && [ "$CREATE7_CODE" = "CUSTOMER_NOT_FOUND" ]; then
  pass "Nonexistent customer_id (well-formed v4 UUID): 404 CUSTOMER_NOT_FOUND"
else
  fail "Nonexistent customer_id: 404 CUSTOMER_NOT_FOUND" "status '$CREATE7_STATUS', code '$CREATE7_CODE'"
fi

# ─── Step 8: archived vehicle treated as not-found ───
curl -s -X POST "$BASE_URL/vehicles/$VEH_SEDAN/archive" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null

CREATE8_STATUS=$(curl -s -o "$WORK_DIR/trip8.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_B2C\",\"vehicle_id\":\"$VEH_SEDAN\",\"trip_date\":\"2026-06-17\",\"total_km\":100,\"total_hours\":8}")
CREATE8_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/trip8.json")

curl -s -X POST "$BASE_URL/vehicles/$VEH_SEDAN/unarchive" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null

if [ "$CREATE8_STATUS" = "404" ] && [ "$CREATE8_CODE" = "VEHICLE_NOT_FOUND" ]; then
  pass "Archived vehicle: 404 VEHICLE_NOT_FOUND (archived treated as not-found for trip creation); unarchived afterward"
else
  fail "Archived vehicle: 404 VEHICLE_NOT_FOUND" "status '$CREATE8_STATUS', code '$CREATE8_CODE'"
fi

# ─── Step 9: viewer cannot create ───
CREATE9_STATUS=$(curl -s -o "$WORK_DIR/trip9.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $VIEWER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_B2C\",\"vehicle_id\":\"$VEH_SEDAN\",\"trip_date\":\"2026-06-18\",\"total_km\":100,\"total_hours\":8}")
CREATE9_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/trip9.json")
CREATE9_REQUIRED=$(jq -r '.error.details.required // empty' "$WORK_DIR/trip9.json")

if [ "$CREATE9_STATUS" = "403" ] && [ "$CREATE9_CODE" = "FORBIDDEN" ] && [ "$CREATE9_REQUIRED" = "trips:write" ]; then
  pass "Viewer cannot create trip: 403 FORBIDDEN, details.required = trips:write"
else
  fail "Viewer cannot create trip: 403 FORBIDDEN" "status '$CREATE9_STATUS', code '$CREATE9_CODE', required '$CREATE9_REQUIRED'"
fi

# ─── Step 10: cross-tenant leak ───
LEAK_STATUS=$(curl -s -o "$WORK_DIR/leak.json" -w '%{http_code}' "$BASE_URL/trips/$TRIP_1" \
  -H "Authorization: Bearer $OWNER_B_TOKEN")
LEAK_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/leak.json")

if [ "$LEAK_STATUS" = "404" ] && [ "$LEAK_CODE" = "TRIP_NOT_FOUND" ]; then
  pass "Cross-tenant GET /trips/{id} (tenant B reading tenant A's trip): 404 TRIP_NOT_FOUND"
else
  fail "Cross-tenant GET /trips/{id}: 404 TRIP_NOT_FOUND" "status '$LEAK_STATUS', code '$LEAK_CODE'"
fi

# ─── Step 11: RLS blocks base reads with no tenant context ───
DB_COUNT_TRIPS=$(psql -U "$DB_ROLE" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM trip_sheets;" 2>/dev/null | tr -d '[:space:]')
DB_COUNT_SEQ=$(psql -U "$DB_ROLE" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM trip_sheet_sequences;" 2>/dev/null | tr -d '[:space:]')

if [ "$DB_COUNT_TRIPS" = "0" ] && [ "$DB_COUNT_SEQ" = "0" ]; then
  pass "DB-layer isolation: direct psql as '$DB_ROLE' with no tenant context set sees 0 rows in both trip_sheets and trip_sheet_sequences"
else
  fail "DB-layer isolation: 0 rows in both tables with no tenant context" "trip_sheets='$DB_COUNT_TRIPS', trip_sheet_sequences='$DB_COUNT_SEQ'"
fi

# ─── Step 12: sequence table state ───
SEQ_ROW=$(query_as_tenant "$TENANT_A_ID" "SELECT fiscal_year || ',' || next_seq FROM trip_sheet_sequences;")
SEQ_FY=$(echo "$SEQ_ROW" | cut -d',' -f1)
SEQ_NEXT=$(echo "$SEQ_ROW" | cut -d',' -f2)

if [ "$SEQ_FY" = "26-27" ] && [ "$SEQ_NEXT" -ge 4 ] 2>/dev/null; then
  pass "Sequence table: one row for tenant A, fiscal_year=26-27, next_seq=$SEQ_NEXT (>= 4, three successful trips so far)"
else
  fail "Sequence table: fiscal_year=26-27, next_seq >= 4" "got fiscal_year='$SEQ_FY', next_seq='$SEQ_NEXT'"
fi

# ─── Step 13: snapshot survives rule supersede ───
# supersedeSchema requires `label` (shared rateAndLabelFields, see
# pricingRule.validator.js) even though the task spec's own example
# body omits it — included here, or the call 400s VALIDATION_ERROR
# before ever reaching the supersede logic this step means to test.
curl -s -X POST "$BASE_URL/pricing/rules/$RULE_LOCAL/supersede" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"label\":\"SEDAN 8H/80KM (revised)\",\"base_hours\":8,\"base_km\":80,\"base_price_rupees\":2500,\"extra_km_rate_rupees\":15,\"extra_hr_rate_rupees\":200,\"effective_from\":\"$TODAY\"}" > "$WORK_DIR/supersede.json"
SUPERSEDE_NEW_ID=$(jq -r '.new_rule.id // empty' "$WORK_DIR/supersede.json")

REFETCH_TRIP1=$(curl -s "$BASE_URL/trips/$TRIP_1" -H "Authorization: Bearer $OWNER_A_TOKEN")

STEP13_REASONS=()
[ -n "$SUPERSEDE_NEW_ID" ] || STEP13_REASONS+=("supersede did not return a new_rule.id")
[ "$(echo "$REFETCH_TRIP1" | jq -r '.trip.snap_base_price_paise')" = "220000" ] || STEP13_REASONS+=("snap_base_price_paise changed after supersede")
[ "$(echo "$REFETCH_TRIP1" | jq -r '.trip.base_amount_paise')" = "220000" ] || STEP13_REASONS+=("base_amount_paise changed after supersede")
[ "$(echo "$REFETCH_TRIP1" | jq -r '.trip.subtotal_paise')" = "483800" ] || STEP13_REASONS+=("subtotal_paise changed after supersede")

if [ ${#STEP13_REASONS[@]} -eq 0 ]; then
  pass "Snapshot survives rule supersede: TRIP_1's rate fields unchanged (still 220000/483800) after RULE_LOCAL superseded"
else
  fail "Snapshot survives rule supersede" "$(IFS='; '; echo "${STEP13_REASONS[*]}")"
fi

# ─── Step 14: concurrent trip creation -> no collisions ───
# Deliberately NOT `(curl ... &)`: wrapping the backgrounded curl in its
# own subshell parens means `wait` (below) only waits for that subshell
# — which returns the instant it finishes launching the background job
# — not for the curl process itself. That raced against the DB read
# that follows, intermittently under-counting successes. Backgrounding
# curl directly (no extra subshell) makes each one a real job of THIS
# shell, so `wait` actually blocks until all five have finished.
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -X POST "$BASE_URL/trips" \
    -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
    -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_B2C\",\"vehicle_id\":\"$VEH_SEDAN\",\"trip_date\":\"2026-06-2$i\",\"total_km\":100,\"total_hours\":8}" &
done
wait

CONCURRENCY_ROW=$(query_as_tenant "$TENANT_A_ID" "SELECT COUNT(*) || ',' || COUNT(DISTINCT trip_sheet_number) FROM trip_sheets;")
CONC_TOTAL=$(echo "$CONCURRENCY_ROW" | cut -d',' -f1)
CONC_DISTINCT=$(echo "$CONCURRENCY_ROW" | cut -d',' -f2)

# Exactly 8, not just "total == distinct": 3 trips already existed
# (Steps 1-3) before these 5 concurrent creates. Asserting the exact
# count — not merely that whatever succeeded didn't collide — catches
# the case where some/all of the 5 silently failed, which would
# otherwise pass this check vacuously (0 new rows still have 0
# collisions).
if [ "$CONC_TOTAL" = "8" ] && [ "$CONC_TOTAL" = "$CONC_DISTINCT" ]; then
  pass "Concurrent trip creation (5 rapid-fire requests): all 5 succeeded, no trip_sheet_number collisions ($CONC_TOTAL total = $CONC_DISTINCT distinct)"
else
  fail "Concurrent trip creation: all 5 succeed with no collisions (expected total 8)" "total='$CONC_TOTAL', distinct='$CONC_DISTINCT'"
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
  echo "Tenant A owner: $OWNER_A_EMAIL"
  echo "Tenant A staff: $STAFF_A_EMAIL"
  echo "Tenant A viewer: $VIEWER_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 1
else
  printf '%s✓ All %s checks passed. Trip sheet module (Task 3.1) is working correctly.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
  echo
  echo "Tenant A owner: $OWNER_A_EMAIL"
  echo "Tenant A staff: $STAFF_A_EMAIL"
  echo "Tenant A viewer: $VIEWER_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 0
fi
