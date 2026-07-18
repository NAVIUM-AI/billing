#!/usr/bin/env bash
#
# End-to-end verification of the Task 3.5 performance sheet module: the
# Blue UI projection over billing_mode='PERFORMANCE' trips, grouped by
# customer with subtotals and a grand total, plus RFC 4180 CSV export.
# No new tables, no new permissions — purely a read-only view over
# existing trip_sheets data. Mirrors scripts/verify-trip-sheet-list.sh
# (Task 3.4). Prints a PASS/FAIL summary and exits 1 if anything failed.
#
# Deliberately `set -u` but NOT `set -e`: we want every check to run
# even if an earlier one fails, so the summary reports everything
# that's broken in one pass instead of stopping at the first failure.
set -u

BASE_URL="http://localhost:8000/api/v1"

# Direct psql against $DATABASE_URL — matching every other verify-*.sh
# script's preflight since scripts/verify-auth.sh was modernized off
# Docker.
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

TEST_PASSWORD="Passw0rd123"
OWNER_A_EMAIL="verify-trips-perf-owner-a-$(date +%s)@example.com"
STAFF_A_EMAIL="verify-trips-perf-staff-a-$(date +%s)-2@example.com"
VIEWER_A_EMAIL="verify-trips-perf-viewer-a-$(date +%s)-3@example.com"
OWNER_B_EMAIL="verify-trips-perf-owner-b-$(date +%s)-4@example.com"

# Rule 8: all trip dates computed as offsets BACK from today.
days_ago() { date -v-"$1"d +%Y-%m-%d; }
YESTERDAY=$(days_ago 1)
DAYS_AGO_2=$(days_ago 2)
DAYS_AGO_3=$(days_ago 3)
DAYS_AGO_5=$(days_ago 5)

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
TOTAL_CHECKS=23
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
  -d "{\"businessName\":\"Verify Perf Sheet Co\",\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner A\"}")
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
  -H "Content-Type: application/json" -d '{"state_code":"KA","trip_sheet_prefix":"PS"}' > /dev/null

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
  -d "{\"businessName\":\"Verify Perf Sheet Co B\",\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner B\"}")
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

VEH_S=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA01PS1111","vehicle_type":"SEDAN","make_model":"Honda City"}' | jq -r '.vehicle.id // empty')

VEH_K=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA01PS2222","vehicle_type":"KIA_CARNIVAL","make_model":"KIA Carnival","seating_capacity":7}' | jq -r '.vehicle.id // empty')

CUST_R=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2C","name":"Ramesh Iyer","phone":"9876512345"}' | jq -r '.customer.id // empty')

CUST_S=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2C","name":"Sunita Kumar","phone":"9111222333"}' | jq -r '.customer.id // empty')

CUST_ACME=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"Acme Logistics Pvt Ltd","gstin":"29ABCDE1234F1Z5","credit_days":15}' | jq -r '.customer.id // empty')

RULE_PERF_SEDAN=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"PERFORMANCE","vehicle_type":"SEDAN","label":"SEDAN Perf","per_km_rate_rupees":14,"performance_batta_rupees":300,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')

RULE_PERF_KIA=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"PERFORMANCE","vehicle_type":"KIA_CARNIVAL","label":"KIA Perf","per_km_rate_rupees":60,"performance_batta_rupees":500,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')

RULE_LOCAL_SEDAN=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"LOCAL_PACKAGE","vehicle_type":"SEDAN","label":"SEDAN 8H/80KM","base_hours":8,"base_km":80,"base_price_rupees":2200,"extra_km_rate_rupees":14,"extra_hr_rate_rupees":180,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')

if [ -z "$VEH_S" ] || [ -z "$VEH_K" ] || [ -z "$CUST_R" ] || [ -z "$CUST_S" ] || [ -z "$CUST_ACME" ] || \
   [ -z "$RULE_PERF_SEDAN" ] || [ -z "$RULE_PERF_KIA" ] || [ -z "$RULE_LOCAL_SEDAN" ]; then
  printf '%sSetup did not yield all required fixtures. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

# ─── Create 7 PERFORMANCE trips + 1 GST trip ───
# T1: LOCAL/PERF, SEDAN, CUST_R, 5 days ago, 300km (Blue UI ref: 300*14+300 = 4500 rupees)
T1=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"PERFORMANCE\",\"customer_id\":\"$CUST_R\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$DAYS_AGO_5\",\"total_km\":300,\"total_hours\":15}" | jq -r '.trip.id // empty')

# T2: LOCAL/PERF, SEDAN, CUST_R, 3 days ago, 100km
T2=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"PERFORMANCE\",\"customer_id\":\"$CUST_R\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$DAYS_AGO_3\",\"total_km\":100,\"total_hours\":8}" | jq -r '.trip.id // empty')

# T3: LOCAL/PERF, SEDAN, CUST_S, 3 days ago, 200km
T3=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"PERFORMANCE\",\"customer_id\":\"$CUST_S\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$DAYS_AGO_3\",\"total_km\":200,\"total_hours\":10}" | jq -r '.trip.id // empty')

# T4: OUTSTATION/PERF, KIA, CUST_ACME, 2 days ago, 600km (Blue UI ref: 600*60+500 = 36500 rupees)
T4=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"PERFORMANCE\",\"customer_id\":\"$CUST_ACME\",\"vehicle_id\":\"$VEH_K\",\"trip_date\":\"$DAYS_AGO_2\",\"total_km\":600,\"total_hours\":30}" | jq -r '.trip.id // empty')

# T5: LOCAL/PERF, SEDAN, CUST_R, yesterday, 150km
T5=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"PERFORMANCE\",\"customer_id\":\"$CUST_R\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$YESTERDAY\",\"total_km\":150,\"total_hours\":8}" | jq -r '.trip.id // empty')

# T6: OUTSTATION/PERF, KIA, CUST_S, yesterday, 400km
T6=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"PERFORMANCE\",\"customer_id\":\"$CUST_S\",\"vehicle_id\":\"$VEH_K\",\"trip_date\":\"$YESTERDAY\",\"total_km\":400,\"total_hours\":20}" | jq -r '.trip.id // empty')

# T7: LOCAL/PERF, SEDAN, CUST_ACME, yesterday, 250km -> finalize -> cancel
T7=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"PERFORMANCE\",\"customer_id\":\"$CUST_ACME\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$YESTERDAY\",\"total_km\":250,\"total_hours\":10}" | jq -r '.trip.id // empty')

# T8: LOCAL/GST, SEDAN, CUST_R, yesterday, 100km/8h — NOT PERFORMANCE, must not appear in sheet
T8=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_R\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$YESTERDAY\",\"total_km\":100,\"total_hours\":8}" | jq -r '.trip.id // empty')

if [ -z "$T1" ] || [ -z "$T2" ] || [ -z "$T3" ] || [ -z "$T4" ] || [ -z "$T5" ] || [ -z "$T6" ] || [ -z "$T7" ] || [ -z "$T8" ]; then
  printf '%sSetup did not create all 8 trips. Aborting.%s\n' "$RED" "$RESET"
  echo "T1=$T1 T2=$T2 T3=$T3 T4=$T4 T5=$T5 T6=$T6 T7=$T7 T8=$T8"
  exit 1
fi

curl -s -X POST "$BASE_URL/trips/$T7/finalize" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/trips/$T7/cancel" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"duplicate entry"}' > /dev/null

echo "Setup: tenant A (owner+staff+viewer), tenant B (owner), SEDAN+KIA vehicles, 3 customers, 3 pricing rules (PERF x2, LOCAL_PACKAGE x1), 7 PERFORMANCE trips + 1 GST trip"
echo "PERFORMANCE trips by customer: CUST_R=T1,T2,T5 (3)  CUST_S=T3,T6 (2)  CUST_ACME=T4,T7-cancelled (1 active)"
echo

# Expected values, derived from the pricing rules above:
#   T1 SEDAN 300km: km 300*1400=420000 + batta 30000 = 450000 (₹4500, matches Blue UI ref)
#   T2 SEDAN 100km: km 100*1400=140000 + batta 30000 = 170000
#   T3 SEDAN 200km: km 200*1400=280000 + batta 30000 = 310000
#   T4 KIA   600km: km 600*6000=3600000 + batta 50000 = 3650000 (₹36500, matches Blue UI ref)
#   T5 SEDAN 150km: km 150*1400=210000 + batta 30000 = 240000
#   T6 KIA   400km: km 400*6000=2400000 + batta 50000 = 2450000
RAMESH_KM=550        # T1(300)+T2(100)+T5(150)
RAMESH_TOTAL=860000  # 450000+170000+240000
SUNITA_TOTAL=2760000 # T3(310000)+T6(2450000)
ACME_TOTAL=3650000   # T4 only (T7 cancelled, excluded by default)
GRAND_TOTAL=7270000  # 860000+2760000+3650000

echo "Checks"
echo "------"

# ─── Step 1: JSON default (excludes cancelled), grouped by customer ───
SHEET1=$(curl -s "$BASE_URL/trips/performance-sheet" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP1_ROWCOUNT=$(echo "$SHEET1" | jq -r '.grand_total.row_count')
STEP1_GROUPCOUNT=$(echo "$SHEET1" | jq -r '.grand_total.group_count')
STEP1_INCLUDE_CANCELLED=$(echo "$SHEET1" | jq -r '.filters_applied.include_cancelled')
STEP1_GROUPS_LEN=$(echo "$SHEET1" | jq '.groups | length')
STEP1_SHAPE_OK=$(echo "$SHEET1" | jq '[.groups[] | (has("customer_name") and has("customer_type") and has("rows") and has("subtotal"))] | all')
STEP1_SUBTOTAL_SUM=$(echo "$SHEET1" | jq '[.groups[].subtotal.total_paise] | add')
STEP1_GRANDTOTAL=$(echo "$SHEET1" | jq -r '.grand_total.total_paise')

STEP1_REASONS=()
[ "$STEP1_ROWCOUNT" = "6" ] || STEP1_REASONS+=("expected row_count 6, got '$STEP1_ROWCOUNT'")
[ "$STEP1_GROUPCOUNT" = "3" ] || STEP1_REASONS+=("expected group_count 3, got '$STEP1_GROUPCOUNT'")
[ "$STEP1_INCLUDE_CANCELLED" = "false" ] || STEP1_REASONS+=("expected filters_applied.include_cancelled false")
[ "$STEP1_GROUPS_LEN" = "3" ] || STEP1_REASONS+=("expected 3 groups, got '$STEP1_GROUPS_LEN'")
[ "$STEP1_SHAPE_OK" = "true" ] || STEP1_REASONS+=("a group is missing customer_name/customer_type/rows/subtotal")
[ "$STEP1_SUBTOTAL_SUM" = "$STEP1_GRANDTOTAL" ] || STEP1_REASONS+=("sum of group subtotals ($STEP1_SUBTOTAL_SUM) != grand_total.total_paise ($STEP1_GRANDTOTAL)")

if [ ${#STEP1_REASONS[@]} -eq 0 ]; then
  pass "JSON default: row_count=6, group_count=3, groups shaped correctly, subtotal sum reconciles with grand total ($STEP1_GRANDTOTAL)"
else
  fail "JSON default performance sheet" "$(IFS='; '; echo "${STEP1_REASONS[*]}")"
fi

# ─── Step 2: T8 (GST trip) is NOT in the result ───
STEP2_HAS_T8=$(echo "$SHEET1" | jq --arg id "$T8" '[.groups[].rows[].TRIP_ID] | any(. == $id)')

if [ "$STEP2_HAS_T8" = "false" ]; then
  pass "GST trip T8 excluded from performance sheet (billing_mode filter is fixed)"
else
  fail "GST trip T8 excluded" "T8 unexpectedly appeared in the performance sheet"
fi

# ─── Step 3: row shape matches Blue UI columns ───
SAMPLE_ROW=$(echo "$SHEET1" | jq --arg id "$T1" '[.groups[].rows[] | select(.TRIP_ID == $id)][0]')
REQUIRED_ROW_FIELDS=(SL DATE VEHICLE_TYPE VEHICLE_NUMBER TOTAL_RUNNING_KM PER_KM_COST_RUPEES PER_KM_COST_PAISE TOTAL_COST_RUPEES TOTAL_COST_PAISE BATA_RUPEES BATA_PAISE TOLL_CHARGES_RUPEES TOLL_CHARGES_PAISE GRAND_TOTAL_RUPEES GRAND_TOTAL_PAISE TRIP_ID STATUS)
STEP3_REASONS=()
for f in "${REQUIRED_ROW_FIELDS[@]}"; do
  HAS=$(echo "$SAMPLE_ROW" | jq --arg f "$f" 'has($f)')
  [ "$HAS" = "true" ] || STEP3_REASONS+=("row missing field '$f'")
done

if [ ${#STEP3_REASONS[@]} -eq 0 ]; then
  pass "Row shape matches Blue UI columns (all ${#REQUIRED_ROW_FIELDS[@]} fields present)"
else
  fail "Row shape" "$(IFS='; '; echo "${STEP3_REASONS[*]}")"
fi

# ─── Step 4: Blue UI reference row reproduces exactly (T1) ───
STEP4_REASONS=()
[ "$(echo "$SAMPLE_ROW" | jq -r '.TOTAL_RUNNING_KM')" = "300" ] || STEP4_REASONS+=("TOTAL_RUNNING_KM != 300")
[ "$(echo "$SAMPLE_ROW" | jq -r '.PER_KM_COST_PAISE')" = "1400" ] || STEP4_REASONS+=("PER_KM_COST_PAISE != 1400")
[ "$(echo "$SAMPLE_ROW" | jq -r '.PER_KM_COST_RUPEES')" = "14" ] || STEP4_REASONS+=("PER_KM_COST_RUPEES != 14")
[ "$(echo "$SAMPLE_ROW" | jq -r '.TOTAL_COST_PAISE')" = "420000" ] || STEP4_REASONS+=("TOTAL_COST_PAISE != 420000")
[ "$(echo "$SAMPLE_ROW" | jq -r '.TOTAL_COST_RUPEES')" = "4200" ] || STEP4_REASONS+=("TOTAL_COST_RUPEES != 4200")
[ "$(echo "$SAMPLE_ROW" | jq -r '.BATA_PAISE')" = "30000" ] || STEP4_REASONS+=("BATA_PAISE != 30000")
[ "$(echo "$SAMPLE_ROW" | jq -r '.BATA_RUPEES')" = "300" ] || STEP4_REASONS+=("BATA_RUPEES != 300")
[ "$(echo "$SAMPLE_ROW" | jq -r '.GRAND_TOTAL_PAISE')" = "450000" ] || STEP4_REASONS+=("GRAND_TOTAL_PAISE != 450000")
[ "$(echo "$SAMPLE_ROW" | jq -r '.GRAND_TOTAL_RUPEES')" = "4500" ] || STEP4_REASONS+=("GRAND_TOTAL_RUPEES != 4500")

if [ ${#STEP4_REASONS[@]} -eq 0 ]; then
  pass "Blue UI reference row (T1) reproduces exactly: 300km @ ₹14/km + ₹300 batta = ₹4500"
else
  fail "Blue UI reference row" "$(IFS='; '; echo "${STEP4_REASONS[*]}")"
fi

# ─── Step 5: customer subtotals correct (Ramesh group) ───
RAMESH_GROUP=$(echo "$SHEET1" | jq --arg id "$CUST_R" '[.groups[] | select(.customer_id == $id)][0]')
STEP5_KM=$(echo "$RAMESH_GROUP" | jq -r '.subtotal.total_running_km')
STEP5_TOTAL=$(echo "$RAMESH_GROUP" | jq -r '.subtotal.total_paise')

if [ "$STEP5_KM" = "$RAMESH_KM" ] && [ "$STEP5_TOTAL" = "$RAMESH_TOTAL" ]; then
  pass "Ramesh Iyer group subtotal: total_running_km=$RAMESH_KM, total_paise=$RAMESH_TOTAL"
else
  fail "Ramesh Iyer group subtotal" "km '$STEP5_KM' (expected $RAMESH_KM), total '$STEP5_TOTAL' (expected $RAMESH_TOTAL)"
fi

# ─── Step 6: includeCancelled=true -> T7 appears ───
SHEET6=$(curl -s "$BASE_URL/trips/performance-sheet?includeCancelled=true" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP6_ROWCOUNT=$(echo "$SHEET6" | jq -r '.grand_total.row_count')
STEP6_ACME_ROWS=$(echo "$SHEET6" | jq --arg id "$CUST_ACME" '[.groups[] | select(.customer_id == $id)][0].rows | length')

if [ "$STEP6_ROWCOUNT" = "7" ] && [ "$STEP6_ACME_ROWS" = "2" ]; then
  pass "includeCancelled=true: row_count=7, Acme group has 2 rows (T4+T7)"
else
  fail "includeCancelled=true" "row_count '$STEP6_ROWCOUNT', acme rows '$STEP6_ACME_ROWS'"
fi

# ─── Step 7: filter by customer ───
SHEET7=$(curl -s "$BASE_URL/trips/performance-sheet?customer_id=$CUST_R" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP7_GROUPCOUNT=$(echo "$SHEET7" | jq -r '.grand_total.group_count')
STEP7_ROWCOUNT=$(echo "$SHEET7" | jq -r '.grand_total.row_count')

if [ "$STEP7_GROUPCOUNT" = "1" ] && [ "$STEP7_ROWCOUNT" = "3" ]; then
  pass "Filter by customer_id=CUST_R: group_count=1, row_count=3"
else
  fail "Filter by customer_id" "group_count '$STEP7_GROUPCOUNT', row_count '$STEP7_ROWCOUNT'"
fi

# ─── Step 8: filter by vehicle (KIA) ───
SHEET8=$(curl -s "$BASE_URL/trips/performance-sheet?vehicle_id=$VEH_K" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP8_ROWCOUNT=$(echo "$SHEET8" | jq -r '.grand_total.row_count')
STEP8_GROUPCOUNT=$(echo "$SHEET8" | jq -r '.grand_total.group_count')

if [ "$STEP8_ROWCOUNT" = "2" ] && [ "$STEP8_GROUPCOUNT" = "2" ]; then
  pass "Filter by vehicle_id=VEH_K (KIA): row_count=2 (T4, T6), group_count=2 (Acme + Sunita)"
else
  fail "Filter by vehicle_id" "row_count '$STEP8_ROWCOUNT', group_count '$STEP8_GROUPCOUNT'"
fi

# ─── Step 9: filter by date range (from yesterday) ───
SHEET9=$(curl -s "$BASE_URL/trips/performance-sheet?from_date=$YESTERDAY" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP9_ROWCOUNT=$(echo "$SHEET9" | jq -r '.grand_total.row_count')

if [ "$STEP9_ROWCOUNT" = "2" ]; then
  pass "Filter by from_date=yesterday: row_count=2 (T5, T6 — T7 cancelled, excluded)"
else
  fail "Filter by from_date" "expected row_count 2, got '$STEP9_ROWCOUNT'"
fi

# ─── Step 10: filter by service_type ───
SHEET10=$(curl -s "$BASE_URL/trips/performance-sheet?service_type=OUTSTATION" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP10_TRIP_IDS=$(echo "$SHEET10" | jq -r '[.groups[].rows[].TRIP_ID] | sort | join(",")')
EXPECTED_IDS=$(printf '%s\n%s' "$T4" "$T6" | sort | tr '\n' ',' | sed 's/,$//')

if [ "$STEP10_TRIP_IDS" = "$EXPECTED_IDS" ]; then
  pass "Filter by service_type=OUTSTATION: only T4 and T6"
else
  fail "Filter by service_type" "expected '$EXPECTED_IDS', got '$STEP10_TRIP_IDS'"
fi

# ─── Step 11: sort default is chronological asc ───
SHEET11=$(curl -s "$BASE_URL/trips/performance-sheet" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP11_FIRST_GROUP_SORTED=$(echo "$SHEET11" | jq '(.groups[0].rows[0].DATE) == ([.groups[0].rows[].DATE] | min)')

if [ "$STEP11_FIRST_GROUP_SORTED" = "true" ]; then
  pass "Default sort (asc): first row of first group has the oldest DATE within that group"
else
  fail "Default sort asc" "first row is not the oldest within its group"
fi

# ─── Step 12: sort desc ───
SHEET12=$(curl -s "$BASE_URL/trips/performance-sheet?sort_dir=desc" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP12_FIRST_GROUP_SORTED=$(echo "$SHEET12" | jq '(.groups[0].rows[0].DATE) == ([.groups[0].rows[].DATE] | max)')

if [ "$STEP12_FIRST_GROUP_SORTED" = "true" ]; then
  pass "sort_dir=desc: first row of first group has the most recent DATE within that group"
else
  fail "Sort desc" "first row is not the most recent within its group"
fi

# ─── Step 13: invalid status value ───
LIST13_STATUS=$(curl -s -o "$WORK_DIR/list13.json" -w '%{http_code}' "$BASE_URL/trips/performance-sheet?status=DRAFT,BOGUS" -H "Authorization: Bearer $OWNER_A_TOKEN")
LIST13_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/list13.json")

if [ "$LIST13_STATUS" = "400" ] && [ "$LIST13_CODE" = "VALIDATION_ERROR" ]; then
  pass "Invalid status value (DRAFT,BOGUS): 400 VALIDATION_ERROR"
else
  fail "Invalid status value" "status '$LIST13_STATUS', code '$LIST13_CODE'"
fi

# ─── Step 14: from_date > to_date ───
LIST14_STATUS=$(curl -s -o "$WORK_DIR/list14.json" -w '%{http_code}' "$BASE_URL/trips/performance-sheet?from_date=$YESTERDAY&to_date=$DAYS_AGO_5" -H "Authorization: Bearer $OWNER_A_TOKEN")
LIST14_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/list14.json")

if [ "$LIST14_STATUS" = "400" ] && [ "$LIST14_CODE" = "VALIDATION_ERROR" ]; then
  pass "from_date > to_date: 400 VALIDATION_ERROR"
else
  fail "from_date > to_date" "status '$LIST14_STATUS', code '$LIST14_CODE'"
fi

# ─── Step 15: empty result set ───
NONEXISTENT_UUID="00000000-0000-4000-8000-000000000099"
SHEET15=$(curl -s "$BASE_URL/trips/performance-sheet?customer_id=$NONEXISTENT_UUID" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP15_ROWCOUNT=$(echo "$SHEET15" | jq -r '.grand_total.row_count')
STEP15_GROUPCOUNT=$(echo "$SHEET15" | jq -r '.grand_total.group_count')
STEP15_GROUPS=$(echo "$SHEET15" | jq '.groups')

if [ "$STEP15_ROWCOUNT" = "0" ] && [ "$STEP15_GROUPCOUNT" = "0" ] && [ "$STEP15_GROUPS" = "[]" ]; then
  pass "Empty result set (nonexistent customer_id): row_count=0, group_count=0, groups=[]"
else
  fail "Empty result set" "row_count '$STEP15_ROWCOUNT', group_count '$STEP15_GROUPCOUNT', groups '$STEP15_GROUPS'"
fi

# ─── Step 16: CSV export happy path ───
CSV_HEADERS=$(curl -s -D - -o "$WORK_DIR/perf.csv" "$BASE_URL/trips/performance-sheet/export.csv" -H "Authorization: Bearer $OWNER_A_TOKEN")
CSV_CONTENT_TYPE=$(echo "$CSV_HEADERS" | grep -i '^content-type:' | tr -d '\r')
CSV_DISPOSITION=$(echo "$CSV_HEADERS" | grep -i '^content-disposition:' | tr -d '\r')
CSV_ROWCOUNT_HDR=$(echo "$CSV_HEADERS" | grep -i '^x-row-count:' | tr -d '\r' | awk '{print $2}')
CSV_GROUPCOUNT_HDR=$(echo "$CSV_HEADERS" | grep -i '^x-group-count:' | tr -d '\r' | awk '{print $2}')

FIRST_LINE=$(head -1 "$WORK_DIR/perf.csv" | tr -d '\r')
EXPECTED_HEADER="SL,DATE,CUSTOMER,VEHICLE_TYPE,VEHICLE_NUMBER,TOTAL_RUNNING_KM,PER_KM_COST_RUPEES,TOTAL_COST_RUPEES,BATA_RUPEES,TOLL_CHARGES_RUPEES,GRAND_TOTAL_RUPEES,STATUS"
HAS_CRLF=$(grep -c $'\r' "$WORK_DIR/perf.csv")
SUBTOTAL_COUNT=$(grep -c ',SUBTOTAL,' "$WORK_DIR/perf.csv")
GRANDTOTAL_COUNT=$(grep -c ',GRAND TOTAL,' "$WORK_DIR/perf.csv")
TOTAL_LINES=$(wc -l < "$WORK_DIR/perf.csv" | tr -d '[:space:]')

STEP16_REASONS=()
echo "$CSV_CONTENT_TYPE" | grep -qi 'text/csv' || STEP16_REASONS+=("Content-Type missing text/csv: '$CSV_CONTENT_TYPE'")
echo "$CSV_DISPOSITION" | grep -q 'filename="performance-sheet-' || STEP16_REASONS+=("Content-Disposition missing expected filename: '$CSV_DISPOSITION'")
[ "$CSV_ROWCOUNT_HDR" = "6" ] || STEP16_REASONS+=("X-Row-Count expected 6, got '$CSV_ROWCOUNT_HDR'")
[ "$CSV_GROUPCOUNT_HDR" = "3" ] || STEP16_REASONS+=("X-Group-Count expected 3, got '$CSV_GROUPCOUNT_HDR'")
[ "$FIRST_LINE" = "$EXPECTED_HEADER" ] || STEP16_REASONS+=("header line mismatch: '$FIRST_LINE'")
[ "$HAS_CRLF" -gt 0 ] || STEP16_REASONS+=("no CRLF line endings found")
[ "$SUBTOTAL_COUNT" = "3" ] || STEP16_REASONS+=("expected 3 SUBTOTAL rows, got '$SUBTOTAL_COUNT'")
[ "$GRANDTOTAL_COUNT" = "1" ] || STEP16_REASONS+=("expected 1 GRAND TOTAL row, got '$GRANDTOTAL_COUNT'")
[ "$TOTAL_LINES" = "11" ] || STEP16_REASONS+=("expected 11 total lines (1 header + 6 data + 3 subtotal + 1 grand total), got '$TOTAL_LINES'")

if [ ${#STEP16_REASONS[@]} -eq 0 ]; then
  pass "CSV export happy path: headers correct, RFC 4180 header row, CRLF, 3 SUBTOTAL + 1 GRAND TOTAL, 11 total lines"
else
  fail "CSV export happy path" "$(IFS='; '; echo "${STEP16_REASONS[*]}")"
fi

# ─── Step 17: CSV escaping ───
CUST_COMMA=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"Foo, Inc.","gstin":"29ABCDE1234G1Z6"}' | jq -r '.customer.id // empty')
curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"PERFORMANCE\",\"customer_id\":\"$CUST_COMMA\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$YESTERDAY\",\"total_km\":50,\"total_hours\":4}" > /dev/null

curl -s -o "$WORK_DIR/perf2.csv" "$BASE_URL/trips/performance-sheet/export.csv" -H "Authorization: Bearer $OWNER_A_TOKEN"
ESCAPED_MATCH=$(grep -Fc ',"Foo, Inc.",' "$WORK_DIR/perf2.csv")

if [ -n "$CUST_COMMA" ] && [ "$ESCAPED_MATCH" -gt "0" ]; then
  pass "CSV escaping: 'Foo, Inc.' (embedded comma) is quote-wrapped per RFC 4180"
else
  fail "CSV escaping" "cust_comma created '$CUST_COMMA', escaped match count '$ESCAPED_MATCH'"
fi

# ─── Step 18: CSV row cap constant + branch exist (static check) ───
HAS_MAX_ROWS=$(grep -c 'MAX_ROWS' src/services/performanceSheet.service.js)
HAS_EXPORT_TOO_LARGE=$(grep -c 'EXPORT_TOO_LARGE' src/services/performanceSheet.service.js)

if [ "$HAS_MAX_ROWS" -gt "0" ] && [ "$HAS_EXPORT_TOO_LARGE" -gt "0" ]; then
  pass "CSV row cap: MAX_ROWS constant and EXPORT_TOO_LARGE branch both present in performanceSheet.service.js"
else
  fail "CSV row cap static check" "MAX_ROWS occurrences '$HAS_MAX_ROWS', EXPORT_TOO_LARGE occurrences '$HAS_EXPORT_TOO_LARGE'"
fi

# ─── Step 19: viewer can read ───
VIEWER_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/trips/performance-sheet" -H "Authorization: Bearer $VIEWER_A_TOKEN")

if [ "$VIEWER_STATUS" = "200" ]; then
  pass "Viewer can read performance sheet (trips:read): 200"
else
  fail "Viewer can read performance sheet" "got '$VIEWER_STATUS'"
fi

# ─── Step 20: cross-tenant isolation ───
SHEET20=$(curl -s "$BASE_URL/trips/performance-sheet" -H "Authorization: Bearer $OWNER_B_TOKEN")
STEP20_ROWCOUNT=$(echo "$SHEET20" | jq -r '.grand_total.row_count')

if [ "$STEP20_ROWCOUNT" = "0" ]; then
  pass "Cross-tenant isolation: tenant B sees row_count=0"
else
  fail "Cross-tenant isolation" "expected row_count 0, got '$STEP20_ROWCOUNT'"
fi

# ─── Step 21: DB-layer isolation ───
DB_COUNT=$(psql "${DATABASE_URL:-}" -tAc "SELECT COUNT(*) FROM trip_sheets WHERE billing_mode='PERFORMANCE';" 2>/dev/null | tr -d '[:space:]')

if [ "$DB_COUNT" = "0" ]; then
  pass "DB-layer isolation: direct psql with no tenant context set sees 0 PERFORMANCE rows"
else
  fail "DB-layer isolation" "expected 0, got '$DB_COUNT'"
fi

# ─── Step 22: regression — GET /trips list still works, returns both modes ───
LIST22=$(curl -s "$BASE_URL/trips?limit=100" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP22_TOTAL=$(echo "$LIST22" | jq -r '.pagination.total')

if [ "$STEP22_TOTAL" -ge "8" ]; then
  pass "Regression: GET /trips list total >= 8 (7 perf + 1 GST, includes both billing modes), got $STEP22_TOTAL"
else
  fail "Regression GET /trips list" "expected total >= 8, got '$STEP22_TOTAL'"
fi

# ─── Step 23: regression — GET /trips/:id still returns full detail ───
GET23=$(curl -s "$BASE_URL/trips/$T1" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP23_HAS_BREAKDOWN=$(echo "$GET23" | jq '.trip | has("breakdown")')
STEP23_HAS_SNAP=$(echo "$GET23" | jq '.trip | has("snap_per_km_rate_paise")')
STEP23_HAS_TOLLS=$(echo "$GET23" | jq '.trip | has("tolls")')

if [ "$STEP23_HAS_BREAKDOWN" = "true" ] && [ "$STEP23_HAS_SNAP" = "true" ] && [ "$STEP23_HAS_TOLLS" = "true" ]; then
  pass "Regression: GET /trips/:id still returns breakdown, snap_* fields, and tolls array"
else
  fail "Regression GET /trips/:id detail shape" "breakdown '$STEP23_HAS_BREAKDOWN', snap '$STEP23_HAS_SNAP', tolls '$STEP23_HAS_TOLLS'"
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
  printf '%s✓ All %s checks passed. Performance sheet module (Task 3.5) is working correctly.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
  echo
  echo "Tenant A owner: $OWNER_A_EMAIL"
  echo "Tenant A staff: $STAFF_A_EMAIL"
  echo "Tenant A viewer: $VIEWER_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 0
fi
