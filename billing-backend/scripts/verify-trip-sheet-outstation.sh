#!/usr/bin/env bash
#
# End-to-end verification of the Task 3.2 outstation trip module:
# OUTSTATION/GST (slab pricing, per-day km floor, driver batta ×
# total_days, advance deducted at trip level) and OUTSTATION/PERFORMANCE
# billing modes, itemized per-plaza toll receipts (trip_tolls, sum-
# derived toll_paise), the lump-sum-vs-itemized conflict rule, snapshot
# durability across rule supersede, and cross-tenant + DB-layer
# isolation on both trip_sheets and trip_tolls. Mirrors
# scripts/verify-trip-sheet-local.sh (Task 3.1). Prints a PASS/FAIL
# summary and exits 1 if anything failed.
#
# Deliberately `set -u` but NOT `set -e`: we want every check to run
# even if an earlier one fails, so the summary reports everything
# that's broken in one pass instead of stopping at the first failure.
set -u

BASE_URL="http://localhost:8000/api/v1"

# Direct psql against $DATABASE_URL — no Docker container involved,
# matching scripts/verify-auth.sh's preflight (and every other
# verify-*.sh script's underlying "no docker in this environment"
# reality). Loaded from .env if not already set.
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

TEST_PASSWORD="Passw0rd123"
OWNER_A_EMAIL="verify-trips-os-owner-a-$(date +%s)@example.com"
STAFF_A_EMAIL="verify-trips-os-staff-a-$(date +%s)-2@example.com"
VIEWER_A_EMAIL="verify-trips-os-viewer-a-$(date +%s)-3@example.com"
OWNER_B_EMAIL="verify-trips-os-owner-b-$(date +%s)-4@example.com"

# All trip dates are computed as offsets BACK from today rather than
# the fixed 2026-07/08 calendar dates the task spec illustrates with:
# tripDateField (tripSheet.validator.js) rejects any trip_date after
# today, evaluated at request time. Hardcoding a spec date risks it
# silently drifting into the future relative to whenever this script
# actually runs — exactly the failure mode hit while building this
# script (today's real date makes several of the spec's example dates,
# e.g. 2026-08-01, future dates). Offsetting from `date -v-Nd` keeps
# every trip_date safely in the past no matter when this runs, while
# staying within the same fiscal year as today for small offsets.
days_ago() { date -v-"$1"d +%Y-%m-%d; }
TODAY=$(date +%Y-%m-%d)
DATE_CAUVERY=$(days_ago 20)
DATE_NIRIKSHA=$(days_ago 19)
DATE_ITEMIZED=$(days_ago 18)
DATE_CONFLICT=$(days_ago 17)
DATE_MINKM=$(days_ago 16)
DATE_PERF=$(days_ago 15)
DATE_NORULE=$(days_ago 14)
DATE_EMPTYTOLLS=$(days_ago 13)
DATE_MALFORMED=$(days_ago 12)
DATE_NEGATIVE=$(days_ago 11)
DATE_OVERLIMIT=$(days_ago 10)
DATE_LOCAL_REGRESSION=$(days_ago 9)

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
TOTAL_CHECKS=17
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
  -d "{\"businessName\":\"Verify Outstation Co A\",\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner A\"}")
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

# Prefix "CI" matches Cauvery Cars invoice numbering — not required for
# correctness, just makes the reference-match tests more literal.
curl -s -X PATCH "$BASE_URL/settings/business" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H "Content-Type: application/json" -d '{"state_code":"KA","trip_sheet_prefix":"CI"}' > /dev/null

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
  -d "{\"businessName\":\"Verify Outstation Co B\",\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner B\"}")
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

VEH_KIA=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA01AM7323","vehicle_type":"KIA_CARNIVAL","make_model":"KIA Carnival","seating_capacity":7}' | jq -r '.vehicle.id // empty')

VEH_BUS=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA51AD4994","vehicle_type":"BUS_50_SEATER","make_model":"Volvo 9400"}' | jq -r '.vehicle.id // empty')

CUST_SUN=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"SunTravels","gstin":"29ABCDE1234F1Z5","credit_days":15}' | jq -r '.customer.id // empty')

DRV=$(curl -s -X POST "$BASE_URL/drivers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"full_name":"Muralidhar","phone":"9686847064"}' | jq -r '.driver.id // empty')

RULE_KIA_OS=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"OUTSTATION_SLAB","vehicle_type":"KIA_CARNIVAL","label":"KIA Carnival Outstation","slab_rate_rupees":50,"min_km_per_day":250,"driver_batta_per_day_rupees":960,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')

RULE_BUS_OS=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"OUTSTATION_SLAB","vehicle_type":"BUS_50_SEATER","label":"50-Seater Bus Outstation","slab_rate_rupees":52,"min_km_per_day":300,"driver_batta_per_day_rupees":1600,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')

curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"PERFORMANCE","vehicle_type":"KIA_CARNIVAL","label":"KIA Perf","per_km_rate_rupees":60,"performance_batta_rupees":500,"effective_from":"2026-01-01"}' > /dev/null

if [ -z "$VEH_KIA" ] || [ -z "$VEH_BUS" ] || [ -z "$CUST_SUN" ] || [ -z "$DRV" ] || [ -z "$RULE_KIA_OS" ] || [ -z "$RULE_BUS_OS" ]; then
  printf '%sSetup did not yield all required fixtures. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

echo "Setup: tenant A (owner + staff + viewer, state_code=KA, trip_sheet_prefix=CI), tenant B (owner), KIA_CARNIVAL + BUS_50_SEATER vehicles, B2B customer, driver, OUTSTATION_SLAB rules ×2, PERFORMANCE rule"
echo

echo "Checks"
echo "------"

# ─── Step 1: Cauvery Cars CI-150 reference reproduction ───
CREATE1_STATUS=$(curl -s -o "$WORK_DIR/trip1.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_SUN\",\"vehicle_id\":\"$VEH_KIA\",\"driver_id\":\"$DRV\",\"trip_date\":\"$DATE_CAUVERY\",\"total_km\":1699,\"total_hours\":120,\"total_days\":5,\"fasttag_rupees\":2440,\"booked_by\":\"Uma shankar\"}")
TRIP_CAUVERY=$(jq -r '.trip.id // empty' "$WORK_DIR/trip1.json")
T1_NUMBER=$(jq -r '.trip.trip_sheet_number // empty' "$WORK_DIR/trip1.json")

STEP1_REASONS=()
[ "$CREATE1_STATUS" = "201" ] || STEP1_REASONS+=("expected status 201, got '$CREATE1_STATUS'")
echo "$T1_NUMBER" | grep -qE '^CI-[0-9]+/26-27$' || STEP1_REASONS+=("trip_sheet_number '$T1_NUMBER' does not match ^CI-\\d+/26-27\$")
[ "$(jq -r '.trip.service_type' "$WORK_DIR/trip1.json")" = "OUTSTATION" ] || STEP1_REASONS+=("service_type mismatch")
[ "$(jq -r '.trip.billing_mode' "$WORK_DIR/trip1.json")" = "GST" ] || STEP1_REASONS+=("billing_mode mismatch")
[ "$(jq -r '.trip.status' "$WORK_DIR/trip1.json")" = "DRAFT" ] || STEP1_REASONS+=("status mismatch")
[ "$(jq -r '.trip.total_days' "$WORK_DIR/trip1.json")" = "5" ] || STEP1_REASONS+=("total_days mismatch")
[ "$(jq -r '.trip.snapshot_vehicle_number' "$WORK_DIR/trip1.json")" = "KA01AM7323" ] || STEP1_REASONS+=("snapshot_vehicle_number mismatch")
[ "$(jq -r '.trip.snap_slab_rate_paise' "$WORK_DIR/trip1.json")" = "5000" ] || STEP1_REASONS+=("snap_slab_rate_paise mismatch")
[ "$(jq -r '.trip.snap_min_km_per_day' "$WORK_DIR/trip1.json")" = "250" ] || STEP1_REASONS+=("snap_min_km_per_day mismatch")
[ "$(jq -r '.trip.snap_driver_batta_per_day_paise' "$WORK_DIR/trip1.json")" = "96000" ] || STEP1_REASONS+=("snap_driver_batta_per_day_paise mismatch")
[ "$(jq -r '.trip.base_amount_paise' "$WORK_DIR/trip1.json")" = "8495000" ] || STEP1_REASONS+=("base_amount_paise mismatch")
[ "$(jq -r '.trip.driver_batta_paise' "$WORK_DIR/trip1.json")" = "480000" ] || STEP1_REASONS+=("driver_batta_paise mismatch")
[ "$(jq -r '.trip.extras_amount_paise' "$WORK_DIR/trip1.json")" = "244000" ] || STEP1_REASONS+=("extras_amount_paise mismatch")
[ "$(jq -r '.trip.fasttag_paise' "$WORK_DIR/trip1.json")" = "244000" ] || STEP1_REASONS+=("fasttag_paise mismatch")
[ "$(jq -r '.trip.subtotal_paise' "$WORK_DIR/trip1.json")" = "9219000" ] || STEP1_REASONS+=("subtotal_paise mismatch")
[ "$(jq -r '.trip.gross_paise' "$WORK_DIR/trip1.json")" = "9219000" ] || STEP1_REASONS+=("gross_paise mismatch")
[ "$(jq -r '.trip.net_payable_paise' "$WORK_DIR/trip1.json")" = "9219000" ] || STEP1_REASONS+=("net_payable_paise mismatch")
[ "$(jq '.trip.tolls | type' "$WORK_DIR/trip1.json")" = '"array"' ] && [ "$(jq '.trip.tolls | length' "$WORK_DIR/trip1.json")" = "0" ] || STEP1_REASONS+=("tolls is not an empty array")

if [ ${#STEP1_REASONS[@]} -eq 0 ]; then
  pass "Cauvery Cars CI-150 reference: 201, number $T1_NUMBER, gross/net = 9219000 paise (₹92,190)"
else
  fail "Cauvery Cars CI-150 reference" "$(IFS='; '; echo "${STEP1_REASONS[*]}")"
fi
[ -n "$TRIP_CAUVERY" ] || TRIP_CAUVERY="00000000-0000-4000-8000-000000000000"

# ─── Step 2: Niriksha Travel CI-1905 reference reproduction ───
CREATE2_STATUS=$(curl -s -o "$WORK_DIR/trip2.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_SUN\",\"vehicle_id\":\"$VEH_BUS\",\"trip_date\":\"$DATE_NIRIKSHA\",\"total_km\":1064,\"total_hours\":48,\"total_days\":2,\"parking_rupees\":200,\"fasttag_rupees\":4040,\"advance_rupees\":25000,\"booked_by\":\"Madan\",\"pax_note\":\"Mr. Muralidhar\"}")

STEP2_REASONS=()
[ "$CREATE2_STATUS" = "201" ] || STEP2_REASONS+=("expected status 201, got '$CREATE2_STATUS'")
[ "$(jq -r '.trip.base_amount_paise' "$WORK_DIR/trip2.json")" = "5532800" ] || STEP2_REASONS+=("base_amount_paise mismatch")
[ "$(jq -r '.trip.driver_batta_paise' "$WORK_DIR/trip2.json")" = "320000" ] || STEP2_REASONS+=("driver_batta_paise mismatch")
[ "$(jq -r '.trip.parking_paise' "$WORK_DIR/trip2.json")" = "20000" ] || STEP2_REASONS+=("parking_paise mismatch")
[ "$(jq -r '.trip.fasttag_paise' "$WORK_DIR/trip2.json")" = "404000" ] || STEP2_REASONS+=("fasttag_paise mismatch")
[ "$(jq -r '.trip.subtotal_paise' "$WORK_DIR/trip2.json")" = "6276800" ] || STEP2_REASONS+=("subtotal_paise mismatch (expected 6276800 = ₹62,768)")
[ "$(jq -r '.trip.gross_paise' "$WORK_DIR/trip2.json")" = "6276800" ] || STEP2_REASONS+=("gross_paise mismatch")
[ "$(jq -r '.trip.advance_paise' "$WORK_DIR/trip2.json")" = "2500000" ] || STEP2_REASONS+=("advance_paise mismatch")
[ "$(jq -r '.trip.net_payable_paise' "$WORK_DIR/trip2.json")" = "3776800" ] || STEP2_REASONS+=("net_payable_paise mismatch (expected 3776800 = ₹37,768)")

if [ ${#STEP2_REASONS[@]} -eq 0 ]; then
  pass "Niriksha Travel CI-1905 reference: 201, gross 6276800 (₹62,768), net 3776800 (₹37,768)"
else
  fail "Niriksha Travel CI-1905 reference" "$(IFS='; '; echo "${STEP2_REASONS[*]}")"
fi

# ─── Step 3: itemized tolls array (Niriksha-style duty slip) ───
TOLLS_PAYLOAD='[
  {"plaza_name":"Tumkur Road (P7) Toll","toll_id":"556026","amount_rupees":490,"crossed_at":"2026-08-01T16:00:20Z","vehicle_number":"KA51AD4994"},
  {"plaza_name":"Navayuga Bangalooru Tollway","toll_id":"116001","amount_rupees":95,"crossed_at":"2026-08-01T16:04:33Z"},
  {"plaza_name":"Kulumapalya toll plaza","toll_id":"115001","amount_rupees":80,"crossed_at":"2026-08-01T16:17:32Z"},
  {"plaza_name":"Chokkenahalli toll plaza","toll_id":"115002","amount_rupees":85,"crossed_at":"2026-08-01T16:48:02Z"},
  {"plaza_name":"Karjeevanhally Toll Plaza","toll_id":"017001","amount_rupees":340,"crossed_at":"2026-08-01T17:47:26Z"},
  {"plaza_name":"Guilalu Toll Plaza","toll_id":"017002","amount_rupees":275,"crossed_at":"2026-08-01T19:42:06Z"},
  {"plaza_name":"Hebbalu Toll Plaza","toll_id":"356020","amount_rupees":430,"crossed_at":"2026-08-01T22:37:48Z"},
  {"plaza_name":"Chalageri Toll Plaza","toll_id":"356019","amount_rupees":470,"crossed_at":"2026-08-01T23:18:14Z"}
]'
CREATE3_STATUS=$(curl -s -o "$WORK_DIR/trip3.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_SUN\",\"vehicle_id\":\"$VEH_BUS\",\"trip_date\":\"$DATE_ITEMIZED\",\"total_km\":1200,\"total_hours\":36,\"total_days\":2,\"tolls\":$TOLLS_PAYLOAD}")
TRIP_ITEMIZED=$(jq -r '.trip.id // empty' "$WORK_DIR/trip3.json")

STEP3_REASONS=()
[ "$CREATE3_STATUS" = "201" ] || STEP3_REASONS+=("expected status 201, got '$CREATE3_STATUS'")
[ "$(jq '.trip.tolls | length' "$WORK_DIR/trip3.json")" = "8" ] || STEP3_REASONS+=("expected 8 tolls, got $(jq '.trip.tolls | length' "$WORK_DIR/trip3.json")")
[ "$(jq -r '.trip.tolls[0].line_number' "$WORK_DIR/trip3.json")" = "1" ] || STEP3_REASONS+=("tolls[0].line_number != 1")
[ "$(jq -r '.trip.tolls[0].plaza_name' "$WORK_DIR/trip3.json")" = "Tumkur Road (P7) Toll" ] || STEP3_REASONS+=("tolls[0].plaza_name mismatch")
[ "$(jq -r '.trip.tolls[0].amount_paise' "$WORK_DIR/trip3.json")" = "49000" ] || STEP3_REASONS+=("tolls[0].amount_paise mismatch")
SORTED_CHECK=$(jq '[.trip.tolls[].line_number] == ([.trip.tolls[].line_number] | sort)' "$WORK_DIR/trip3.json")
[ "$SORTED_CHECK" = "true" ] || STEP3_REASONS+=("tolls not sorted ascending by line_number")
TOLLS_SUM=$(jq '[.trip.tolls[].amount_paise] | add' "$WORK_DIR/trip3.json")
[ "$TOLLS_SUM" = "226500" ] || STEP3_REASONS+=("sum of tolls[].amount_paise expected 226500, got '$TOLLS_SUM'")
[ "$(jq -r '.trip.toll_paise' "$WORK_DIR/trip3.json")" = "226500" ] || STEP3_REASONS+=("trip.toll_paise expected 226500 (derived from itemized sum), got '$(jq -r '.trip.toll_paise' "$WORK_DIR/trip3.json")'")

if [ ${#STEP3_REASONS[@]} -eq 0 ]; then
  pass "Itemized tolls array: 8 receipts, sorted by line_number, sum 226500 paise, trip.toll_paise derived from sum"
else
  fail "Itemized tolls array" "$(IFS='; '; echo "${STEP3_REASONS[*]}")"
fi
[ -n "$TRIP_ITEMIZED" ] || TRIP_ITEMIZED="00000000-0000-4000-8000-000000000001"

# ─── Step 4: lump toll AND itemized tolls -> conflict ───
CREATE4_STATUS=$(curl -s -o "$WORK_DIR/trip4.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_SUN\",\"vehicle_id\":\"$VEH_KIA\",\"trip_date\":\"$DATE_CONFLICT\",\"total_km\":800,\"total_hours\":24,\"total_days\":2,\"toll_rupees\":500,\"tolls\":[{\"plaza_name\":\"Some Plaza\",\"amount_rupees\":100}]}")
CREATE4_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/trip4.json")

if [ "$CREATE4_STATUS" = "400" ] && [ "$CREATE4_CODE" = "TOLL_INPUT_CONFLICT" ]; then
  pass "Lump toll_rupees AND itemized tolls together: 400 TOLL_INPUT_CONFLICT"
else
  fail "Lump toll_rupees AND itemized tolls together: 400 TOLL_INPUT_CONFLICT" "status '$CREATE4_STATUS', code '$CREATE4_CODE'"
fi

# ─── Step 5: min-km floor kicks in ───
CREATE5_STATUS=$(curl -s -o "$WORK_DIR/trip5.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_SUN\",\"vehicle_id\":\"$VEH_KIA\",\"trip_date\":\"$DATE_MINKM\",\"total_km\":200,\"total_hours\":12,\"total_days\":2}")
CREATE5_BASE=$(jq -r '.trip.base_amount_paise // empty' "$WORK_DIR/trip5.json")

if [ "$CREATE5_STATUS" = "201" ] && [ "$CREATE5_BASE" = "2500000" ]; then
  pass "Min-km floor (200 actual < 250×2 min): 201, base_amount_paise = 2500000 (500 billable km × ₹50)"
else
  fail "Min-km floor kicks in" "status '$CREATE5_STATUS', base_amount_paise '$CREATE5_BASE'"
fi

# ─── Step 6: OUTSTATION with PERFORMANCE billing mode ───
CREATE6_STATUS=$(curl -s -o "$WORK_DIR/trip6.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"PERFORMANCE\",\"customer_id\":\"$CUST_SUN\",\"vehicle_id\":\"$VEH_KIA\",\"trip_date\":\"$DATE_PERF\",\"total_km\":600,\"total_hours\":16,\"total_days\":1}")

STEP6_REASONS=()
[ "$CREATE6_STATUS" = "201" ] || STEP6_REASONS+=("expected status 201, got '$CREATE6_STATUS'")
[ "$(jq -r '.trip.base_amount_paise' "$WORK_DIR/trip6.json")" = "3600000" ] || STEP6_REASONS+=("base_amount_paise mismatch")
[ "$(jq -r '.trip.driver_batta_paise' "$WORK_DIR/trip6.json")" = "50000" ] || STEP6_REASONS+=("driver_batta_paise mismatch")
[ "$(jq -r '.trip.subtotal_paise' "$WORK_DIR/trip6.json")" = "3650000" ] || STEP6_REASONS+=("subtotal_paise mismatch")

if [ ${#STEP6_REASONS[@]} -eq 0 ]; then
  pass "OUTSTATION/PERFORMANCE: 201, base 3600000 + batta 50000 = subtotal 3650000 (all 4 service_type×billing_mode combos now work)"
else
  fail "OUTSTATION/PERFORMANCE" "$(IFS='; '; echo "${STEP6_REASONS[*]}")"
fi

# ─── Step 7: no applicable OUTSTATION rule ───
VEH_SEDAN_NEW=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA05XY1234","vehicle_type":"SEDAN"}' | jq -r '.vehicle.id // empty')

CREATE7_STATUS=$(curl -s -o "$WORK_DIR/trip7.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_SUN\",\"vehicle_id\":\"$VEH_SEDAN_NEW\",\"trip_date\":\"$DATE_NORULE\",\"total_km\":400,\"total_hours\":24,\"total_days\":2}")
CREATE7_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/trip7.json")
CREATE7_RTYPE=$(jq -r '.error.details.rule_type // empty' "$WORK_DIR/trip7.json")
CREATE7_VTYPE=$(jq -r '.error.details.vehicle_type // empty' "$WORK_DIR/trip7.json")

if [ "$CREATE7_STATUS" = "400" ] && [ "$CREATE7_CODE" = "NO_APPLICABLE_PRICING_RULE" ] && [ "$CREATE7_RTYPE" = "OUTSTATION_SLAB" ] && [ "$CREATE7_VTYPE" = "SEDAN" ]; then
  pass "No applicable OUTSTATION rule (SEDAN): 400 NO_APPLICABLE_PRICING_RULE, rule_type=OUTSTATION_SLAB, vehicle_type=SEDAN"
else
  fail "No applicable OUTSTATION rule" "status '$CREATE7_STATUS', code '$CREATE7_CODE', rule_type '$CREATE7_RTYPE', vehicle_type '$CREATE7_VTYPE'"
fi

# ─── Step 8: empty tolls array is allowed ───
CREATE8_STATUS=$(curl -s -o "$WORK_DIR/trip8.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_SUN\",\"vehicle_id\":\"$VEH_KIA\",\"trip_date\":\"$DATE_EMPTYTOLLS\",\"total_km\":500,\"total_hours\":16,\"total_days\":1,\"tolls\":[]}")

STEP8_REASONS=()
[ "$CREATE8_STATUS" = "201" ] || STEP8_REASONS+=("expected status 201, got '$CREATE8_STATUS'")
[ "$(jq '.trip.tolls | length' "$WORK_DIR/trip8.json")" = "0" ] || STEP8_REASONS+=("tolls not empty")
[ "$(jq -r '.trip.toll_paise' "$WORK_DIR/trip8.json")" = "0" ] || STEP8_REASONS+=("toll_paise != 0")

if [ ${#STEP8_REASONS[@]} -eq 0 ]; then
  pass "Empty tolls array: 201, tolls = [], toll_paise = 0"
else
  fail "Empty tolls array" "$(IFS='; '; echo "${STEP8_REASONS[*]}")"
fi

# ─── Step 9: toll receipt with malformed data (empty plaza_name) ───
CREATE9_STATUS=$(curl -s -o "$WORK_DIR/trip9.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_SUN\",\"vehicle_id\":\"$VEH_KIA\",\"trip_date\":\"$DATE_MALFORMED\",\"total_km\":400,\"total_hours\":12,\"total_days\":1,\"tolls\":[{\"plaza_name\":\"\",\"amount_rupees\":100}]}")
CREATE9_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/trip9.json")

if [ "$CREATE9_STATUS" = "400" ] && [ "$CREATE9_CODE" = "VALIDATION_ERROR" ]; then
  pass "Toll receipt with empty plaza_name: 400 VALIDATION_ERROR"
else
  fail "Toll receipt with empty plaza_name: 400 VALIDATION_ERROR" "status '$CREATE9_STATUS', code '$CREATE9_CODE'"
fi

# ─── Step 10: toll receipt with negative amount ───
CREATE10_STATUS=$(curl -s -o "$WORK_DIR/trip10.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_SUN\",\"vehicle_id\":\"$VEH_KIA\",\"trip_date\":\"$DATE_NEGATIVE\",\"total_km\":400,\"total_hours\":12,\"total_days\":1,\"tolls\":[{\"plaza_name\":\"P\",\"amount_rupees\":-50}]}")
CREATE10_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/trip10.json")

if [ "$CREATE10_STATUS" = "400" ] && [ "$CREATE10_CODE" = "VALIDATION_ERROR" ]; then
  pass "Toll receipt with negative amount: 400 VALIDATION_ERROR"
else
  fail "Toll receipt with negative amount: 400 VALIDATION_ERROR" "status '$CREATE10_STATUS', code '$CREATE10_CODE'"
fi

# ─── Step 11: over-limit tolls array (>50) ───
OVERLIMIT_TOLLS=$(node -e '
  const items = [];
  for (let i = 0; i < 51; i++) items.push({ plaza_name: "P", amount_rupees: 1 });
  process.stdout.write(JSON.stringify(items));
')
CREATE11_STATUS=$(curl -s -o "$WORK_DIR/trip11.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_SUN\",\"vehicle_id\":\"$VEH_KIA\",\"trip_date\":\"$DATE_OVERLIMIT\",\"total_km\":400,\"total_hours\":12,\"total_days\":1,\"tolls\":$OVERLIMIT_TOLLS}")
CREATE11_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/trip11.json")

if [ "$CREATE11_STATUS" = "400" ] && [ "$CREATE11_CODE" = "VALIDATION_ERROR" ]; then
  pass "Over-limit tolls array (51 items): 400 VALIDATION_ERROR"
else
  fail "Over-limit tolls array (51 items): 400 VALIDATION_ERROR" "status '$CREATE11_STATUS', code '$CREATE11_CODE'"
fi

# ─── Step 12: GET /trips/:id includes tolls ───
GET12=$(curl -s "$BASE_URL/trips/$TRIP_ITEMIZED" -H "Authorization: Bearer $OWNER_A_TOKEN")
GET12_COUNT=$(echo "$GET12" | jq '.trip.tolls | length')
GET12_SORTED=$(echo "$GET12" | jq '[.trip.tolls[].line_number] == ([.trip.tolls[].line_number] | sort)')

if [ "$GET12_COUNT" = "8" ] && [ "$GET12_SORTED" = "true" ]; then
  pass "GET /trips/{id} includes tolls: length 8, sorted ascending by line_number"
else
  fail "GET /trips/{id} includes tolls" "count '$GET12_COUNT', sorted '$GET12_SORTED'"
fi

# ─── Step 13: cross-tenant leak on trip AND tolls ───
LEAK_STATUS=$(curl -s -o "$WORK_DIR/leak.json" -w '%{http_code}' "$BASE_URL/trips/$TRIP_ITEMIZED" \
  -H "Authorization: Bearer $OWNER_B_TOKEN")
LEAK_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/leak.json")

if [ "$LEAK_STATUS" = "404" ] && [ "$LEAK_CODE" = "TRIP_NOT_FOUND" ]; then
  pass "Cross-tenant GET /trips/{id} (tenant B reading tenant A's itemized-tolls trip): 404 TRIP_NOT_FOUND"
else
  fail "Cross-tenant GET /trips/{id}: 404 TRIP_NOT_FOUND" "status '$LEAK_STATUS', code '$LEAK_CODE'"
fi

# ─── Step 14: DB-layer isolation on both tables ───
DB_COUNT_TRIPS=$(psql "${DATABASE_URL:-}" -tAc "SELECT COUNT(*) FROM trip_sheets;" 2>/dev/null | tr -d '[:space:]')
DB_COUNT_TOLLS=$(psql "${DATABASE_URL:-}" -tAc "SELECT COUNT(*) FROM trip_tolls;" 2>/dev/null | tr -d '[:space:]')

if [ "$DB_COUNT_TRIPS" = "0" ] && [ "$DB_COUNT_TOLLS" = "0" ]; then
  pass "DB-layer isolation: direct psql with no tenant context set sees 0 rows in both trip_sheets and trip_tolls"
else
  fail "DB-layer isolation: 0 rows in both tables with no tenant context" "trip_sheets='$DB_COUNT_TRIPS', trip_tolls='$DB_COUNT_TOLLS'"
fi

# ─── Step 15: snapshot survives OUTSTATION rule supersede ───
curl -s -X POST "$BASE_URL/pricing/rules/$RULE_KIA_OS/supersede" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"label\":\"KIA Carnival Outstation (revised)\",\"slab_rate_rupees\":60,\"min_km_per_day\":250,\"driver_batta_per_day_rupees\":1200,\"effective_from\":\"$TODAY\"}" > "$WORK_DIR/supersede.json"
SUPERSEDE_NEW_ID=$(jq -r '.new_rule.id // empty' "$WORK_DIR/supersede.json")

REFETCH_TRIP1=$(curl -s "$BASE_URL/trips/$TRIP_CAUVERY" -H "Authorization: Bearer $OWNER_A_TOKEN")

STEP15_REASONS=()
[ -n "$SUPERSEDE_NEW_ID" ] || STEP15_REASONS+=("supersede did not return a new_rule.id")
[ "$(echo "$REFETCH_TRIP1" | jq -r '.trip.snap_slab_rate_paise')" = "5000" ] || STEP15_REASONS+=("snap_slab_rate_paise changed after supersede")
[ "$(echo "$REFETCH_TRIP1" | jq -r '.trip.snap_driver_batta_per_day_paise')" = "96000" ] || STEP15_REASONS+=("snap_driver_batta_per_day_paise changed after supersede")
[ "$(echo "$REFETCH_TRIP1" | jq -r '.trip.base_amount_paise')" = "8495000" ] || STEP15_REASONS+=("base_amount_paise changed after supersede")
[ "$(echo "$REFETCH_TRIP1" | jq -r '.trip.driver_batta_paise')" = "480000" ] || STEP15_REASONS+=("driver_batta_paise changed after supersede")
[ "$(echo "$REFETCH_TRIP1" | jq -r '.trip.subtotal_paise')" = "9219000" ] || STEP15_REASONS+=("subtotal_paise changed after supersede")

if [ ${#STEP15_REASONS[@]} -eq 0 ]; then
  pass "Snapshot survives OUTSTATION rule supersede: TRIP_CAUVERY's rate fields unchanged after RULE_KIA_OS superseded"
else
  fail "Snapshot survives OUTSTATION rule supersede" "$(IFS='; '; echo "${STEP15_REASONS[*]}")"
fi

# ─── Step 16: LOCAL trip creation still works (regression) ───
CREATE16_STATUS=$(curl -s -o "$WORK_DIR/trip16.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_SUN\",\"vehicle_id\":\"$VEH_SEDAN_NEW\",\"trip_date\":\"$DATE_LOCAL_REGRESSION\",\"total_km\":100,\"total_hours\":8}")
CREATE16_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/trip16.json")

# SEDAN has no LOCAL_PACKAGE rule in this fresh tenant, so the correct
# surface is NO_APPLICABLE_PRICING_RULE, not the old 501 stub — this
# proves the LOCAL code path is still reachable and unchanged (Task 3.1
# behavior is invariant), not that this specific request succeeds.
if [ "$CREATE16_STATUS" = "400" ] && [ "$CREATE16_CODE" = "NO_APPLICABLE_PRICING_RULE" ]; then
  pass "LOCAL trip creation still reachable (regression): 400 NO_APPLICABLE_PRICING_RULE, not 501 — LOCAL path unchanged"
else
  fail "LOCAL trip creation still works: 400 NO_APPLICABLE_PRICING_RULE" "status '$CREATE16_STATUS', code '$CREATE16_CODE'"
fi

# ─── Step 17: viewer cannot create outstation trip ───
CREATE17_STATUS=$(curl -s -o "$WORK_DIR/trip17.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $VIEWER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_SUN\",\"vehicle_id\":\"$VEH_KIA\",\"trip_date\":\"$DATE_LOCAL_REGRESSION\",\"total_km\":400,\"total_hours\":12,\"total_days\":1}")
CREATE17_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/trip17.json")

if [ "$CREATE17_STATUS" = "403" ] && [ "$CREATE17_CODE" = "FORBIDDEN" ]; then
  pass "Viewer cannot create outstation trip: 403 FORBIDDEN"
else
  fail "Viewer cannot create outstation trip: 403 FORBIDDEN" "status '$CREATE17_STATUS', code '$CREATE17_CODE'"
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
  printf '%s✓ All %s checks passed. Outstation trip module (Task 3.2) is working correctly.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
  echo
  echo "Tenant A owner: $OWNER_A_EMAIL"
  echo "Tenant A staff: $STAFF_A_EMAIL"
  echo "Tenant A viewer: $VIEWER_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 0
fi
