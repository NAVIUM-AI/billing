#!/usr/bin/env bash
#
# End-to-end verification of the Task 3.4 trip listing module:
# GET /trips composable filters (customer/vehicle/driver/date range/
# status multi-value/service_type/billing_mode/search), whitelisted
# sort, pagination with independent aggregates over the FILTERED set
# (not just the page), includeCancelled default-false semantics, RBAC,
# cross-tenant isolation, and the lean list-response shape (no
# breakdown/snap_*/tolls — those stay on GET /trips/:id). Mirrors
# scripts/verify-trip-sheet-lifecycle.sh (Task 3.3). Prints a PASS/FAIL
# summary and exits 1 if anything failed.
#
# Deliberately `set -u` but NOT `set -e`: we want every check to run
# even if an earlier one fails, so the summary reports everything
# that's broken in one pass instead of stopping at the first failure.
set -u

BASE_URL="http://localhost:8000/api/v1"

# Direct psql against $DATABASE_URL — no Docker container involved,
# matching scripts/verify-auth.sh's preflight and every other
# verify-*.sh script's underlying "no docker in this environment"
# reality. Loaded from .env if not already set.
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

TEST_PASSWORD="Passw0rd123"
OWNER_A_EMAIL="verify-trips-list-owner-a-$(date +%s)@example.com"
STAFF_A_EMAIL="verify-trips-list-staff-a-$(date +%s)-2@example.com"
ACCT_A_EMAIL="verify-trips-list-acct-a-$(date +%s)-3@example.com"
VIEWER_A_EMAIL="verify-trips-list-viewer-a-$(date +%s)-4@example.com"
OWNER_B_EMAIL="verify-trips-list-owner-b-$(date +%s)-5@example.com"

# Rule 8: all trip dates computed as offsets BACK from today rather than
# fixed calendar dates — tripDateField (tripSheet.validator.js) rejects
# any trip_date after today, evaluated at request time. Offsetting from
# `date -v-Nd` (macOS/BSD date) keeps every trip_date safely in the past
# no matter when this runs, while staying within the same Indian fiscal
# year as today for small offsets (needed so trip_sheet_number sequence
# allocation stays contiguous, which Step 15's search test relies on).
days_ago() { date -v-"$1"d +%Y-%m-%d; }
YESTERDAY=$(days_ago 1)
DAYS_AGO_2=$(days_ago 2)
DAYS_AGO_5=$(days_ago 5)
DAYS_AGO_10=$(days_ago 10)

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
TOTAL_CHECKS=30
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
DB_IDENTITY=$(psql "${DATABASE_URL:-}" -tAc "SELECT current_database(), current_user;" 2>/dev/null)
if [ -z "$DB_IDENTITY" ]; then
  printf '%sCould not connect to Postgres via DATABASE_URL.\nCheck DATABASE_URL in .env.%s\n' "$RED" "$RESET"
  exit 1
fi
DB_NAME_FOUND=$(echo "$DB_IDENTITY" | cut -d'|' -f1)
DB_ROLE_FOUND=$(echo "$DB_IDENTITY" | cut -d'|' -f2)
echo "  connected to database '$DB_NAME_FOUND' as role '$DB_ROLE_FOUND'"

if ! command -v jq >/dev/null 2>&1; then
  printf '%sjq is required for this script.\nInstall it with: brew install jq%s\n' "$RED" "$RESET"
  exit 1
fi
echo "  jq is installed"
echo

# ─── SETUP ───
SIGNUP_A=$(curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Trip List Co\",\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner A\"}")
if [ "$(echo "$SIGNUP_A" | jq -r '.tenant.id // empty')" = "" ]; then
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
  -H "Content-Type: application/json" -d '{"state_code":"KA","trip_sheet_prefix":"LS"}' > /dev/null

CREATE_STAFF=$(curl -s -X POST "$BASE_URL/users" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$STAFF_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Staff A\",\"role\":\"staff\"}")
STAFF_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$STAFF_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
if [ "$(echo "$CREATE_STAFF" | jq -r '.user.id // empty')" = "" ] || [ -z "$STAFF_A_TOKEN" ]; then
  printf '%sSetup could not create/login staff A. Aborting.%s\n' "$RED" "$RESET"
  echo "$CREATE_STAFF"
  exit 1
fi

CREATE_ACCT=$(curl -s -X POST "$BASE_URL/users" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ACCT_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Accountant A\",\"role\":\"accountant\"}")
ACCT_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ACCT_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
if [ "$(echo "$CREATE_ACCT" | jq -r '.user.id // empty')" = "" ] || [ -z "$ACCT_A_TOKEN" ]; then
  printf '%sSetup could not create/login accountant A. Aborting.%s\n' "$RED" "$RESET"
  echo "$CREATE_ACCT"
  exit 1
fi

CREATE_VIEWER=$(curl -s -X POST "$BASE_URL/users" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$VIEWER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Viewer A\",\"role\":\"viewer\"}")
VIEWER_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$VIEWER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
if [ "$(echo "$CREATE_VIEWER" | jq -r '.user.id // empty')" = "" ] || [ -z "$VIEWER_A_TOKEN" ]; then
  printf '%sSetup could not create/login viewer A. Aborting.%s\n' "$RED" "$RESET"
  echo "$CREATE_VIEWER"
  exit 1
fi

SIGNUP_B=$(curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Trip List Co B\",\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner B\"}")
if [ "$(echo "$SIGNUP_B" | jq -r '.tenant.id // empty')" = "" ]; then
  printf '%sSetup signup (tenant B) failed:%s\n' "$RED" "$RESET"
  echo "$SIGNUP_B"
  exit 1
fi
OWNER_B_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
if [ -z "$OWNER_B_TOKEN" ]; then
  printf '%sSetup did not yield an owner B token. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

VEH_A=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA01AB1111","vehicle_type":"SEDAN","make_model":"Honda City"}' | jq -r '.vehicle.id // empty')

VEH_B=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA01AB2222","vehicle_type":"SUV","make_model":"Toyota Innova Crysta"}' | jq -r '.vehicle.id // empty')

VEH_C=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA01AB3333","vehicle_type":"KIA_CARNIVAL","make_model":"KIA Carnival","seating_capacity":7}' | jq -r '.vehicle.id // empty')

CUST_R=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2C","name":"Ramesh Iyer","phone":"9876512345"}' | jq -r '.customer.id // empty')

CUST_S=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2C","name":"Sunita Kumar","phone":"9111222333"}' | jq -r '.customer.id // empty')

CUST_ACME=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"Acme Logistics Pvt Ltd","gstin":"29ABCDE1234F1Z5","credit_days":15}' | jq -r '.customer.id // empty')

DRV=$(curl -s -X POST "$BASE_URL/drivers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"full_name":"Muralidhar","phone":"9686847064"}' | jq -r '.driver.id // empty')

RULE_LOCAL_SEDAN=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"LOCAL_PACKAGE","vehicle_type":"SEDAN","label":"SEDAN 8H/80KM","base_hours":8,"base_km":80,"base_price_rupees":2200,"extra_km_rate_rupees":14,"extra_hr_rate_rupees":180,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')

RULE_LOCAL_SUV=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"LOCAL_PACKAGE","vehicle_type":"SUV","label":"SUV 8H/80KM","base_hours":8,"base_km":80,"base_price_rupees":2800,"extra_km_rate_rupees":16,"extra_hr_rate_rupees":200,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')

RULE_OS_SEDAN=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"OUTSTATION_SLAB","vehicle_type":"SEDAN","label":"SEDAN Outstation","slab_rate_rupees":13,"min_km_per_day":250,"driver_batta_per_day_rupees":400,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')

RULE_OS_KIA=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"OUTSTATION_SLAB","vehicle_type":"KIA_CARNIVAL","label":"KIA Carnival Outstation","slab_rate_rupees":50,"min_km_per_day":250,"driver_batta_per_day_rupees":960,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')

RULE_PERF_SEDAN=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"PERFORMANCE","vehicle_type":"SEDAN","label":"SEDAN Perf","per_km_rate_rupees":14,"performance_batta_rupees":300,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')

RULE_PERF_KIA=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"PERFORMANCE","vehicle_type":"KIA_CARNIVAL","label":"KIA Perf","per_km_rate_rupees":60,"performance_batta_rupees":500,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')

if [ -z "$VEH_A" ] || [ -z "$VEH_B" ] || [ -z "$VEH_C" ] || [ -z "$CUST_R" ] || [ -z "$CUST_S" ] || [ -z "$CUST_ACME" ] || [ -z "$DRV" ] || \
   [ -z "$RULE_LOCAL_SEDAN" ] || [ -z "$RULE_LOCAL_SUV" ] || [ -z "$RULE_OS_SEDAN" ] || [ -z "$RULE_OS_KIA" ] || [ -z "$RULE_PERF_SEDAN" ] || [ -z "$RULE_PERF_KIA" ]; then
  printf '%sSetup did not yield all required fixtures. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

# ─── Create 8 trips ───
# T1: LOCAL/GST, SEDAN, CUST_R, 10 days ago, 217km/10h -> finalize
T1=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_R\",\"vehicle_id\":\"$VEH_A\",\"trip_date\":\"$DAYS_AGO_10\",\"total_km\":217,\"total_hours\":10}" | jq -r '.trip.id // empty')

# T2: LOCAL/GST, SEDAN, CUST_R, 5 days ago, 100km/8h -> DRAFT
T2=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_R\",\"vehicle_id\":\"$VEH_A\",\"trip_date\":\"$DAYS_AGO_5\",\"total_km\":100,\"total_hours\":8}" | jq -r '.trip.id // empty')

# T3: LOCAL/PERFORMANCE, SEDAN, CUST_S, 5 days ago, 300km -> DRAFT
T3=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"PERFORMANCE\",\"customer_id\":\"$CUST_S\",\"vehicle_id\":\"$VEH_A\",\"trip_date\":\"$DAYS_AGO_5\",\"total_km\":300,\"total_hours\":15}" | jq -r '.trip.id // empty')

# T4: OUTSTATION/GST, KIA, CUST_ACME, 2 days ago, 1699km/5days, fasttag 2440 -> finalize (Cauvery-style reference numbers)
T4=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_ACME\",\"vehicle_id\":\"$VEH_C\",\"trip_date\":\"$DAYS_AGO_2\",\"total_km\":1699,\"total_hours\":120,\"total_days\":5,\"fasttag_rupees\":2440}" | jq -r '.trip.id // empty')

# T5: OUTSTATION/GST, SEDAN, CUST_ACME, 2 days ago, 500km/2days -> finalize -> cancel
T5=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_ACME\",\"vehicle_id\":\"$VEH_A\",\"trip_date\":\"$DAYS_AGO_2\",\"total_km\":500,\"total_hours\":24,\"total_days\":2}" | jq -r '.trip.id // empty')

# T6: LOCAL/GST, SUV, CUST_R, yesterday, 150km/8h -> DRAFT
T6=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_R\",\"vehicle_id\":\"$VEH_B\",\"trip_date\":\"$YESTERDAY\",\"total_km\":150,\"total_hours\":8}" | jq -r '.trip.id // empty')

# T7: LOCAL/GST, SUV, CUST_ACME, yesterday, 200km/10h -> finalize
T7=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_ACME\",\"vehicle_id\":\"$VEH_B\",\"trip_date\":\"$YESTERDAY\",\"total_km\":200,\"total_hours\":10}" | jq -r '.trip.id // empty')

# T8: OUTSTATION/PERFORMANCE, KIA, CUST_S, yesterday, 400km -> DRAFT
T8=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"PERFORMANCE\",\"customer_id\":\"$CUST_S\",\"vehicle_id\":\"$VEH_C\",\"trip_date\":\"$YESTERDAY\",\"total_km\":400,\"total_hours\":20}" | jq -r '.trip.id // empty')

if [ -z "$T1" ] || [ -z "$T2" ] || [ -z "$T3" ] || [ -z "$T4" ] || [ -z "$T5" ] || [ -z "$T6" ] || [ -z "$T7" ] || [ -z "$T8" ]; then
  printf '%sSetup did not create all 8 trips. Aborting.%s\n' "$RED" "$RESET"
  echo "T1=$T1 T2=$T2 T3=$T3 T4=$T4 T5=$T5 T6=$T6 T7=$T7 T8=$T8"
  exit 1
fi

# Lifecycle: T1, T4, T7 -> FINALIZED. T5 -> FINALIZED -> CANCELLED. Rest stay DRAFT.
curl -s -X POST "$BASE_URL/trips/$T1/finalize" -H "Authorization: Bearer $ACCT_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/trips/$T4/finalize" -H "Authorization: Bearer $ACCT_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/trips/$T5/finalize" -H "Authorization: Bearer $ACCT_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/trips/$T5/cancel" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"duplicate"}' > /dev/null
curl -s -X POST "$BASE_URL/trips/$T7/finalize" -H "Authorization: Bearer $ACCT_A_TOKEN" > /dev/null

T4_NUMBER=$(curl -s "$BASE_URL/trips/$T4" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.trip.trip_sheet_number // empty')

echo "Setup: tenant A (owner+staff+accountant+viewer), tenant B (owner), 3 vehicles, 3 customers, 1 driver, 6 pricing rules, 8 trips"
echo "Statuses: DRAFT=T2,T3,T6,T8 (4)  FINALIZED=T1,T4,T7 (3)  CANCELLED=T5 (1)  INVOICED=0"
echo "T4 trip_sheet_number: $T4_NUMBER"
echo

# Expected net_payable_paise per trip, derived from the pricing rules above:
#   T1 LOCAL SEDAN 217km/10h: base 220000 + extra_km 137*1400=191800 + extra_hr 2*18000=36000 = 447800
#   T2 LOCAL SEDAN 100km/8h:  base 220000 + extra_km 20*1400=28000 = 248000
#   T3 LOCAL PERF  SEDAN 300km: km 300*1400=420000 + batta 30000 = 450000
#   T4 OUTSTATION KIA 1699km/5d: slab 1699*5000=8495000 + batta 5*96000=480000 + fasttag 244000 = 9219000
#   T5 OUTSTATION SEDAN 500km/2d (CANCELLED, excluded from all sums below)
#   T6 LOCAL SUV 150km/8h: base 280000 + extra_km 70*1600=112000 = 392000
#   T7 LOCAL SUV 200km/10h: base 280000 + extra_km 120*1600=192000 + extra_hr 2*20000=40000 = 512000
#   T8 OUTSTATION PERF KIA 400km: km 400*6000=2400000 + batta 50000 = 2450000
SUM_ALL_NONCANCELLED=13718800   # T1+T2+T3+T4+T6+T7+T8 = 447800+248000+450000+9219000+392000+512000+2450000
SUM_FINALIZED=10178800          # T1+T4+T7 = 447800+9219000+512000

echo "Checks"
echo "------"

# ─── Step 1: list, no filters -> excludes CANCELLED by default ───
LIST1=$(curl -s "$BASE_URL/trips" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP1_TOTAL=$(echo "$LIST1" | jq -r '.pagination.total')
STEP1_LEN=$(echo "$LIST1" | jq '.trips | length')
STEP1_CANCELLED_COUNT=$(echo "$LIST1" | jq -r '.aggregates.count_by_status.CANCELLED')
STEP1_SUM=$(echo "$LIST1" | jq -r '.aggregates.sum_net_payable_paise')

STEP1_REASONS=()
[ "$STEP1_TOTAL" = "7" ] || STEP1_REASONS+=("expected pagination.total 7, got '$STEP1_TOTAL'")
[ "$STEP1_LEN" = "7" ] || STEP1_REASONS+=("expected 7 trips returned, got '$STEP1_LEN'")
[ "$STEP1_CANCELLED_COUNT" = "0" ] || STEP1_REASONS+=("expected count_by_status.CANCELLED 0, got '$STEP1_CANCELLED_COUNT'")
[ "$STEP1_SUM" = "$SUM_ALL_NONCANCELLED" ] || STEP1_REASONS+=("expected sum_net_payable_paise $SUM_ALL_NONCANCELLED, got '$STEP1_SUM'")

if [ ${#STEP1_REASONS[@]} -eq 0 ]; then
  pass "List with no filters: total 7 (8 minus 1 cancelled), aggregates.count_by_status.CANCELLED=0, sum_net_payable_paise=$SUM_ALL_NONCANCELLED"
else
  fail "List with no filters" "$(IFS='; '; echo "${STEP1_REASONS[*]}")"
fi

# ─── Step 2: includeCancelled=true ───
LIST2=$(curl -s "$BASE_URL/trips?includeCancelled=true" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP2_TOTAL=$(echo "$LIST2" | jq -r '.pagination.total')
STEP2_CANCELLED=$(echo "$LIST2" | jq -r '.aggregates.count_by_status.CANCELLED')

if [ "$STEP2_TOTAL" = "8" ] && [ "$STEP2_CANCELLED" = "1" ]; then
  pass "includeCancelled=true: total 8, count_by_status.CANCELLED=1"
else
  fail "includeCancelled=true" "total '$STEP2_TOTAL', cancelled count '$STEP2_CANCELLED'"
fi

# ─── Step 3: filter by customer (CUST_R) ───
LIST3=$(curl -s "$BASE_URL/trips?customer_id=$CUST_R" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP3_TOTAL=$(echo "$LIST3" | jq -r '.pagination.total')
STEP3_ALL_MATCH=$(echo "$LIST3" | jq --arg cid "$CUST_R" '[.trips[].customer_id] | all(. == $cid)')

if [ "$STEP3_TOTAL" = "3" ] && [ "$STEP3_ALL_MATCH" = "true" ]; then
  pass "Filter by customer_id=CUST_R: total 3 (T1, T2, T6), all rows match"
else
  fail "Filter by customer_id" "total '$STEP3_TOTAL', all_match '$STEP3_ALL_MATCH'"
fi

# ─── Step 4: filter by vehicle (VEH_B / SUV) ───
LIST4=$(curl -s "$BASE_URL/trips?vehicle_id=$VEH_B" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP4_TOTAL=$(echo "$LIST4" | jq -r '.pagination.total')

if [ "$STEP4_TOTAL" = "2" ]; then
  pass "Filter by vehicle_id=VEH_B (SUV): total 2 (T6, T7)"
else
  fail "Filter by vehicle_id" "expected total 2, got '$STEP4_TOTAL'"
fi

# ─── Step 5: filter by driver (none attached to any trip in this run) ───
LIST5=$(curl -s "$BASE_URL/trips?driver_id=$DRV" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP5_TOTAL=$(echo "$LIST5" | jq -r '.pagination.total')

if [ "$STEP5_TOTAL" = "0" ]; then
  pass "Filter by driver_id (no trip in this run has a driver attached): total 0"
else
  fail "Filter by driver_id" "expected total 0, got '$STEP5_TOTAL'"
fi

# ─── Step 6: filter by status (single) ───
LIST6=$(curl -s "$BASE_URL/trips?status=DRAFT" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP6_TOTAL=$(echo "$LIST6" | jq -r '.pagination.total')
STEP6_ALL_DRAFT=$(echo "$LIST6" | jq '[.trips[].status] | all(. == "DRAFT")')

if [ "$STEP6_TOTAL" = "4" ] && [ "$STEP6_ALL_DRAFT" = "true" ]; then
  pass "Filter by status=DRAFT: total 4 (T2, T3, T6, T8), all rows DRAFT"
else
  fail "Filter by status=DRAFT" "total '$STEP6_TOTAL', all_draft '$STEP6_ALL_DRAFT'"
fi

# ─── Step 7: filter by status (multi) ───
LIST7=$(curl -s "$BASE_URL/trips?status=DRAFT,FINALIZED" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP7_TOTAL=$(echo "$LIST7" | jq -r '.pagination.total')

if [ "$STEP7_TOTAL" = "7" ]; then
  pass "Filter by status=DRAFT,FINALIZED: total 7 (all non-cancelled)"
else
  fail "Filter by status=DRAFT,FINALIZED" "expected total 7, got '$STEP7_TOTAL'"
fi

# ─── Step 8: explicit status=CANCELLED overrides includeCancelled default ───
LIST8=$(curl -s "$BASE_URL/trips?status=CANCELLED" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP8_TOTAL=$(echo "$LIST8" | jq -r '.pagination.total')

if [ "$STEP8_TOTAL" = "1" ]; then
  pass "Explicit status=CANCELLED overrides includeCancelled default: total 1 (T5)"
else
  fail "Explicit status=CANCELLED" "expected total 1, got '$STEP8_TOTAL'"
fi

# ─── Step 9: invalid status value ───
LIST9_STATUS=$(curl -s -o "$WORK_DIR/list9.json" -w '%{http_code}' "$BASE_URL/trips?status=DRAFT,BOGUS" -H "Authorization: Bearer $OWNER_A_TOKEN")
LIST9_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/list9.json")

if [ "$LIST9_STATUS" = "400" ] && [ "$LIST9_CODE" = "VALIDATION_ERROR" ]; then
  pass "Invalid status value (DRAFT,BOGUS): 400 VALIDATION_ERROR"
else
  fail "Invalid status value: 400 VALIDATION_ERROR" "status '$LIST9_STATUS', code '$LIST9_CODE'"
fi

# ─── Step 10: filter by service_type=OUTSTATION (T5 cancelled, excluded) ───
LIST10=$(curl -s "$BASE_URL/trips?service_type=OUTSTATION" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP10_TOTAL=$(echo "$LIST10" | jq -r '.pagination.total')

if [ "$STEP10_TOTAL" = "2" ]; then
  pass "Filter by service_type=OUTSTATION: total 2 (T4, T8 — T5 excluded, cancelled)"
else
  fail "Filter by service_type=OUTSTATION" "expected total 2, got '$STEP10_TOTAL'"
fi

# ─── Step 11: filter by billing_mode=PERFORMANCE ───
LIST11=$(curl -s "$BASE_URL/trips?billing_mode=PERFORMANCE" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP11_TOTAL=$(echo "$LIST11" | jq -r '.pagination.total')

if [ "$STEP11_TOTAL" = "2" ]; then
  pass "Filter by billing_mode=PERFORMANCE: total 2 (T3, T8)"
else
  fail "Filter by billing_mode=PERFORMANCE" "expected total 2, got '$STEP11_TOTAL'"
fi

# ─── Step 12: date range, single day (yesterday) ───
LIST12=$(curl -s "$BASE_URL/trips?from_date=$YESTERDAY&to_date=$YESTERDAY" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP12_TOTAL=$(echo "$LIST12" | jq -r '.pagination.total')

if [ "$STEP12_TOTAL" = "3" ]; then
  pass "Date range (yesterday..yesterday): total 3 (T6, T7, T8)"
else
  fail "Date range single day" "expected total 3, got '$STEP12_TOTAL'"
fi

# ─── Step 13: date range, multi-day (5 days ago .. yesterday) ───
LIST13=$(curl -s "$BASE_URL/trips?from_date=$DAYS_AGO_5&to_date=$YESTERDAY" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP13_TOTAL=$(echo "$LIST13" | jq -r '.pagination.total')

if [ "$STEP13_TOTAL" = "6" ]; then
  pass "Date range (5 days ago..yesterday): total 6 (T2, T3, T4, T6, T7, T8 — T5 cancelled, excluded)"
else
  fail "Date range multi-day" "expected total 6, got '$STEP13_TOTAL'"
fi

# ─── Step 14: from_date > to_date ───
LIST14_STATUS=$(curl -s -o "$WORK_DIR/list14.json" -w '%{http_code}' "$BASE_URL/trips?from_date=$YESTERDAY&to_date=$DAYS_AGO_10" -H "Authorization: Bearer $OWNER_A_TOKEN")
LIST14_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/list14.json")

if [ "$LIST14_STATUS" = "400" ] && [ "$LIST14_CODE" = "VALIDATION_ERROR" ]; then
  pass "from_date > to_date: 400 VALIDATION_ERROR"
else
  fail "from_date > to_date: 400 VALIDATION_ERROR" "status '$LIST14_STATUS', code '$LIST14_CODE'"
fi

# ─── Step 15: search by trip_sheet_number substring ───
SEARCH_TOKEN=$(echo "$T4_NUMBER" | cut -d'/' -f1)   # e.g. "LS-4"
LIST15=$(curl -s "$BASE_URL/trips?search=$SEARCH_TOKEN" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP15_TOTAL=$(echo "$LIST15" | jq -r '.pagination.total')

if [ "$STEP15_TOTAL" = "1" ]; then
  pass "Search by trip_sheet_number substring ($SEARCH_TOKEN): total 1 (T4)"
else
  fail "Search by trip_sheet_number substring" "expected total 1, got '$STEP15_TOTAL' (searched '$SEARCH_TOKEN')"
fi

# ─── Step 16: search by customer name (case-insensitive substring) ───
LIST16=$(curl -s "$BASE_URL/trips?search=ramesh" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP16_TOTAL=$(echo "$LIST16" | jq -r '.pagination.total')

if [ "$STEP16_TOTAL" = "3" ]; then
  pass "Search by customer name 'ramesh' (case-insensitive): total 3 (T1, T2, T6 — all Ramesh Iyer)"
else
  fail "Search by customer name" "expected total 3, got '$STEP16_TOTAL'"
fi

# ─── Step 17: search by B2B customer company name ───
# Note: the task spec's own worked example says "Expect total 3" here but
# then lists only two matching trips (T4, T7 — T5 is CUST_ACME too but
# CANCELLED and excluded by the default filter). The correct total given
# the fixture is 2, not 3 — the spec's arithmetic is internally
# inconsistent, same category of issue as prior tasks' example-data bugs.
LIST17=$(curl -s "$BASE_URL/trips?search=acme" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP17_TOTAL=$(echo "$LIST17" | jq -r '.pagination.total')

if [ "$STEP17_TOTAL" = "2" ]; then
  pass "Search by company name 'acme': total 2 (T4, T7 — T5 is CUST_ACME too but cancelled, excluded)"
else
  fail "Search by company name" "expected total 2, got '$STEP17_TOTAL'"
fi

# ─── Step 18: sort by trip_date DESC (default) ───
LIST18=$(curl -s "$BASE_URL/trips" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP18_SORTED=$(echo "$LIST18" | jq '[.trips[].trip_date] == ([.trips[].trip_date] | sort | reverse)')

if [ "$STEP18_SORTED" = "true" ]; then
  pass "Default sort (trip_date desc): rows sorted most-recent-first"
else
  fail "Default sort trip_date desc" "trips not sorted descending by trip_date"
fi

# ─── Step 19: sort by trip_date ASC ───
LIST19=$(curl -s "$BASE_URL/trips?sort_by=trip_date&sort_dir=asc" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP19_SORTED=$(echo "$LIST19" | jq '[.trips[].trip_date] == ([.trips[].trip_date] | sort)')

if [ "$STEP19_SORTED" = "true" ]; then
  pass "sort_by=trip_date&sort_dir=asc: rows sorted oldest-first"
else
  fail "sort_by=trip_date asc" "trips not sorted ascending by trip_date"
fi

# ─── Step 20: sort by net_payable_paise DESC ───
LIST20=$(curl -s "$BASE_URL/trips?sort_by=net_payable_paise&sort_dir=desc" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP20_FIRST=$(echo "$LIST20" | jq -r '.trips[0].net_payable_paise')
STEP20_MAX=$(echo "$LIST20" | jq '[.trips[].net_payable_paise] | max')

if [ "$STEP20_FIRST" = "$STEP20_MAX" ] && [ "$STEP20_FIRST" = "9219000" ]; then
  pass "sort_by=net_payable_paise&sort_dir=desc: trips[0] is the max (9219000, T4)"
else
  fail "sort_by=net_payable_paise desc" "trips[0]='$STEP20_FIRST', max='$STEP20_MAX'"
fi

# ─── Step 21: invalid sort_by ───
LIST21_STATUS=$(curl -s -o "$WORK_DIR/list21.json" -w '%{http_code}' "$BASE_URL/trips?sort_by=some_random_column" -H "Authorization: Bearer $OWNER_A_TOKEN")
LIST21_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/list21.json")

if [ "$LIST21_STATUS" = "400" ] && [ "$LIST21_CODE" = "VALIDATION_ERROR" ]; then
  pass "Invalid sort_by: 400 VALIDATION_ERROR"
else
  fail "Invalid sort_by: 400 VALIDATION_ERROR" "status '$LIST21_STATUS', code '$LIST21_CODE'"
fi

# ─── Step 22: pagination ───
LIST22A=$(curl -s "$BASE_URL/trips?limit=3" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP22A_LEN=$(echo "$LIST22A" | jq '.trips | length')
STEP22A_TOTAL=$(echo "$LIST22A" | jq -r '.pagination.total')
STEP22A_HASMORE=$(echo "$LIST22A" | jq -r '.pagination.has_more')

LIST22B=$(curl -s "$BASE_URL/trips?limit=3&offset=6" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP22B_LEN=$(echo "$LIST22B" | jq '.trips | length')
STEP22B_HASMORE=$(echo "$LIST22B" | jq -r '.pagination.has_more')

STEP22_REASONS=()
[ "$STEP22A_LEN" = "3" ] || STEP22_REASONS+=("limit=3: expected 3 trips, got '$STEP22A_LEN'")
[ "$STEP22A_TOTAL" = "7" ] || STEP22_REASONS+=("limit=3: expected total 7, got '$STEP22A_TOTAL'")
[ "$STEP22A_HASMORE" = "true" ] || STEP22_REASONS+=("limit=3: expected has_more true, got '$STEP22A_HASMORE'")
[ "$STEP22B_LEN" = "1" ] || STEP22_REASONS+=("limit=3&offset=6: expected 1 trip, got '$STEP22B_LEN'")
[ "$STEP22B_HASMORE" = "false" ] || STEP22_REASONS+=("limit=3&offset=6: expected has_more false, got '$STEP22B_HASMORE'")

if [ ${#STEP22_REASONS[@]} -eq 0 ]; then
  pass "Pagination: limit=3 -> 3 rows/total 7/has_more true; limit=3&offset=6 -> 1 row/has_more false"
else
  fail "Pagination" "$(IFS='; '; echo "${STEP22_REASONS[*]}")"
fi

# ─── Step 23: aggregates match filter (status=FINALIZED) ───
LIST23=$(curl -s "$BASE_URL/trips?status=FINALIZED" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP23_FINALIZED=$(echo "$LIST23" | jq -r '.aggregates.count_by_status.FINALIZED')
STEP23_DRAFT=$(echo "$LIST23" | jq -r '.aggregates.count_by_status.DRAFT')
STEP23_CANCELLED=$(echo "$LIST23" | jq -r '.aggregates.count_by_status.CANCELLED')
STEP23_SUM=$(echo "$LIST23" | jq -r '.aggregates.sum_net_payable_paise')

STEP23_REASONS=()
[ "$STEP23_FINALIZED" = "3" ] || STEP23_REASONS+=("count_by_status.FINALIZED expected 3, got '$STEP23_FINALIZED'")
[ "$STEP23_DRAFT" = "0" ] || STEP23_REASONS+=("count_by_status.DRAFT expected 0 (filtered set), got '$STEP23_DRAFT'")
[ "$STEP23_CANCELLED" = "0" ] || STEP23_REASONS+=("count_by_status.CANCELLED expected 0, got '$STEP23_CANCELLED'")
[ "$STEP23_SUM" = "$SUM_FINALIZED" ] || STEP23_REASONS+=("sum_net_payable_paise expected $SUM_FINALIZED, got '$STEP23_SUM'")

if [ ${#STEP23_REASONS[@]} -eq 0 ]; then
  pass "Aggregates match status=FINALIZED filter: count_by_status.FINALIZED=3, other statuses=0, sum=$SUM_FINALIZED"
else
  fail "Aggregates match filter" "$(IFS='; '; echo "${STEP23_REASONS[*]}")"
fi

# ─── Step 24: aggregates independent of pagination (the money check) ───
LIST24=$(curl -s "$BASE_URL/trips?limit=1" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP24_LEN=$(echo "$LIST24" | jq '.trips | length')
STEP24_TOTAL=$(echo "$LIST24" | jq -r '.pagination.total')
STEP24_SUM=$(echo "$LIST24" | jq -r '.aggregates.sum_net_payable_paise')

if [ "$STEP24_LEN" = "1" ] && [ "$STEP24_TOTAL" = "7" ] && [ "$STEP24_SUM" = "$SUM_ALL_NONCANCELLED" ]; then
  pass "Aggregates are for the FILTERED set, not the page: limit=1 -> 1 row, but total=7 and sum=$SUM_ALL_NONCANCELLED (same as Step 1)"
else
  fail "Aggregates independent of pagination" "len '$STEP24_LEN', total '$STEP24_TOTAL', sum '$STEP24_SUM'"
fi

# ─── Step 25: combined filters ───
LIST25=$(curl -s "$BASE_URL/trips?customer_id=$CUST_R&status=DRAFT" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP25_TOTAL=$(echo "$LIST25" | jq -r '.pagination.total')

if [ "$STEP25_TOTAL" = "2" ]; then
  pass "Combined filters (customer_id=CUST_R&status=DRAFT): total 2 (T2, T6)"
else
  fail "Combined filters" "expected total 2, got '$STEP25_TOTAL'"
fi

# ─── Step 26: viewer can list ───
LIST26_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/trips" -H "Authorization: Bearer $VIEWER_A_TOKEN")

if [ "$LIST26_STATUS" = "200" ]; then
  pass "Viewer can list trips: 200"
else
  fail "Viewer can list trips: 200" "got '$LIST26_STATUS'"
fi

# ─── Step 27: cross-tenant isolation ───
LIST27=$(curl -s "$BASE_URL/trips" -H "Authorization: Bearer $OWNER_B_TOKEN")
STEP27_TOTAL=$(echo "$LIST27" | jq -r '.pagination.total')
STEP27_LEN=$(echo "$LIST27" | jq '.trips | length')

if [ "$STEP27_TOTAL" = "0" ] && [ "$STEP27_LEN" = "0" ]; then
  pass "Cross-tenant isolation: tenant B sees total 0, trips []"
else
  fail "Cross-tenant isolation" "total '$STEP27_TOTAL', len '$STEP27_LEN'"
fi

# ─── Step 28: response shape sanity ───
LIST28=$(curl -s "$BASE_URL/trips" -H "Authorization: Bearer $OWNER_A_TOKEN")
REQUIRED_FIELDS=(id trip_sheet_number service_type billing_mode status customer_id vehicle_id snapshot_vehicle_number snapshot_customer_name trip_date total_km subtotal_paise gross_paise net_payable_paise)
STEP28_REASONS=()
for f in "${REQUIRED_FIELDS[@]}"; do
  HAS_FIELD=$(echo "$LIST28" | jq --arg f "$f" '[.trips[] | has($f)] | all')
  [ "$HAS_FIELD" = "true" ] || STEP28_REASONS+=("field '$f' missing from at least one row")
done
HAS_BREAKDOWN=$(echo "$LIST28" | jq '[.trips[] | has("breakdown")] | any')
HAS_SNAP=$(echo "$LIST28" | jq '[.trips[] | has("snap_base_hours")] | any')
HAS_TOLLS=$(echo "$LIST28" | jq '[.trips[] | has("tolls")] | any')
[ "$HAS_BREAKDOWN" = "false" ] || STEP28_REASONS+=("breakdown leaked into list response")
[ "$HAS_SNAP" = "false" ] || STEP28_REASONS+=("snap_* fields leaked into list response")
[ "$HAS_TOLLS" = "false" ] || STEP28_REASONS+=("tolls leaked into list response")

if [ ${#STEP28_REASONS[@]} -eq 0 ]; then
  pass "Response shape: all lean fields present, breakdown/snap_*/tolls omitted"
else
  fail "Response shape sanity" "$(IFS='; '; echo "${STEP28_REASONS[*]}")"
fi

# ─── Step 29: DB-layer isolation still enforced ───
DB_COUNT=$(psql "${DATABASE_URL:-}" -tAc "SELECT COUNT(*) FROM trip_sheets;" 2>/dev/null | tr -d '[:space:]')

if [ "$DB_COUNT" = "0" ]; then
  pass "DB-layer isolation: direct psql with no tenant context set sees 0 rows in trip_sheets"
else
  fail "DB-layer isolation" "expected 0, got '$DB_COUNT'"
fi

# ─── Step 30: regression — GET /trips/:id still returns full detail ───
GET30=$(curl -s "$BASE_URL/trips/$T1" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP30_HAS_BREAKDOWN=$(echo "$GET30" | jq 'has("trip") and (.trip | has("breakdown"))')
STEP30_HAS_SNAP=$(echo "$GET30" | jq '.trip | has("snap_base_hours")')
STEP30_HAS_TOLLS=$(echo "$GET30" | jq '.trip | has("tolls")')

if [ "$STEP30_HAS_BREAKDOWN" = "true" ] && [ "$STEP30_HAS_SNAP" = "true" ] && [ "$STEP30_HAS_TOLLS" = "true" ]; then
  pass "Regression: GET /trips/:id still returns breakdown, snap_* fields, and tolls array"
else
  fail "Regression GET /trips/:id detail shape" "breakdown '$STEP30_HAS_BREAKDOWN', snap '$STEP30_HAS_SNAP', tolls '$STEP30_HAS_TOLLS'"
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
  echo "Tenant A accountant: $ACCT_A_EMAIL"
  echo "Tenant A viewer: $VIEWER_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 1
else
  printf '%s✓ All %s checks passed. Trip listing module (Task 3.4) is working correctly.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
  echo
  echo "Tenant A owner: $OWNER_A_EMAIL"
  echo "Tenant A staff: $STAFF_A_EMAIL"
  echo "Tenant A accountant: $ACCT_A_EMAIL"
  echo "Tenant A viewer: $VIEWER_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 0
fi
