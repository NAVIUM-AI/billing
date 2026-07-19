#!/usr/bin/env bash
#
# End-to-end verification of the Task 4.2 invoiceable-trips picker +
# reimbursement auto-sum + line description editing. Mirrors
# scripts/verify-invoice-draft.sh's structure. Prints a PASS/FAIL
# summary and exits 1 if anything failed.
#
# Note on aggregate-money assertions: for the picker's group/overall
# summaries (Steps 1, 5, 6, 11, 12) this script checks COUNTS and KM
# exactly (both are plain user input, unambiguous) but checks the
# MONEY aggregates (total_subtotal_paise etc.) by SELF-CONSISTENCY —
# summary.total_x must equal the sum of trips[].x in the SAME response
# — rather than hand-deriving the pricing engine's internal
# subtotal/gross/net formulas from scratch. That tests the aggregation
# logic under test (does the summary correctly fold the trip list) without
# smuggling in a second, independently-fallible copy of the pricing
# engine's arithmetic. Same approach as
# verify-performance-sheet.sh's "sum of group subtotals == grand_total"
# check. The Cauvery/auto-sum steps (10, 13-17) DO assert exact paise
# amounts, since those numbers are direct user input (fasttag_rupees,
# toll_rupees, parking_rupees) or well-established reference figures
# already proven in verify-invoice-draft.sh and test-gst-calc.js.
#
# Deliberately `set -u` but NOT `set -e`.
set -u

BASE_URL="http://localhost:8000/api/v1"

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

TEST_PASSWORD="Passw0rd123"
OWNER_A_EMAIL="verify-inv-picker-owner-a-$(date +%s)@example.com"
ACCT_A_EMAIL="verify-inv-picker-acct-a-$(date +%s)-2@example.com"
STAFF_A_EMAIL="verify-inv-picker-staff-a-$(date +%s)-3@example.com"
VIEWER_A_EMAIL="verify-inv-picker-viewer-a-$(date +%s)-4@example.com"
OWNER_B_EMAIL="verify-inv-picker-owner-b-$(date +%s)-5@example.com"

# Rule 8: all trip dates computed as offsets BACK from today.
days_ago() { date -v-"$1"d +%Y-%m-%d; }
YESTERDAY=$(days_ago 1)
DAYS_AGO_2=$(days_ago 2)
DAYS_AGO_3=$(days_ago 3)
DAYS_AGO_4=$(days_ago 4)
DAYS_AGO_5=$(days_ago 5)
DAYS_AGO_6=$(days_ago 6)
DAYS_AGO_8=$(days_ago 8)
DAYS_AGO_10=$(days_ago 10)

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
TOTAL_CHECKS=28
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
echo "  connected to database '$(echo "$DB_IDENTITY" | cut -d'|' -f1)' as role '$(echo "$DB_IDENTITY" | cut -d'|' -f2)'"

if ! command -v jq >/dev/null 2>&1; then
  printf '%sjq is required for this script.\nInstall it with: brew install jq%s\n' "$RED" "$RESET"
  exit 1
fi
echo "  jq is installed"
echo

# ─── SETUP ───
SIGNUP_A=$(curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Pravasi Tours\",\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner A\"}")
if [ "$(echo "$SIGNUP_A" | jq -r '.tenant.id // empty')" = "" ]; then
  printf '%sSetup signup (tenant A) failed:%s\n' "$RED" "$RESET"
  echo "$SIGNUP_A"
  exit 1
fi
SIGNUP_INVOICE_PREFIX=$(echo "$SIGNUP_A" | jq -r '.tenant.invoice_prefix')
SIGNUP_GST_RATE=$(echo "$SIGNUP_A" | jq -r '.tenant.gst_rate')
if [ "$SIGNUP_INVOICE_PREFIX" = "PRA" ] && [ "$SIGNUP_GST_RATE" = "5" ]; then
  pass "Signup auto-derives invoice_prefix=PRA, gst_rate=5 for 'Pravasi Tours'"
else
  fail "Signup auto-derived prefix/rate" "invoice_prefix='$SIGNUP_INVOICE_PREFIX', gst_rate='$SIGNUP_GST_RATE'"
fi

TENANT_A_ID=$(echo "$SIGNUP_A" | jq -r '.tenant.id')
OWNER_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
if [ -z "$OWNER_A_TOKEN" ]; then
  printf '%sSetup did not yield an owner A token. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

# invoices/trip_sheets both carry FORCE ROW LEVEL SECURITY, so a direct
# psql read (no tenant context) matches zero rows even for the table
# owner's role. Reads that need to see tenant A's own data set the
# session var first, in the same psql invocation, via set_config.
psql_as_tenant_a() {
  psql "${DATABASE_URL:-}" -tAc "SELECT set_config('app.current_tenant_id', '$TENANT_A_ID', false); $1" 2>/dev/null | tail -1 | tr -d '[:space:]'
}

curl -s -X PATCH "$BASE_URL/settings/business" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H "Content-Type: application/json" -d '{"state_code":"KA","trip_sheet_prefix":"PRA"}' > /dev/null

CREATE_ACCT=$(curl -s -X POST "$BASE_URL/users" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ACCT_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Accountant A\",\"role\":\"accountant\"}")
ACCT_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ACCT_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
if [ "$(echo "$CREATE_ACCT" | jq -r '.user.id // empty')" = "" ] || [ -z "$ACCT_A_TOKEN" ]; then
  printf '%sSetup could not create/login accountant A. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

CREATE_STAFF=$(curl -s -X POST "$BASE_URL/users" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$STAFF_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Staff A\",\"role\":\"staff\"}")
STAFF_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$STAFF_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
if [ "$(echo "$CREATE_STAFF" | jq -r '.user.id // empty')" = "" ] || [ -z "$STAFF_A_TOKEN" ]; then
  printf '%sSetup could not create/login staff A. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

CREATE_VIEWER=$(curl -s -X POST "$BASE_URL/users" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$VIEWER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Viewer A\",\"role\":\"viewer\"}")
VIEWER_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$VIEWER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
if [ "$(echo "$CREATE_VIEWER" | jq -r '.user.id // empty')" = "" ] || [ -z "$VIEWER_A_TOKEN" ]; then
  printf '%sSetup could not create/login viewer A. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

SIGNUP_B=$(curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Invoice Picker Co B\",\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner B\"}")
if [ "$(echo "$SIGNUP_B" | jq -r '.tenant.id // empty')" = "" ]; then
  printf '%sSetup signup (tenant B) failed:%s\n' "$RED" "$RESET"
  exit 1
fi
OWNER_B_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')

VEH_K=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA01PK1111","vehicle_type":"KIA_CARNIVAL","make_model":"KIA Carnival","seating_capacity":7}' | jq -r '.vehicle.id // empty')
VEH_S=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA01PK2222","vehicle_type":"SEDAN","make_model":"Honda City"}' | jq -r '.vehicle.id // empty')
VEH_U=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA01PK3333","vehicle_type":"SUV","make_model":"Toyota Fortuner"}' | jq -r '.vehicle.id // empty')
VEH_U_NUMBER="KA01PK3333"

CUST_A=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"Acme Logistics","gstin":"29ABCDE1234F1Z5","credit_days":15}' | jq -r '.customer.id // empty')
CUST_S=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"SunTravels","gstin":"29FGHIJ5678K1Z6","credit_days":30}' | jq -r '.customer.id // empty')
CUST_B2C=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2C","name":"Ramesh Iyer","phone":"9876512345","state_code":"KA"}' | jq -r '.customer.id // empty')

DRV=$(curl -s -X POST "$BASE_URL/drivers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"full_name":"Muralidhar","phone":"9686847064"}' | jq -r '.driver.id // empty')

RULE_LOCAL_SEDAN=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"LOCAL_PACKAGE","vehicle_type":"SEDAN","label":"SEDAN 8H/80KM","base_hours":8,"base_km":80,"base_price_rupees":2200,"extra_km_rate_rupees":14,"extra_hr_rate_rupees":180,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')
RULE_LOCAL_SUV=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"LOCAL_PACKAGE","vehicle_type":"SUV","label":"SUV 8H/80KM","base_hours":8,"base_km":80,"base_price_rupees":2800,"extra_km_rate_rupees":18,"extra_hr_rate_rupees":220,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')
RULE_OUTSTATION_KIA=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"OUTSTATION_SLAB","vehicle_type":"KIA_CARNIVAL","label":"KIA Cauvery Slab","slab_rate_rupees":50,"min_km_per_day":250,"driver_batta_per_day_rupees":960,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')
RULE_PERF_SEDAN=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"PERFORMANCE","vehicle_type":"SEDAN","label":"SEDAN Perf","per_km_rate_rupees":14,"performance_batta_rupees":300,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')

if [ -z "$VEH_K" ] || [ -z "$VEH_S" ] || [ -z "$VEH_U" ] || [ -z "$CUST_A" ] || [ -z "$CUST_S" ] || [ -z "$CUST_B2C" ] || \
   [ -z "$RULE_LOCAL_SEDAN" ] || [ -z "$RULE_LOCAL_SUV" ] || [ -z "$RULE_OUTSTATION_KIA" ] || [ -z "$RULE_PERF_SEDAN" ]; then
  printf '%sSetup did not yield all required fixtures. Aborting.%s\n' "$RED" "$RESET"
  echo "VEH_K=$VEH_K VEH_S=$VEH_S VEH_U=$VEH_U CUST_A=$CUST_A CUST_S=$CUST_S CUST_B2C=$CUST_B2C"
  exit 1
fi

# ─── Trips ───
# T1: OUTSTATION/GST, KIA, CUST_A, 1699km/5days, fasttag 2440r (Cauvery ref)
T1=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_A\",\"vehicle_id\":\"$VEH_K\",\"trip_date\":\"$DAYS_AGO_10\",\"total_km\":1699,\"total_hours\":0,\"total_days\":5,\"fasttag_rupees\":2440}" | jq -r '.trip.id // empty')
# T2: LOCAL/GST, SEDAN, CUST_A, 217km/12h, toll 100r
T2=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_A\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$DAYS_AGO_8\",\"total_km\":217,\"total_hours\":12,\"toll_rupees\":100}" | jq -r '.trip.id // empty')
# T3: LOCAL/GST, SUV, CUST_A, 300km/14h, toll 200r
T3=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_A\",\"vehicle_id\":\"$VEH_U\",\"trip_date\":\"$DAYS_AGO_6\",\"total_km\":300,\"total_hours\":14,\"toll_rupees\":200}" | jq -r '.trip.id // empty')
# T4: OUTSTATION/GST, KIA, CUST_A, 800km/2days, fasttag 500r, parking 150r
T4=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_A\",\"vehicle_id\":\"$VEH_K\",\"trip_date\":\"$DAYS_AGO_4\",\"total_km\":800,\"total_hours\":0,\"total_days\":2,\"fasttag_rupees\":500,\"parking_rupees\":150}" | jq -r '.trip.id // empty')
# T5: LOCAL/GST, SEDAN, CUST_S, 150km/10h
T5=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_S\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$DAYS_AGO_5\",\"total_km\":150,\"total_hours\":10}" | jq -r '.trip.id // empty')
# T6: OUTSTATION/GST, KIA, CUST_S, 1000km/3days, fasttag 800r
T6=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_S\",\"vehicle_id\":\"$VEH_K\",\"trip_date\":\"$DAYS_AGO_3\",\"total_km\":1000,\"total_hours\":0,\"total_days\":3,\"fasttag_rupees\":800}" | jq -r '.trip.id // empty')
# T7: LOCAL/GST, SEDAN, CUST_B2C, 100km/8h
T7=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_B2C\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$YESTERDAY\",\"total_km\":100,\"total_hours\":8}" | jq -r '.trip.id // empty')
# T8: LOCAL/GST, SEDAN, CUST_A, 50km/4h -> stays DRAFT
T8=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_A\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$YESTERDAY\",\"total_km\":50,\"total_hours\":4}" | jq -r '.trip.id // empty')
# T9: LOCAL/PERF, SEDAN, CUST_A, 300km/8h (Blue UI ref)
T9=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"PERFORMANCE\",\"customer_id\":\"$CUST_A\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$DAYS_AGO_2\",\"total_km\":300,\"total_hours\":8}" | jq -r '.trip.id // empty')
# T10: LOCAL/GST, SEDAN, CUST_A, 80km/8h -> finalize -> cancel
T10=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_A\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$DAYS_AGO_2\",\"total_km\":80,\"total_hours\":8,\"toll_rupees\":0}" | jq -r '.trip.id // empty')

if [ -z "$T1" ] || [ -z "$T2" ] || [ -z "$T3" ] || [ -z "$T4" ] || [ -z "$T5" ] || [ -z "$T6" ] || [ -z "$T7" ] || [ -z "$T8" ] || [ -z "$T9" ] || [ -z "$T10" ]; then
  printf '%sSetup did not create all trips. Aborting.%s\n' "$RED" "$RESET"
  echo "T1=$T1 T2=$T2 T3=$T3 T4=$T4 T5=$T5 T6=$T6 T7=$T7 T8=$T8 T9=$T9 T10=$T10"
  exit 1
fi

for t in "$T1" "$T2" "$T3" "$T4" "$T5" "$T6" "$T7" "$T9" "$T10"; do
  curl -s -X POST "$BASE_URL/trips/$t/finalize" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
done
# T8 deliberately stays DRAFT (never finalized).
curl -s -X POST "$BASE_URL/trips/$T10/cancel" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"duplicate booking"}' > /dev/null

echo "Setup: tenant A (owner+accountant+staff+viewer), tenant B (owner), KIA+SEDAN+SUV vehicles, 3 customers, 1 driver, 4 pricing rules, 10 trips (T8 DRAFT, T10 CANCELLED, rest FINALIZED)"
echo "CUST_A invoiceable: T1, T2, T3, T4, T9 (5 trips) — T8 excluded (DRAFT), T10 excluded (CANCELLED)"
echo

echo "Checks"
echo "------"

# ─── Step 1: Picker returns 5 invoiceable trips for CUST_A, grouped ───
PICK1=$(curl -s "$BASE_URL/customers/$CUST_A/invoiceable-trips" -H "Authorization: Bearer $ACCT_A_TOKEN")
STEP1_REASONS=()
[ "$(echo "$PICK1" | jq -r '.customer.id')" = "$CUST_A" ] || STEP1_REASONS+=("customer.id mismatch")
[ "$(echo "$PICK1" | jq -r '.customer.company_name')" = "Acme Logistics" ] || STEP1_REASONS+=("customer.company_name mismatch")
[ "$(echo "$PICK1" | jq -r '.customer.customer_type')" = "B2B" ] || STEP1_REASONS+=("customer.customer_type != B2B")
[ "$(echo "$PICK1" | jq '.groups.LOCAL.trips | length')" = "3" ] || STEP1_REASONS+=("groups.LOCAL.trips.length != 3")
[ "$(echo "$PICK1" | jq '.groups.OUTSTATION.trips | length')" = "2" ] || STEP1_REASONS+=("groups.OUTSTATION.trips.length != 2")
[ "$(echo "$PICK1" | jq -r '.total_summary.count')" = "5" ] || STEP1_REASONS+=("total_summary.count != 5")
# Self-consistency: summary fields must equal the sum of the individual
# trip rows in the SAME response (see top-of-file note).
SELF_KM=$(echo "$PICK1" | jq '(.total_summary.total_km) == ([.groups.LOCAL.trips[], .groups.OUTSTATION.trips[]] | map(.total_km) | add)')
SELF_SUBTOTAL=$(echo "$PICK1" | jq '(.total_summary.total_subtotal_paise) == ([.groups.LOCAL.trips[], .groups.OUTSTATION.trips[]] | map(.subtotal_paise) | add)')
SELF_GROSS=$(echo "$PICK1" | jq '(.total_summary.total_gross_paise) == ([.groups.LOCAL.trips[], .groups.OUTSTATION.trips[]] | map(.gross_paise) | add)')
SELF_NET=$(echo "$PICK1" | jq '(.total_summary.total_net_payable_paise) == ([.groups.LOCAL.trips[], .groups.OUTSTATION.trips[]] | map(.net_payable_paise) | add)')
[ "$SELF_KM" = "true" ] || STEP1_REASONS+=("total_summary.total_km doesn't match sum of trip rows")
[ "$SELF_SUBTOTAL" = "true" ] || STEP1_REASONS+=("total_summary.total_subtotal_paise doesn't match sum of trip rows")
[ "$SELF_GROSS" = "true" ] || STEP1_REASONS+=("total_summary.total_gross_paise doesn't match sum of trip rows")
[ "$SELF_NET" = "true" ] || STEP1_REASONS+=("total_summary.total_net_payable_paise doesn't match sum of trip rows")
[ "$(echo "$PICK1" | jq -r '.total_summary.total_km')" = "3316" ] || STEP1_REASONS+=("total_summary.total_km != 3316, got $(echo "$PICK1" | jq -r '.total_summary.total_km')")

if [ ${#STEP1_REASONS[@]} -eq 0 ]; then
  pass "Picker returns 5 invoiceable trips for CUST_A: 3 LOCAL (T2,T3,T9) + 2 OUTSTATION (T1,T4), summaries self-consistent"
else
  fail "Picker basic shape (Step 1)" "$(IFS='; '; echo "${STEP1_REASONS[*]}")"
fi

# ─── Step 2: chronological ASC ordering per group ───
STEP2_REASONS=()
[ "$(echo "$PICK1" | jq -r '.groups.LOCAL.trips[0].id')" = "$T2" ] || STEP2_REASONS+=("LOCAL[0] != T2")
[ "$(echo "$PICK1" | jq -r '.groups.LOCAL.trips[1].id')" = "$T3" ] || STEP2_REASONS+=("LOCAL[1] != T3")
[ "$(echo "$PICK1" | jq -r '.groups.LOCAL.trips[2].id')" = "$T9" ] || STEP2_REASONS+=("LOCAL[2] != T9")
[ "$(echo "$PICK1" | jq -r '.groups.OUTSTATION.trips[0].id')" = "$T1" ] || STEP2_REASONS+=("OUTSTATION[0] != T1")
[ "$(echo "$PICK1" | jq -r '.groups.OUTSTATION.trips[1].id')" = "$T4" ] || STEP2_REASONS+=("OUTSTATION[1] != T4")

if [ ${#STEP2_REASONS[@]} -eq 0 ]; then
  pass "Trips sorted chronologically ascending within each group"
else
  fail "Chronological ordering (Step 2)" "$(IFS='; '; echo "${STEP2_REASONS[*]}")"
fi

# ─── Step 3: DRAFT trip excluded ───
HAS_T8=$(echo "$PICK1" | jq --arg id "$T8" '[.groups.LOCAL.trips[], .groups.OUTSTATION.trips[]] | any(.id == $id)')
if [ "$HAS_T8" = "false" ]; then
  pass "DRAFT trip T8 excluded from picker"
else
  fail "DRAFT trip excluded (Step 3)" "T8 unexpectedly appeared"
fi

# ─── Step 4: CANCELLED trip excluded ───
HAS_T10=$(echo "$PICK1" | jq --arg id "$T10" '[.groups.LOCAL.trips[], .groups.OUTSTATION.trips[]] | any(.id == $id)')
if [ "$HAS_T10" = "false" ]; then
  pass "CANCELLED trip T10 excluded from picker"
else
  fail "CANCELLED trip excluded (Step 4)" "T10 unexpectedly appeared"
fi

# ─── Step 5: different customer isolation (CUST_S) ───
PICK5=$(curl -s "$BASE_URL/customers/$CUST_S/invoiceable-trips" -H "Authorization: Bearer $ACCT_A_TOKEN")
STEP5_COUNT=$(echo "$PICK5" | jq -r '.total_summary.count')
STEP5_IDS=$(echo "$PICK5" | jq -r '[.groups.LOCAL.trips[].id, .groups.OUTSTATION.trips[].id] | sort | join(",")')
EXPECTED5_IDS=$(printf '%s\n%s' "$T5" "$T6" | sort | tr '\n' ',' | sed 's/,$//')

if [ "$STEP5_COUNT" = "2" ] && [ "$STEP5_IDS" = "$EXPECTED5_IDS" ]; then
  pass "Different customer (CUST_S) picker isolation: total 2 (T5, T6)"
else
  fail "Customer isolation (Step 5)" "count '$STEP5_COUNT', ids '$STEP5_IDS'"
fi

# ─── Step 6: B2C customer picker ───
PICK6=$(curl -s "$BASE_URL/customers/$CUST_B2C/invoiceable-trips" -H "Authorization: Bearer $ACCT_A_TOKEN")
STEP6_COUNT=$(echo "$PICK6" | jq -r '.total_summary.count')
STEP6_TYPE=$(echo "$PICK6" | jq -r '.customer.customer_type')
STEP6_GSTIN=$(echo "$PICK6" | jq -r '.customer.gstin')

if [ "$STEP6_COUNT" = "1" ] && [ "$STEP6_TYPE" = "B2C" ] && { [ "$STEP6_GSTIN" = "null" ] || [ -z "$STEP6_GSTIN" ]; }; then
  pass "B2C customer (CUST_B2C) picker works: total 1 (T7), customer_type=B2C, gstin=null"
else
  fail "B2C picker (Step 6)" "count '$STEP6_COUNT', type '$STEP6_TYPE', gstin '$STEP6_GSTIN'"
fi

# ─── Step 7: nonexistent customer -> 404 ───
STEP7_STATUS=$(curl -s -o "$WORK_DIR/step7.json" -w '%{http_code}' "$BASE_URL/customers/00000000-0000-4000-8000-000000000000/invoiceable-trips" -H "Authorization: Bearer $ACCT_A_TOKEN")
STEP7_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step7.json")

if [ "$STEP7_STATUS" = "404" ] && [ "$STEP7_CODE" = "CUSTOMER_NOT_FOUND" ]; then
  pass "Nonexistent customer: 404 CUSTOMER_NOT_FOUND"
else
  fail "Nonexistent customer (Step 7)" "status '$STEP7_STATUS', code '$STEP7_CODE'"
fi

# ─── Step 8: cross-tenant customer -> 404 ───
STEP8_STATUS=$(curl -s -o "$WORK_DIR/step8.json" -w '%{http_code}' "$BASE_URL/customers/$CUST_A/invoiceable-trips" -H "Authorization: Bearer $OWNER_B_TOKEN")
STEP8_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step8.json")

if [ "$STEP8_STATUS" = "404" ] && [ "$STEP8_CODE" = "CUSTOMER_NOT_FOUND" ]; then
  pass "Cross-tenant customer: 404 CUSTOMER_NOT_FOUND (tenant B can't see tenant A's customer)"
else
  fail "Cross-tenant customer (Step 8)" "status '$STEP8_STATUS', code '$STEP8_CODE'"
fi

# ─── Step 9: viewer without invoices:draft -> 403 ───
STEP9_STATUS=$(curl -s -o "$WORK_DIR/step9.json" -w '%{http_code}' "$BASE_URL/customers/$CUST_A/invoiceable-trips" -H "Authorization: Bearer $VIEWER_A_TOKEN")
STEP9_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step9.json")
STEP9_REQUIRED=$(jq -r '.error.details.required // empty' "$WORK_DIR/step9.json")

if [ "$STEP9_STATUS" = "403" ] && [ "$STEP9_CODE" = "FORBIDDEN" ] && [ "$STEP9_REQUIRED" = "invoices:draft" ]; then
  pass "Viewer lacks invoices:draft: 403 FORBIDDEN (required=invoices:draft)"
else
  fail "Viewer forbidden (Step 9)" "status '$STEP9_STATUS', code '$STEP9_CODE', required '$STEP9_REQUIRED'"
fi

# ─── Step 10: Cauvery-style Tax Invoice with auto-sum ───
INV10_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_A\",\"trip_sheet_ids\":[\"$T1\"]}")
INV_CAUVERY=$(echo "$INV10_RESP" | jq -r '.invoice.id // empty')

STEP10_REASONS=()
[ "$(echo "$INV10_RESP" | jq -r '.invoice.toll_paise')" = "0" ] || STEP10_REASONS+=("toll_paise != 0")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.parking_paise')" = "0" ] || STEP10_REASONS+=("parking_paise != 0")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.permit_paise')" = "0" ] || STEP10_REASONS+=("permit_paise != 0")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.fasttag_paise')" = "244000" ] || STEP10_REASONS+=("fasttag_paise != 244000")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.toll_manual_override')" = "false" ] || STEP10_REASONS+=("toll_manual_override != false")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.parking_manual_override')" = "false" ] || STEP10_REASONS+=("parking_manual_override != false")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.permit_manual_override')" = "false" ] || STEP10_REASONS+=("permit_manual_override != false")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.fasttag_manual_override')" = "false" ] || STEP10_REASONS+=("fasttag_manual_override != false")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.subtotal_paise')" = "8975000" ] || STEP10_REASONS+=("subtotal_paise != 8975000")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.total_gst_paise')" = "448750" ] || STEP10_REASONS+=("total_gst_paise != 448750")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.cgst_paise')" = "224375" ] || STEP10_REASONS+=("cgst_paise != 224375")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.sgst_paise')" = "224375" ] || STEP10_REASONS+=("sgst_paise != 224375")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.grand_total_paise')" = "9667750" ] || STEP10_REASONS+=("grand_total_paise != 9667750")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.net_payable_paise')" = "9667800" ] || STEP10_REASONS+=("net_payable_paise != 9667800")

if [ -n "$INV_CAUVERY" ] && [ ${#STEP10_REASONS[@]} -eq 0 ]; then
  pass "Cauvery-style TAX invoice from T1: fasttag auto-summed ₹2,440, subtotal ₹89,750, GST ₹4,487.50, net payable ₹96,678"
else
  fail "Cauvery auto-sum invoice (Step 10)" "$(IFS='; '; echo "${STEP10_REASONS[*]}") -- resp: $INV10_RESP"
fi

# ─── Step 11: trip now held -> picker count drops to 4 ───
PICK11=$(curl -s "$BASE_URL/customers/$CUST_A/invoiceable-trips" -H "Authorization: Bearer $ACCT_A_TOKEN")
STEP11_COUNT=$(echo "$PICK11" | jq -r '.total_summary.count')

if [ "$STEP11_COUNT" = "4" ]; then
  pass "Picker count drops to 4 after T1 is held by INV_CAUVERY"
else
  fail "Picker reflects hold (Step 11)" "expected count 4, got '$STEP11_COUNT'"
fi

# ─── Step 12: picker with invoice_id includes held trip ───
PICK12=$(curl -s "$BASE_URL/customers/$CUST_A/invoiceable-trips?invoice_id=$INV_CAUVERY" -H "Authorization: Bearer $ACCT_A_TOKEN")
STEP12_COUNT=$(echo "$PICK12" | jq -r '.total_summary.count')
STEP12_HAS_T1=$(echo "$PICK12" | jq --arg id "$T1" '[.groups.LOCAL.trips[], .groups.OUTSTATION.trips[]] | any(.id == $id)')

if [ "$STEP12_COUNT" = "5" ] && [ "$STEP12_HAS_T1" = "true" ]; then
  pass "Picker with invoice_id=INV_CAUVERY reincludes T1: count back to 5"
else
  fail "Picker invoice_id escape hatch (Step 12)" "count '$STEP12_COUNT', has T1 '$STEP12_HAS_T1'"
fi

# ─── Step 13: PATCH swap trip set — auto-sum recomputes ───
PATCH13_RESP=$(curl -s -X PATCH "$BASE_URL/invoices/$INV_CAUVERY" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"trip_sheet_ids\":[\"$T4\"]}")
STEP13_REASONS=()
[ "$(echo "$PATCH13_RESP" | jq -r '.invoice.fasttag_paise')" = "50000" ] || STEP13_REASONS+=("fasttag_paise != 50000, got $(echo "$PATCH13_RESP" | jq -r '.invoice.fasttag_paise')")
[ "$(echo "$PATCH13_RESP" | jq -r '.invoice.parking_paise')" = "15000" ] || STEP13_REASONS+=("parking_paise != 15000")
[ "$(echo "$PATCH13_RESP" | jq -r '.invoice.toll_paise')" = "0" ] || STEP13_REASONS+=("toll_paise != 0")
[ "$(echo "$PATCH13_RESP" | jq -r '.invoice.fasttag_manual_override')" = "false" ] || STEP13_REASONS+=("fasttag_manual_override != false")
[ "$(echo "$PATCH13_RESP" | jq -r '.invoice.parking_manual_override')" = "false" ] || STEP13_REASONS+=("parking_manual_override != false")
[ "$(echo "$PATCH13_RESP" | jq -r '.invoice.subtotal_paise')" = "4192000" ] || STEP13_REASONS+=("subtotal_paise != 4192000, got $(echo "$PATCH13_RESP" | jq -r '.invoice.subtotal_paise')")
[ "$(echo "$PATCH13_RESP" | jq -r '.invoice.grand_total_paise')" = "4466600" ] || STEP13_REASONS+=("grand_total_paise != 4466600")

if [ ${#STEP13_REASONS[@]} -eq 0 ]; then
  pass "PATCH swap trip set to [T4]: fasttag auto-sums to ₹500, parking to ₹150, toll to ₹0"
else
  fail "PATCH trip-set swap auto-sum (Step 13)" "$(IFS='; '; echo "${STEP13_REASONS[*]}")"
fi

# ─── Step 14: PATCH explicit reimbursement — override sticks ───
PATCH14_RESP=$(curl -s -X PATCH "$BASE_URL/invoices/$INV_CAUVERY" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"fasttag_rupees":999}')
STEP14_REASONS=()
[ "$(echo "$PATCH14_RESP" | jq -r '.invoice.fasttag_paise')" = "99900" ] || STEP14_REASONS+=("fasttag_paise != 99900")
[ "$(echo "$PATCH14_RESP" | jq -r '.invoice.fasttag_manual_override')" = "true" ] || STEP14_REASONS+=("fasttag_manual_override != true")
[ "$(echo "$PATCH14_RESP" | jq -r '.invoice.parking_paise')" = "15000" ] || STEP14_REASONS+=("parking_paise != 15000 (should stay auto-summed)")
[ "$(echo "$PATCH14_RESP" | jq -r '.invoice.parking_manual_override')" = "false" ] || STEP14_REASONS+=("parking_manual_override != false")

if [ ${#STEP14_REASONS[@]} -eq 0 ]; then
  pass "PATCH fasttag_rupees=999 explicit: fasttag_manual_override -> true, parking untouched (still auto)"
else
  fail "Explicit override sticks (Step 14)" "$(IFS='; '; echo "${STEP14_REASONS[*]}")"
fi

# ─── Step 15: PATCH trip set after manual override — override persists, auto field re-sums ───
PATCH15_RESP=$(curl -s -X PATCH "$BASE_URL/invoices/$INV_CAUVERY" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"trip_sheet_ids\":[\"$T1\"]}")
STEP15_REASONS=()
[ "$(echo "$PATCH15_RESP" | jq -r '.invoice.fasttag_paise')" = "99900" ] || STEP15_REASONS+=("fasttag_paise != 99900 (manual override should survive trip-set change)")
[ "$(echo "$PATCH15_RESP" | jq -r '.invoice.fasttag_manual_override')" = "true" ] || STEP15_REASONS+=("fasttag_manual_override != true")
[ "$(echo "$PATCH15_RESP" | jq -r '.invoice.parking_paise')" = "0" ] || STEP15_REASONS+=("parking_paise != 0 (T1 has no parking, should re-auto-sum)")
[ "$(echo "$PATCH15_RESP" | jq -r '.invoice.parking_manual_override')" = "false" ] || STEP15_REASONS+=("parking_manual_override != false")
[ "$(echo "$PATCH15_RESP" | jq -r '.invoice.toll_paise')" = "0" ] || STEP15_REASONS+=("toll_paise != 0")

if [ ${#STEP15_REASONS[@]} -eq 0 ]; then
  pass "PATCH trip_sheet_ids back to [T1]: fasttag manual override (₹999) persists, parking re-auto-sums to 0"
else
  fail "Override persists across trip-set change (Step 15)" "$(IFS='; '; echo "${STEP15_REASONS[*]}")"
fi

# ─── Step 16: PATCH explicit zero — treated as override ───
PATCH16_RESP=$(curl -s -X PATCH "$BASE_URL/invoices/$INV_CAUVERY" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"fasttag_rupees":0}')
STEP16_REASONS=()
[ "$(echo "$PATCH16_RESP" | jq -r '.invoice.fasttag_paise')" = "0" ] || STEP16_REASONS+=("fasttag_paise != 0")
[ "$(echo "$PATCH16_RESP" | jq -r '.invoice.fasttag_manual_override')" = "true" ] || STEP16_REASONS+=("fasttag_manual_override != true (explicit 0 is still an override)")

if [ ${#STEP16_REASONS[@]} -eq 0 ]; then
  pass "PATCH fasttag_rupees=0 explicit: fasttag_paise=0 AND manual_override stays true (0 is a choice, not 'unset')"
else
  fail "Explicit zero is an override (Step 16)" "$(IFS='; '; echo "${STEP16_REASONS[*]}")"
fi

# ─── Step 17: multi-trip aggregation with mixed service_types ───
curl -s -X DELETE "$BASE_URL/invoices/$INV_CAUVERY" -H "Authorization: Bearer $ACCT_A_TOKEN" > /dev/null

INV17_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_A\",\"trip_sheet_ids\":[\"$T1\",\"$T2\",\"$T3\",\"$T4\"]}")
INV_MULTI=$(echo "$INV17_RESP" | jq -r '.invoice.id // empty')

STEP17_REASONS=()
[ "$(echo "$INV17_RESP" | jq '.invoice.lines | length')" = "4" ] || STEP17_REASONS+=("lines.length != 4")
[ "$(echo "$INV17_RESP" | jq -r '.invoice.lines[0].trip_sheet_id')" = "$T1" ] || STEP17_REASONS+=("lines[0] != T1")
[ "$(echo "$INV17_RESP" | jq -r '.invoice.lines[1].trip_sheet_id')" = "$T2" ] || STEP17_REASONS+=("lines[1] != T2")
[ "$(echo "$INV17_RESP" | jq -r '.invoice.lines[2].trip_sheet_id')" = "$T3" ] || STEP17_REASONS+=("lines[2] != T3")
[ "$(echo "$INV17_RESP" | jq -r '.invoice.lines[3].trip_sheet_id')" = "$T4" ] || STEP17_REASONS+=("lines[3] != T4")
[ "$(echo "$INV17_RESP" | jq -r '.invoice.fasttag_paise')" = "294000" ] || STEP17_REASONS+=("fasttag_paise != 294000, got $(echo "$INV17_RESP" | jq -r '.invoice.fasttag_paise')")
[ "$(echo "$INV17_RESP" | jq -r '.invoice.parking_paise')" = "15000" ] || STEP17_REASONS+=("parking_paise != 15000")
[ "$(echo "$INV17_RESP" | jq -r '.invoice.toll_paise')" = "30000" ] || STEP17_REASONS+=("toll_paise != 30000, got $(echo "$INV17_RESP" | jq -r '.invoice.toll_paise')")
[ "$(echo "$INV17_RESP" | jq -r '.invoice.permit_paise')" = "0" ] || STEP17_REASONS+=("permit_paise != 0")
STEP17_SUM_LINES=$(echo "$INV17_RESP" | jq '[.invoice.lines[].line_amount_paise] | add')
STEP17_SUBTOTAL=$(echo "$INV17_RESP" | jq -r '.invoice.subtotal_paise')
[ "$STEP17_SUM_LINES" = "$STEP17_SUBTOTAL" ] || STEP17_REASONS+=("subtotal_paise ($STEP17_SUBTOTAL) != sum(lines.line_amount_paise) ($STEP17_SUM_LINES)")

if [ -n "$INV_MULTI" ] && [ ${#STEP17_REASONS[@]} -eq 0 ]; then
  pass "Multi-trip TAX invoice [T1,T2,T3,T4]: 4 lines in input order, fasttag ₹2,940 (T1+T4), parking ₹150 (T4), toll ₹300 (T2+T3)"
else
  fail "Multi-trip mixed-service aggregation (Step 17)" "$(IFS='; '; echo "${STEP17_REASONS[*]}") -- resp: $INV17_RESP"
fi

# ─── Step 18: line description auto-generated on create ───
LOCAL_DATE_T3=$(date -j -f "%Y-%m-%d" "$DAYS_AGO_6" "+%d-%b-%Y" 2>/dev/null)
STEP18_REASONS=()
STEP18_SUV_DESC=$(echo "$INV17_RESP" | jq -r --arg id "$T3" '.invoice.lines[] | select(.trip_sheet_id == $id) | .description')
echo "$STEP18_SUV_DESC" | grep -q "^SUV $VEH_U_NUMBER - 300 km local trip on $LOCAL_DATE_T3\$" || STEP18_REASONS+=("SUV line description mismatch: '$STEP18_SUV_DESC'")
ALL_NONEMPTY=$(echo "$INV17_RESP" | jq '[.invoice.lines[].description] | all(length > 0)')
[ "$ALL_NONEMPTY" = "true" ] || STEP18_REASONS+=("some line has an empty description")

if [ ${#STEP18_REASONS[@]} -eq 0 ]; then
  pass "Line descriptions auto-generated: every line non-empty, SUV line matches expected pattern"
else
  fail "Auto-generated descriptions (Step 18)" "$(IFS='; '; echo "${STEP18_REASONS[*]}")"
fi

# ─── Step 19: edit line description ───
LINE_1_ID=$(echo "$INV17_RESP" | jq -r '.invoice.lines[0].id')
PATCH19_RESP=$(curl -s -X PATCH "$BASE_URL/invoices/$INV_MULTI/lines/$LINE_1_ID" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"description":"Airport transfer for CEO visit"}')
STEP19_DESC=$(echo "$PATCH19_RESP" | jq -r '.line.description')

GET19=$(curl -s "$BASE_URL/invoices/$INV_MULTI" -H "Authorization: Bearer $ACCT_A_TOKEN")
STEP19_OTHER_UNCHANGED=$(echo "$GET19" | jq --arg id "$T2" '[.invoice.lines[] | select(.trip_sheet_id == $id) | .description][0] | length > 0')

if [ "$STEP19_DESC" = "Airport transfer for CEO visit" ] && [ "$STEP19_OTHER_UNCHANGED" = "true" ]; then
  pass "PATCH line description updates line 1 only, other lines unchanged"
else
  fail "Edit line description (Step 19)" "desc '$STEP19_DESC', other line intact '$STEP19_OTHER_UNCHANGED'"
fi

# ─── Step 20: empty (whitespace) description rejected ───
STEP20_STATUS=$(curl -s -o "$WORK_DIR/step20.json" -w '%{http_code}' -X PATCH "$BASE_URL/invoices/$INV_MULTI/lines/$LINE_1_ID" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"description":"   "}')
STEP20_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step20.json")

if [ "$STEP20_STATUS" = "400" ] && [ "$STEP20_CODE" = "VALIDATION_ERROR" ]; then
  pass "Whitespace-only description: 400 VALIDATION_ERROR"
else
  fail "Empty description rejected (Step 20)" "status '$STEP20_STATUS', code '$STEP20_CODE'"
fi

# ─── Step 21: line edit on ISSUED invoice (direct psql, test-only) ───
psql "${DATABASE_URL:-}" -c "SELECT set_config('app.current_tenant_id', '$TENANT_A_ID', false); UPDATE invoices SET status = 'ISSUED'::invoice_status_enum WHERE id = '$INV_MULTI';" > /dev/null 2>&1

STEP21_STATUS=$(curl -s -o "$WORK_DIR/step21.json" -w '%{http_code}' -X PATCH "$BASE_URL/invoices/$INV_MULTI/lines/$LINE_1_ID" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"description":"x"}')
STEP21_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step21.json")

psql "${DATABASE_URL:-}" -c "SELECT set_config('app.current_tenant_id', '$TENANT_A_ID', false); UPDATE invoices SET status = 'DRAFT'::invoice_status_enum WHERE id = '$INV_MULTI';" > /dev/null 2>&1

if [ "$STEP21_STATUS" = "409" ] && [ "$STEP21_CODE" = "INVOICE_NOT_EDITABLE" ]; then
  pass "Line edit on ISSUED invoice: 409 INVOICE_NOT_EDITABLE"
else
  fail "Line edit non-DRAFT guard (Step 21)" "status '$STEP21_STATUS', code '$STEP21_CODE'"
fi

# ─── Step 22: line PATCH on nonexistent invoice -> 404 INVOICE_NOT_FOUND ───
STEP22_STATUS=$(curl -s -o "$WORK_DIR/step22.json" -w '%{http_code}' -X PATCH "$BASE_URL/invoices/00000000-0000-4000-8000-000000000000/lines/$LINE_1_ID" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"description":"x"}')
STEP22_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step22.json")

if [ "$STEP22_STATUS" = "404" ] && [ "$STEP22_CODE" = "INVOICE_NOT_FOUND" ]; then
  pass "Line PATCH on nonexistent invoice: 404 INVOICE_NOT_FOUND"
else
  fail "Nonexistent invoice (Step 22)" "status '$STEP22_STATUS', code '$STEP22_CODE'"
fi

# ─── Step 23: line PATCH on nonexistent line -> 404 LINE_NOT_FOUND ───
STEP23_STATUS=$(curl -s -o "$WORK_DIR/step23.json" -w '%{http_code}' -X PATCH "$BASE_URL/invoices/$INV_MULTI/lines/00000000-0000-4000-8000-000000000000" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"description":"x"}')
STEP23_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step23.json")

if [ "$STEP23_STATUS" = "404" ] && [ "$STEP23_CODE" = "LINE_NOT_FOUND" ]; then
  pass "Line PATCH on nonexistent line: 404 LINE_NOT_FOUND"
else
  fail "Nonexistent line (Step 23)" "status '$STEP23_STATUS', code '$STEP23_CODE'"
fi

# ─── Step 24: line PATCH cross-tenant -> 404 ───
STEP24_STATUS=$(curl -s -o "$WORK_DIR/step24.json" -w '%{http_code}' -X PATCH "$BASE_URL/invoices/$INV_MULTI/lines/$LINE_1_ID" -H "Authorization: Bearer $OWNER_B_TOKEN" -H "Content-Type: application/json" \
  -d '{"description":"x"}')
STEP24_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step24.json")

if [ "$STEP24_STATUS" = "404" ] && [ "$STEP24_CODE" = "INVOICE_NOT_FOUND" ]; then
  pass "Line PATCH cross-tenant: 404 INVOICE_NOT_FOUND (RLS-scoped parent lookup)"
else
  fail "Cross-tenant line PATCH (Step 24)" "status '$STEP24_STATUS', code '$STEP24_CODE'"
fi

# ─── Step 25: line PATCH by viewer -> 403 ───
STEP25_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE_URL/invoices/$INV_MULTI/lines/$LINE_1_ID" -H "Authorization: Bearer $VIEWER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"description":"x"}')

if [ "$STEP25_STATUS" = "403" ]; then
  pass "Line PATCH by viewer: 403 FORBIDDEN"
else
  fail "Viewer forbidden on line PATCH (Step 25)" "got '$STEP25_STATUS'"
fi

# ─── Step 26: DB-layer RLS on invoices (including new override columns) ───
DB26_COUNT=$(psql "${DATABASE_URL:-}" -tAc "SELECT COUNT(*) FROM invoices;" 2>/dev/null | tr -d '[:space:]')

if [ "$DB26_COUNT" = "0" ]; then
  pass "DB-layer isolation: direct psql with no tenant context set sees 0 invoice rows"
else
  fail "DB-layer isolation (Step 26)" "expected 0, got '$DB26_COUNT'"
fi

# ─── Step 27: regression — pre-4.2 draft behavior (zero reimbursements, flags default false) ───
INV27_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_S\",\"trip_sheet_ids\":[\"$T5\"]}")
STEP27_REASONS=()
[ "$(echo "$INV27_RESP" | jq -r '.invoice.toll_paise')" = "0" ] || STEP27_REASONS+=("toll_paise != 0")
[ "$(echo "$INV27_RESP" | jq -r '.invoice.parking_paise')" = "0" ] || STEP27_REASONS+=("parking_paise != 0")
[ "$(echo "$INV27_RESP" | jq -r '.invoice.permit_paise')" = "0" ] || STEP27_REASONS+=("permit_paise != 0")
[ "$(echo "$INV27_RESP" | jq -r '.invoice.fasttag_paise')" = "0" ] || STEP27_REASONS+=("fasttag_paise != 0")
[ "$(echo "$INV27_RESP" | jq -r '.invoice.toll_manual_override')" = "false" ] || STEP27_REASONS+=("toll_manual_override != false")
[ "$(echo "$INV27_RESP" | jq -r '.invoice.parking_manual_override')" = "false" ] || STEP27_REASONS+=("parking_manual_override != false")
[ "$(echo "$INV27_RESP" | jq -r '.invoice.permit_manual_override')" = "false" ] || STEP27_REASONS+=("permit_manual_override != false")
[ "$(echo "$INV27_RESP" | jq -r '.invoice.fasttag_manual_override')" = "false" ] || STEP27_REASONS+=("fasttag_manual_override != false")

if [ ${#STEP27_REASONS[@]} -eq 0 ]; then
  pass "Regression: plain invoice draft (T5, no reimbursements) has all four manual_override flags false, auto-sum from zero"
else
  fail "Pre-4.2 baseline regression (Step 27)" "$(IFS='; '; echo "${STEP27_REASONS[*]}")"
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
  echo "Tenant A accountant: $ACCT_A_EMAIL"
  echo "Tenant A staff: $STAFF_A_EMAIL"
  echo "Tenant A viewer: $VIEWER_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 1
else
  printf '%s✓ All %s checks passed. Invoiceable trips picker + reimbursement auto-sum (Task 4.2) is working correctly.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
  echo
  echo "Tenant A owner: $OWNER_A_EMAIL"
  echo "Tenant A accountant: $ACCT_A_EMAIL"
  echo "Tenant A staff: $STAFF_A_EMAIL"
  echo "Tenant A viewer: $VIEWER_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 0
fi
