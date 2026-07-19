#!/usr/bin/env bash
#
# End-to-end verification of the Task 4.1 invoice foundation module:
# invoice schema, pure GST domain, DRAFT invoice creation from one or
# more FINALIZED trips, the trip "hold" mechanism, and full CRUD on
# drafts. Reproduces (a corrected version of) the Cauvery ₹92,190
# reference for a Tax Invoice and the Blue UI totals for a Performance
# Invoice. Mirrors scripts/verify-performance-sheet.sh's structure.
# Prints a PASS/FAIL summary and exits 1 if anything failed.
#
# Note on fixture numbers: the Task 4.1 spec's own Part K worked example
# for T1 (an OUTSTATION trip with a ₹2,440 fasttag charge) asserts an
# invoice subtotal that EXCLUDES that fasttag amount, then re-adds the
# identical ₹2,440 as a separate invoice-level charge in the next step.
# That only reconciles if invoice_lines never fold an OUTSTATION trip's
# own parking/permit/fasttag reimbursements into the taxable line total
# (see invoice.service.js's top-of-file comment for the full reasoning —
# those are non-taxable pure-agent reimbursements, not service revenue).
# T3's total_km was also adjusted from the spec's literal "100 km" to a
# within-base-allowance figure so its asserted "line = base only, no
# extras" holds against the SAME LOCAL_PACKAGE rule (base_km=80) used
# for every other LOCAL/GST trip in this fixture, rather than inventing
# a second rule just to make one example's arithmetic work.
#
# Deliberately `set -u` but NOT `set -e`: every check runs even if an
# earlier one fails, so the summary reports everything broken in one pass.
set -u

BASE_URL="http://localhost:8000/api/v1"

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

TEST_PASSWORD="Passw0rd123"
OWNER_A_EMAIL="verify-inv-draft-owner-a-$(date +%s)@example.com"
ACCT_A_EMAIL="verify-inv-draft-acct-a-$(date +%s)-2@example.com"
STAFF_A_EMAIL="verify-inv-draft-staff-a-$(date +%s)-3@example.com"
VIEWER_A_EMAIL="verify-inv-draft-viewer-a-$(date +%s)-4@example.com"
OWNER_B_EMAIL="verify-inv-draft-owner-b-$(date +%s)-5@example.com"

# Rule 8: all trip/invoice dates computed as offsets BACK from today.
days_ago() { date -v-"$1"d +%Y-%m-%d; }
YESTERDAY=$(days_ago 1)
DAYS_AGO_2=$(days_ago 2)
DAYS_AGO_3=$(days_ago 3)
DAYS_AGO_5=$(days_ago 5)
DAYS_AGO_45=$(days_ago 45)
TOMORROW=$(date -v+1d +%Y-%m-%d)

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
TOTAL_CHECKS=32
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

# Part D check: auto-derived invoice/performance prefixes + gst_rate default.
SIGNUP_INVOICE_PREFIX=$(echo "$SIGNUP_A" | jq -r '.tenant.invoice_prefix')
SIGNUP_PERF_PREFIX=$(echo "$SIGNUP_A" | jq -r '.tenant.performance_prefix')
SIGNUP_GST_RATE=$(echo "$SIGNUP_A" | jq -r '.tenant.gst_rate')
if [ "$SIGNUP_INVOICE_PREFIX" = "PRA" ] && [ "$SIGNUP_PERF_PREFIX" = "PRA-PS" ] && [ "$SIGNUP_GST_RATE" = "5" ]; then
  pass "Signup auto-derives invoice_prefix=PRA, performance_prefix=PRA-PS, gst_rate=5 for 'Pravasi Tours'"
else
  fail "Signup auto-derived prefixes" "invoice_prefix='$SIGNUP_INVOICE_PREFIX', performance_prefix='$SIGNUP_PERF_PREFIX', gst_rate='$SIGNUP_GST_RATE'"
fi

TENANT_A_ID=$(echo "$SIGNUP_A" | jq -r '.tenant.id')
OWNER_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
if [ -z "$OWNER_A_TOKEN" ]; then
  printf '%sSetup did not yield an owner A token. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

# trip_sheets/invoices both carry FORCE ROW LEVEL SECURITY, so a direct
# psql read (no tenant context) matches zero rows even for the table
# owner's role — same as every other verify script's DB-layer isolation
# check. Reads that need to see tenant A's own data set the session var
# first, in the same psql invocation, via set_config.
psql_as_tenant_a() {
  psql "${DATABASE_URL:-}" -tAc "SELECT set_config('app.current_tenant_id', '$TENANT_A_ID', false); $1" 2>/dev/null | tail -1 | tr -d '[:space:]'
}

curl -s -X PATCH "$BASE_URL/settings/business" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H "Content-Type: application/json" -d '{"state_code":"KA","trip_sheet_prefix":"IV"}' > /dev/null

CREATE_ACCT=$(curl -s -X POST "$BASE_URL/users" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ACCT_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Accountant A\",\"role\":\"accountant\"}")
ACCT_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ACCT_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
if [ "$(echo "$CREATE_ACCT" | jq -r '.user.id // empty')" = "" ] || [ -z "$ACCT_A_TOKEN" ]; then
  printf '%sSetup could not create/login accountant A. Aborting.%s\n' "$RED" "$RESET"
  echo "$CREATE_ACCT"
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
  -d "{\"businessName\":\"Verify Invoice Draft Co B\",\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner B\"}")
if [ "$(echo "$SIGNUP_B" | jq -r '.tenant.id // empty')" = "" ]; then
  printf '%sSetup signup (tenant B) failed:%s\n' "$RED" "$RESET"
  exit 1
fi
OWNER_B_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')

VEH_S=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA01IV1111","vehicle_type":"SEDAN","make_model":"Honda City"}' | jq -r '.vehicle.id // empty')
VEH_K=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA01IV2222","vehicle_type":"KIA_CARNIVAL","make_model":"KIA Carnival","seating_capacity":7}' | jq -r '.vehicle.id // empty')
VEH_S_NUMBER="KA01IV1111"
VEH_K_NUMBER="KA01IV2222"

CUST_KA=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"SunTravels","gstin":"29ABCDE1234F1Z5","credit_days":15}' | jq -r '.customer.id // empty')
CUST_MH=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"MumbaiCorp","gstin":"27ABCDE1234F1Z5","credit_days":30}' | jq -r '.customer.id // empty')
CUST_B2C=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2C","name":"Ramesh Iyer","phone":"9876512345","state_code":"KA"}' | jq -r '.customer.id // empty')

RULE_LOCAL_SEDAN=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"LOCAL_PACKAGE","vehicle_type":"SEDAN","label":"SEDAN 8H/80KM","base_hours":8,"base_km":80,"base_price_rupees":2200,"extra_km_rate_rupees":14,"extra_hr_rate_rupees":180,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')
RULE_OUTSTATION_KIA=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"OUTSTATION_SLAB","vehicle_type":"KIA_CARNIVAL","label":"KIA Cauvery Slab","slab_rate_rupees":50,"min_km_per_day":250,"driver_batta_per_day_rupees":960,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')
RULE_PERF_SEDAN=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"PERFORMANCE","vehicle_type":"SEDAN","label":"SEDAN Perf","per_km_rate_rupees":14,"performance_batta_rupees":300,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')

if [ -z "$VEH_S" ] || [ -z "$VEH_K" ] || [ -z "$CUST_KA" ] || [ -z "$CUST_MH" ] || [ -z "$CUST_B2C" ] || \
   [ -z "$RULE_LOCAL_SEDAN" ] || [ -z "$RULE_OUTSTATION_KIA" ] || [ -z "$RULE_PERF_SEDAN" ]; then
  printf '%sSetup did not yield all required fixtures. Aborting.%s\n' "$RED" "$RESET"
  echo "VEH_S=$VEH_S VEH_K=$VEH_K CUST_KA=$CUST_KA CUST_MH=$CUST_MH CUST_B2C=$CUST_B2C RULE_LOCAL=$RULE_LOCAL_SEDAN RULE_OUT=$RULE_OUTSTATION_KIA RULE_PERF=$RULE_PERF_SEDAN"
  exit 1
fi

# ─── Trips ───
# T1: OUTSTATION/GST, KIA, CUST_KA, 1699km/5days, fasttag 2440r (trip-level charge — excluded from the invoice line; see top-of-file note)
T1=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_KA\",\"vehicle_id\":\"$VEH_K\",\"trip_date\":\"$DAYS_AGO_5\",\"total_km\":1699,\"total_hours\":0,\"total_days\":5,\"fasttag_rupees\":2440}" | jq -r '.trip.id // empty')
# T2: LOCAL/GST, SEDAN, CUST_KA, 217km/12h -> base 2200 + extras 2638 = 4838 (Yellow UI ref)
T2=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_KA\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$DAYS_AGO_3\",\"total_km\":217,\"total_hours\":12}" | jq -r '.trip.id // empty')
# T3: LOCAL/GST, SEDAN, CUST_MH, 70km/6h (within base 80km/8h) -> base 2200 only, no extras
T3=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_MH\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$DAYS_AGO_2\",\"total_km\":70,\"total_hours\":6}" | jq -r '.trip.id // empty')
# T4: LOCAL/PERF, SEDAN, CUST_KA, 300km/8h -> 300*14 + 300 batta = 4500 (Blue UI ref)
T4=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"PERFORMANCE\",\"customer_id\":\"$CUST_KA\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$DAYS_AGO_2\",\"total_km\":300,\"total_hours\":8}" | jq -r '.trip.id // empty')
# T5: LOCAL/GST, SEDAN, CUST_B2C, 150km/8h -> base 2200 + extras 980 = 3180
T5=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_B2C\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$YESTERDAY\",\"total_km\":150,\"total_hours\":8}" | jq -r '.trip.id // empty')
# T6: LOCAL/GST, SEDAN, CUST_KA, 70km/6h (within base) -> base 2200 only. Spare unheld CUST_KA trip for mismatch/duplicate-request tests.
T6=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_KA\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$YESTERDAY\",\"total_km\":70,\"total_hours\":6}" | jq -r '.trip.id // empty')
# T_DRAFT: created but never finalized -> TRIP_NOT_FINALIZED case
T_DRAFT=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_KA\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$YESTERDAY\",\"total_km\":50,\"total_hours\":4}" | jq -r '.trip.id // empty')

if [ -z "$T1" ] || [ -z "$T2" ] || [ -z "$T3" ] || [ -z "$T4" ] || [ -z "$T5" ] || [ -z "$T6" ] || [ -z "$T_DRAFT" ]; then
  printf '%sSetup did not create all trips. Aborting.%s\n' "$RED" "$RESET"
  echo "T1=$T1 T2=$T2 T3=$T3 T4=$T4 T5=$T5 T6=$T6 T_DRAFT=$T_DRAFT"
  exit 1
fi

for t in "$T1" "$T2" "$T3" "$T4" "$T5" "$T6"; do
  curl -s -X POST "$BASE_URL/trips/$t/finalize" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
done
# T_DRAFT deliberately NOT finalized.

echo "Setup: tenant A (owner+accountant+staff+viewer), tenant B (owner), SEDAN+KIA vehicles, 3 customers, 3 pricing rules, 6 FINALIZED trips + 1 DRAFT trip"
echo

echo "Checks"
echo "------"

# ─── Step 1: TAX invoice, single OUTSTATION trip, intra-state ───
INV1_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_KA\",\"trip_sheet_ids\":[\"$T1\"]}")
INV_1=$(echo "$INV1_RESP" | jq -r '.invoice.id // empty')

STEP1_REASONS=()
[ "$(echo "$INV1_RESP" | jq -r '.invoice.status')" = "DRAFT" ] || STEP1_REASONS+=("status not DRAFT")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.invoice_type')" = "TAX" ] || STEP1_REASONS+=("invoice_type not TAX")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.invoice_number')" = "null" ] || STEP1_REASONS+=("invoice_number not null")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.subtotal_paise')" = "8975000" ] || STEP1_REASONS+=("subtotal_paise != 8975000, got $(echo "$INV1_RESP" | jq -r '.invoice.subtotal_paise')")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.gst_rate_snapshot')" = "5" ] || STEP1_REASONS+=("gst_rate_snapshot != 5")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.cgst_paise')" = "224375" ] || STEP1_REASONS+=("cgst_paise != 224375")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.sgst_paise')" = "224375" ] || STEP1_REASONS+=("sgst_paise != 224375")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.igst_paise')" = "0" ] || STEP1_REASONS+=("igst_paise != 0")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.total_gst_paise')" = "448750" ] || STEP1_REASONS+=("total_gst_paise != 448750")
# Task 4.2: reimbursement columns now auto-sum from the selected trips'
# own data at creation — T1 carries a ₹2,440 fasttag charge (set at
# trip creation, below), so it auto-fills here with no PATCH needed.
# That pushes grand_total/net_payable/amount_in_words to what Task 4.1
# originally only reached after an explicit Step-2 PATCH; see
# scripts/verify-invoice-picker.sh for the full auto-sum test surface.
[ "$(echo "$INV1_RESP" | jq -r '.invoice.toll_paise')" = "0" ] || STEP1_REASONS+=("toll_paise != 0")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.parking_paise')" = "0" ] || STEP1_REASONS+=("parking_paise != 0")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.permit_paise')" = "0" ] || STEP1_REASONS+=("permit_paise != 0")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.fasttag_paise')" = "244000" ] || STEP1_REASONS+=("fasttag_paise != 244000 (auto-summed from T1)")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.fasttag_manual_override')" = "false" ] || STEP1_REASONS+=("fasttag_manual_override != false")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.grand_total_paise')" = "9667750" ] || STEP1_REASONS+=("grand_total_paise != 9667750, got $(echo "$INV1_RESP" | jq -r '.invoice.grand_total_paise')")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.net_payable_paise')" = "9667800" ] || STEP1_REASONS+=("net_payable_paise != 9667800")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.round_off_paise')" = "50" ] || STEP1_REASONS+=("round_off_paise != 50")
echo "$INV1_RESP" | jq -r '.invoice.amount_in_words' | grep -q "Ninety Six Thousand Six Hundred Seventy Eight" || STEP1_REASONS+=("amount_in_words missing 'Ninety Six Thousand Six Hundred Seventy Eight'")
[ "$(echo "$INV1_RESP" | jq '.invoice.lines | length')" = "1" ] || STEP1_REASONS+=("lines.length != 1")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.lines[0].vehicle_number')" = "$VEH_K_NUMBER" ] || STEP1_REASONS+=("lines[0].vehicle_number wrong")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.lines[0].line_amount_paise')" = "8975000" ] || STEP1_REASONS+=("lines[0].line_amount_paise != 8975000")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.lines[0].hsn_sac_code')" = "996601" ] || STEP1_REASONS+=("lines[0].hsn_sac_code != 996601")

if [ -n "$INV_1" ] && [ ${#STEP1_REASONS[@]} -eq 0 ]; then
  pass "TAX invoice from single OUTSTATION trip (intra-state): subtotal ₹89,750, CGST/SGST ₹2,243.75 each, fasttag auto-summed ₹2,440, net payable ₹96,678"
else
  fail "TAX invoice creation (Step 1)" "$(IFS='; '; echo "${STEP1_REASONS[*]}") -- resp: $INV1_RESP"
fi

# Trip hold check (via direct DB read — held_by_invoice_id isn't necessarily
# surfaced by every trip endpoint's projection).
HOLD_T1=$(psql_as_tenant_a "SELECT held_by_invoice_id FROM trip_sheets WHERE id = '$T1';")
if [ "$HOLD_T1" = "$INV_1" ]; then
  pass "Trip T1 is held by invoice INV_1 after creation"
else
  fail "Trip hold after invoice creation" "expected held_by_invoice_id '$INV_1', got '$HOLD_T1'"
fi

# ─── Step 2: PATCH the SAME fasttag amount explicitly — auto-sum -> manual override ───
# Task 4.2: fasttag_paise was already 244000 via auto-sum (Step 1); this
# PATCH supplies the identical rupee value explicitly, which shouldn't
# change the number but MUST flip fasttag_manual_override to true (an
# explicit choice, even one that happens to match the auto-sum, always
# wins and is remembered — see computeEffectiveReimbursements).
INV2_PATCH=$(curl -s -X PATCH "$BASE_URL/invoices/$INV_1" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"fasttag_rupees":2440}')
STEP2_REASONS=()
[ "$(echo "$INV2_PATCH" | jq -r '.invoice.fasttag_paise')" = "244000" ] || STEP2_REASONS+=("fasttag_paise != 244000")
[ "$(echo "$INV2_PATCH" | jq -r '.invoice.fasttag_manual_override')" = "true" ] || STEP2_REASONS+=("fasttag_manual_override != true")
[ "$(echo "$INV2_PATCH" | jq -r '.invoice.grand_total_paise')" = "9667750" ] || STEP2_REASONS+=("grand_total_paise != 9667750, got $(echo "$INV2_PATCH" | jq -r '.invoice.grand_total_paise')")
[ "$(echo "$INV2_PATCH" | jq -r '.invoice.net_payable_paise')" = "9667800" ] || STEP2_REASONS+=("net_payable_paise != 9667800")
[ "$(echo "$INV2_PATCH" | jq -r '.invoice.subtotal_paise')" = "8975000" ] || STEP2_REASONS+=("subtotal_paise changed unexpectedly")

if [ ${#STEP2_REASONS[@]} -eq 0 ]; then
  pass "PATCH fasttag_rupees=2440 (same value, now explicit): totals unchanged, fasttag_manual_override flips to true"
else
  fail "PATCH fasttag_rupees (Step 2)" "$(IFS='; '; echo "${STEP2_REASONS[*]}")"
fi

# ─── Step 3: TAX invoice, inter-state (IGST) ───
INV3_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_MH\",\"trip_sheet_ids\":[\"$T3\"]}")
INV_2=$(echo "$INV3_RESP" | jq -r '.invoice.id // empty')
STEP3_REASONS=()
[ "$(echo "$INV3_RESP" | jq -r '.invoice.subtotal_paise')" = "220000" ] || STEP3_REASONS+=("subtotal_paise != 220000, got $(echo "$INV3_RESP" | jq -r '.invoice.subtotal_paise')")
[ "$(echo "$INV3_RESP" | jq -r '.invoice.cgst_paise')" = "0" ] || STEP3_REASONS+=("cgst_paise != 0")
[ "$(echo "$INV3_RESP" | jq -r '.invoice.sgst_paise')" = "0" ] || STEP3_REASONS+=("sgst_paise != 0")
[ "$(echo "$INV3_RESP" | jq -r '.invoice.igst_paise')" = "11000" ] || STEP3_REASONS+=("igst_paise != 11000")
[ "$(echo "$INV3_RESP" | jq -r '.invoice.total_gst_paise')" = "11000" ] || STEP3_REASONS+=("total_gst_paise != 11000")

if [ -n "$INV_2" ] && [ ${#STEP3_REASONS[@]} -eq 0 ]; then
  pass "TAX invoice inter-state (CUST_MH): subtotal ₹2,200, IGST ₹110, CGST/SGST both 0"
else
  fail "TAX invoice inter-state (Step 3)" "$(IFS='; '; echo "${STEP3_REASONS[*]}")"
fi

# ─── Step 4: PERFORMANCE invoice ───
INV4_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"PERFORMANCE\",\"customer_id\":\"$CUST_KA\",\"trip_sheet_ids\":[\"$T4\"]}")
INV_PERF=$(echo "$INV4_RESP" | jq -r '.invoice.id // empty')
STEP4_REASONS=()
[ "$(echo "$INV4_RESP" | jq -r '.invoice.invoice_type')" = "PERFORMANCE" ] || STEP4_REASONS+=("invoice_type != PERFORMANCE")
[ "$(echo "$INV4_RESP" | jq -r '.invoice.gst_rate_snapshot')" = "null" ] || STEP4_REASONS+=("gst_rate_snapshot != null")
[ "$(echo "$INV4_RESP" | jq -r '.invoice.total_gst_paise')" = "0" ] || STEP4_REASONS+=("total_gst_paise != 0")
[ "$(echo "$INV4_RESP" | jq -r '.invoice.subtotal_paise')" = "450000" ] || STEP4_REASONS+=("subtotal_paise != 450000, got $(echo "$INV4_RESP" | jq -r '.invoice.subtotal_paise')")
[ "$(echo "$INV4_RESP" | jq -r '.invoice.grand_total_paise')" = "450000" ] || STEP4_REASONS+=("grand_total_paise != 450000")
[ "$(echo "$INV4_RESP" | jq -r '.invoice.net_payable_paise')" = "450000" ] || STEP4_REASONS+=("net_payable_paise != 450000")

if [ -n "$INV_PERF" ] && [ ${#STEP4_REASONS[@]} -eq 0 ]; then
  pass "PERFORMANCE invoice (T4): subtotal ₹4,500, zero GST, net payable ₹4,500 (Blue UI ref)"
else
  fail "PERFORMANCE invoice creation (Step 4)" "$(IFS='; '; echo "${STEP4_REASONS[*]}")"
fi

# ─── Step 5: T1 already held -> 409 TRIP_ALREADY_HELD ───
INV5_STATUS=$(curl -s -o "$WORK_DIR/inv5.json" -w '%{http_code}' -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_KA\",\"trip_sheet_ids\":[\"$T1\",\"$T2\"]}")
INV5_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/inv5.json")
INV5_TRIP_ID=$(jq -r '.error.details.trip_id // empty' "$WORK_DIR/inv5.json")
INV5_HELD_BY=$(jq -r '.error.details.held_by_invoice_id // empty' "$WORK_DIR/inv5.json")

if [ "$INV5_STATUS" = "409" ] && [ "$INV5_CODE" = "TRIP_ALREADY_HELD" ] && [ "$INV5_TRIP_ID" = "$T1" ] && [ "$INV5_HELD_BY" = "$INV_1" ]; then
  pass "Multi-trip invoice with an already-held trip: 409 TRIP_ALREADY_HELD (trip_id=T1, held_by_invoice_id=INV_1)"
else
  fail "TRIP_ALREADY_HELD (Step 5)" "status '$INV5_STATUS', code '$INV5_CODE', trip_id '$INV5_TRIP_ID', held_by '$INV5_HELD_BY'"
fi

# ─── Step 6: DELETE INV_1 releases the hold ───
DEL6_RESP=$(curl -s -X DELETE "$BASE_URL/invoices/$INV_1" -H "Authorization: Bearer $ACCT_A_TOKEN")
HOLD_T1_AFTER=$(psql_as_tenant_a "SELECT held_by_invoice_id FROM trip_sheets WHERE id = '$T1';")

if [ "$(echo "$DEL6_RESP" | jq -r '.deleted')" = "true" ] && [ -z "$HOLD_T1_AFTER" ]; then
  pass "DELETE /invoices/:id on a DRAFT releases the trip hold (T1 held_by_invoice_id is now NULL)"
else
  fail "Delete draft releases hold (Step 6)" "deleted='$(echo "$DEL6_RESP" | jq -r '.deleted')', hold_after='$HOLD_T1_AFTER'"
fi

# ─── Step 7: multi-trip invoice after release ───
INV7_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_KA\",\"trip_sheet_ids\":[\"$T1\",\"$T2\"]}")
INV_MULTI=$(echo "$INV7_RESP" | jq -r '.invoice.id // empty')
STEP7_REASONS=()
[ "$(echo "$INV7_RESP" | jq '.invoice.lines | length')" = "2" ] || STEP7_REASONS+=("lines.length != 2")
[ "$(echo "$INV7_RESP" | jq -r '.invoice.lines[0].trip_sheet_id')" = "$T1" ] || STEP7_REASONS+=("lines[0].trip_sheet_id != T1")
[ "$(echo "$INV7_RESP" | jq -r '.invoice.lines[0].line_number')" = "1" ] || STEP7_REASONS+=("lines[0].line_number != 1")
[ "$(echo "$INV7_RESP" | jq -r '.invoice.lines[1].trip_sheet_id')" = "$T2" ] || STEP7_REASONS+=("lines[1].trip_sheet_id != T2")
[ "$(echo "$INV7_RESP" | jq -r '.invoice.lines[1].line_number')" = "2" ] || STEP7_REASONS+=("lines[1].line_number != 2")
[ "$(echo "$INV7_RESP" | jq -r '.invoice.subtotal_paise')" = "9458800" ] || STEP7_REASONS+=("subtotal_paise != 9458800, got $(echo "$INV7_RESP" | jq -r '.invoice.subtotal_paise')")
[ "$(echo "$INV7_RESP" | jq -r '.invoice.total_gst_paise')" = "472940" ] || STEP7_REASONS+=("total_gst_paise != 472940")
[ "$(echo "$INV7_RESP" | jq -r '.invoice.cgst_paise')" = "236470" ] || STEP7_REASONS+=("cgst_paise != 236470")
[ "$(echo "$INV7_RESP" | jq -r '.invoice.sgst_paise')" = "236470" ] || STEP7_REASONS+=("sgst_paise != 236470")

if [ -n "$INV_MULTI" ] && [ ${#STEP7_REASONS[@]} -eq 0 ]; then
  pass "Multi-trip TAX invoice [T1,T2]: 2 lines in request order, subtotal ₹94,588, GST ₹4,729.40"
else
  fail "Multi-trip invoice (Step 7)" "$(IFS='; '; echo "${STEP7_REASONS[*]}")"
fi

# ─── Step 8: cross-customer trip -> CUSTOMER_MISMATCH ───
INV8_STATUS=$(curl -s -o "$WORK_DIR/inv8.json" -w '%{http_code}' -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_KA\",\"trip_sheet_ids\":[\"$T6\",\"$T5\"]}")
INV8_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/inv8.json")

if [ "$INV8_STATUS" = "400" ] && [ "$INV8_CODE" = "CUSTOMER_MISMATCH" ]; then
  pass "Trip belonging to a different customer (T5 is CUST_B2C): 400 CUSTOMER_MISMATCH"
else
  fail "CUSTOMER_MISMATCH (Step 8)" "status '$INV8_STATUS', code '$INV8_CODE'"
fi

# ─── Step 9: not-FINALIZED trip -> TRIP_NOT_FINALIZED ───
INV9_STATUS=$(curl -s -o "$WORK_DIR/inv9.json" -w '%{http_code}' -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_KA\",\"trip_sheet_ids\":[\"$T_DRAFT\"]}")
INV9_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/inv9.json")
INV9_CURRENT_STATUS=$(jq -r '.error.details.current_status // empty' "$WORK_DIR/inv9.json")

if [ "$INV9_STATUS" = "400" ] && [ "$INV9_CODE" = "TRIP_NOT_FINALIZED" ] && [ "$INV9_CURRENT_STATUS" = "DRAFT" ]; then
  pass "DRAFT (not-finalized) trip: 400 TRIP_NOT_FINALIZED, current_status=DRAFT"
else
  fail "TRIP_NOT_FINALIZED (Step 9)" "status '$INV9_STATUS', code '$INV9_CODE', current_status '$INV9_CURRENT_STATUS'"
fi

# ─── Step 10: nonexistent customer -> 404 ───
INV10_STATUS=$(curl -s -o "$WORK_DIR/inv10.json" -w '%{http_code}' -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"00000000-0000-4000-8000-000000000000\",\"trip_sheet_ids\":[\"$T6\"]}")
INV10_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/inv10.json")

if [ "$INV10_STATUS" = "404" ] && [ "$INV10_CODE" = "CUSTOMER_NOT_FOUND" ]; then
  pass "Nonexistent customer_id: 404 CUSTOMER_NOT_FOUND"
else
  fail "CUSTOMER_NOT_FOUND (Step 10)" "status '$INV10_STATUS', code '$INV10_CODE'"
fi

# ─── Step 11: nonexistent trip -> 404 TRIP_NOT_FOUND ───
INV11_STATUS=$(curl -s -o "$WORK_DIR/inv11.json" -w '%{http_code}' -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_KA\",\"trip_sheet_ids\":[\"00000000-0000-4000-8000-000000000099\"]}")
INV11_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/inv11.json")

if [ "$INV11_STATUS" = "404" ] && [ "$INV11_CODE" = "TRIP_NOT_FOUND" ]; then
  pass "Nonexistent trip_sheet_id: 404 TRIP_NOT_FOUND"
else
  fail "TRIP_NOT_FOUND (Step 11)" "status '$INV11_STATUS', code '$INV11_CODE'"
fi

# ─── Step 12: duplicate trip id within the same request -> 409 TRIP_ALREADY_ON_INVOICE ───
INV12_STATUS=$(curl -s -o "$WORK_DIR/inv12.json" -w '%{http_code}' -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_KA\",\"trip_sheet_ids\":[\"$T6\",\"$T6\"]}")
INV12_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/inv12.json")

if [ "$INV12_STATUS" = "409" ] && [ "$INV12_CODE" = "TRIP_ALREADY_ON_INVOICE" ]; then
  pass "Same trip repeated within one request: 409 TRIP_ALREADY_ON_INVOICE"
else
  fail "TRIP_ALREADY_ON_INVOICE (Step 12)" "status '$INV12_STATUS', code '$INV12_CODE'"
fi
# T6 was rolled back (transaction failed) and remains unheld/available.

# ─── Step 13: invoice_date in the future -> 400 INVOICE_DATE_INVALID ───
INV13_STATUS=$(curl -s -o "$WORK_DIR/inv13.json" -w '%{http_code}' -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_KA\",\"trip_sheet_ids\":[\"$T6\"],\"invoice_date\":\"$TOMORROW\"}")
INV13_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/inv13.json")

if [ "$INV13_STATUS" = "400" ] && [ "$INV13_CODE" = "INVOICE_DATE_INVALID" ]; then
  pass "invoice_date in the future: 400 INVOICE_DATE_INVALID"
else
  fail "INVOICE_DATE_INVALID future (Step 13)" "status '$INV13_STATUS', code '$INV13_CODE'"
fi

# ─── Step 14: invoice_date more than 30 days in the past -> 400 INVOICE_DATE_INVALID ───
INV14_STATUS=$(curl -s -o "$WORK_DIR/inv14.json" -w '%{http_code}' -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_KA\",\"trip_sheet_ids\":[\"$T6\"],\"invoice_date\":\"$DAYS_AGO_45\"}")
INV14_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/inv14.json")

if [ "$INV14_STATUS" = "400" ] && [ "$INV14_CODE" = "INVOICE_DATE_INVALID" ]; then
  pass "invoice_date 45 days in the past (>30 day cap): 400 INVOICE_DATE_INVALID"
else
  fail "INVOICE_DATE_INVALID past (Step 14)" "status '$INV14_STATUS', code '$INV14_CODE'"
fi

# ─── Step 15: due_date defaults from customer.credit_days ───
INV15_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_KA\",\"trip_sheet_ids\":[\"$T6\"]}")
INV_DUEDATE_TEST=$(echo "$INV15_RESP" | jq -r '.invoice.id // empty')
INV15_INVOICE_DATE=$(echo "$INV15_RESP" | jq -r '.invoice.invoice_date')
INV15_DUE_DATE=$(echo "$INV15_RESP" | jq -r '.invoice.due_date')
# CUST_KA has credit_days=15
EXPECTED_DUE_DATE=$(date -j -f "%Y-%m-%d" -v+15d "$INV15_INVOICE_DATE" +%Y-%m-%d 2>/dev/null)

if [ -n "$INV_DUEDATE_TEST" ] && [ "$INV15_DUE_DATE" = "$EXPECTED_DUE_DATE" ]; then
  pass "due_date defaults to invoice_date + customer.credit_days (15 days for CUST_KA): $INV15_DUE_DATE"
else
  fail "due_date default (Step 15)" "invoice_date '$INV15_INVOICE_DATE', due_date '$INV15_DUE_DATE', expected '$EXPECTED_DUE_DATE'"
fi
# This was a throwaway invoice created only to inspect due_date defaulting —
# delete it so T6 is released back for reuse in later steps (18/24).
curl -s -X DELETE "$BASE_URL/invoices/$INV_DUEDATE_TEST" -H "Authorization: Bearer $ACCT_A_TOKEN" > /dev/null

# ─── Step 16: GET /invoices/:id full detail shape ───
GET16=$(curl -s "$BASE_URL/invoices/$INV_MULTI" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP16_REASONS=()
[ "$(echo "$GET16" | jq '.invoice | has("lines")')" = "true" ] || STEP16_REASONS+=("missing lines")
[ "$(echo "$GET16" | jq '.invoice | has("customer")')" = "true" ] || STEP16_REASONS+=("missing customer ref")
[ "$(echo "$GET16" | jq '.invoice | has("tenant")')" = "true" ] || STEP16_REASONS+=("missing tenant ref")
[ "$(echo "$GET16" | jq -r '.invoice.customer.id')" = "$CUST_KA" ] || STEP16_REASONS+=("customer ref id mismatch")

if [ ${#STEP16_REASONS[@]} -eq 0 ]; then
  pass "GET /invoices/:id returns full detail: lines, customer ref, tenant ref"
else
  fail "GET invoice detail shape (Step 16)" "$(IFS='; '; echo "${STEP16_REASONS[*]}")"
fi

# ─── Step 17: GET nonexistent invoice -> 404 INVOICE_NOT_FOUND ───
GET17_STATUS=$(curl -s -o "$WORK_DIR/get17.json" -w '%{http_code}' "$BASE_URL/invoices/00000000-0000-4000-8000-000000000099" -H "Authorization: Bearer $OWNER_A_TOKEN")
GET17_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/get17.json")

if [ "$GET17_STATUS" = "404" ] && [ "$GET17_CODE" = "INVOICE_NOT_FOUND" ]; then
  pass "GET nonexistent invoice: 404 INVOICE_NOT_FOUND"
else
  fail "INVOICE_NOT_FOUND on GET (Step 17)" "status '$GET17_STATUS', code '$GET17_CODE'"
fi

# ─── Step 18: PATCH replaces the trip set (add T6 to INV_PERF alongside T4) ───
PATCH18_RESP=$(curl -s -X PATCH "$BASE_URL/invoices/$INV_PERF" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"trip_sheet_ids\":[\"$T4\",\"$T6\"]}")
STEP18_REASONS=()
[ "$(echo "$PATCH18_RESP" | jq '.invoice.lines | length')" = "2" ] || STEP18_REASONS+=("lines.length != 2")
[ "$(echo "$PATCH18_RESP" | jq -r '.invoice.subtotal_paise')" = "670000" ] || STEP18_REASONS+=("subtotal_paise != 670000, got $(echo "$PATCH18_RESP" | jq -r '.invoice.subtotal_paise')")
[ "$(echo "$PATCH18_RESP" | jq -r '.invoice.total_gst_paise')" = "0" ] || STEP18_REASONS+=("total_gst_paise != 0 (invoice_type stays PERFORMANCE)")
HOLD_T6=$(psql_as_tenant_a "SELECT held_by_invoice_id FROM trip_sheets WHERE id = '$T6';")
[ "$HOLD_T6" = "$INV_PERF" ] || STEP18_REASONS+=("T6 not held by INV_PERF after PATCH, got '$HOLD_T6'")

if [ ${#STEP18_REASONS[@]} -eq 0 ]; then
  pass "PATCH trip_sheet_ids replaces the trip set: INV_PERF now [T4,T6], subtotal ₹6,700, T6 newly held"
else
  fail "PATCH trip_sheet_ids replace (Step 18)" "$(IFS='; '; echo "${STEP18_REASONS[*]}")"
fi

# ─── Step 19: PATCH discount recomputes GST on INV_MULTI ───
PATCH19_RESP=$(curl -s -X PATCH "$BASE_URL/invoices/$INV_MULTI" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"discount_rupees":100,"discount_reason":"loyalty"}')
STEP19_REASONS=()
[ "$(echo "$PATCH19_RESP" | jq -r '.invoice.discount_paise')" = "10000" ] || STEP19_REASONS+=("discount_paise != 10000")
[ "$(echo "$PATCH19_RESP" | jq -r '.invoice.subtotal_paise')" = "9458800" ] || STEP19_REASONS+=("subtotal_paise changed unexpectedly")
[ "$(echo "$PATCH19_RESP" | jq -r '.invoice.total_gst_paise')" = "472440" ] || STEP19_REASONS+=("total_gst_paise != 472440, got $(echo "$PATCH19_RESP" | jq -r '.invoice.total_gst_paise')")
[ "$(echo "$PATCH19_RESP" | jq -r '.invoice.discount_reason')" = "loyalty" ] || STEP19_REASONS+=("discount_reason not saved")

if [ ${#STEP19_REASONS[@]} -eq 0 ]; then
  pass "PATCH discount_rupees=100 on INV_MULTI: taxable amount drops, GST recomputes to ₹4,724.40"
else
  fail "PATCH discount recompute (Step 19)" "$(IFS='; '; echo "${STEP19_REASONS[*]}")"
fi

# ─── Step 20: EMPTY_PATCH / VALIDATION_ERROR on an empty body ───
PATCH20_STATUS=$(curl -s -o "$WORK_DIR/patch20.json" -w '%{http_code}' -X PATCH "$BASE_URL/invoices/$INV_MULTI" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" -d '{}')
PATCH20_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/patch20.json")

if [ "$PATCH20_STATUS" = "400" ] && [ "$PATCH20_CODE" = "VALIDATION_ERROR" ]; then
  pass "PATCH with empty body: 400 VALIDATION_ERROR (Joi's .min(1), EMPTY_PATCH is the repo-layer backstop)"
else
  fail "Empty PATCH body (Step 20)" "status '$PATCH20_STATUS', code '$PATCH20_CODE'"
fi

# ─── Step 21: static check — EMPTY_PATCH code present as a backstop ───
HAS_EMPTY_PATCH=$(grep -c 'EMPTY_PATCH' src/repositories/invoice.repository.js)
if [ "$HAS_EMPTY_PATCH" -gt "0" ]; then
  pass "Static check: EMPTY_PATCH backstop present in invoice.repository.js"
else
  fail "EMPTY_PATCH static check" "not found in invoice.repository.js"
fi

# ─── Step 22 + 23: INVOICE_NOT_EDITABLE / INVOICE_NOT_DELETABLE ───
# No issue endpoint exists yet (Task 4.3) to reach an ISSUED invoice via
# the API, so we flip status directly via psql — same "prove the guard
# against a state the live API can't produce yet" approach as other
# verify scripts' DB-layer checks.
psql "${DATABASE_URL:-}" -c "SELECT set_config('app.current_tenant_id', '$TENANT_A_ID', false); UPDATE invoices SET status = 'ISSUED', invoice_number = 'TEST-ISSUED-1' WHERE id = '$INV_2';" > /dev/null 2>&1

PATCH22_STATUS=$(curl -s -o "$WORK_DIR/patch22.json" -w '%{http_code}' -X PATCH "$BASE_URL/invoices/$INV_2" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" -d '{"notes":"x"}')
PATCH22_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/patch22.json")

if [ "$PATCH22_STATUS" = "409" ] && [ "$PATCH22_CODE" = "INVOICE_NOT_EDITABLE" ]; then
  pass "PATCH on an ISSUED invoice: 409 INVOICE_NOT_EDITABLE"
else
  fail "INVOICE_NOT_EDITABLE (Step 22)" "status '$PATCH22_STATUS', code '$PATCH22_CODE'"
fi

DEL23_STATUS=$(curl -s -o "$WORK_DIR/del23.json" -w '%{http_code}' -X DELETE "$BASE_URL/invoices/$INV_2" -H "Authorization: Bearer $ACCT_A_TOKEN")
DEL23_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/del23.json")

if [ "$DEL23_STATUS" = "409" ] && [ "$DEL23_CODE" = "INVOICE_NOT_DELETABLE" ]; then
  pass "DELETE on an ISSUED invoice: 409 INVOICE_NOT_DELETABLE"
else
  fail "INVOICE_NOT_DELETABLE (Step 23)" "status '$DEL23_STATUS', code '$DEL23_CODE'"
fi

# ─── Step 24: RBAC — staff can draft (create) ───
STAFF24_STATUS=$(curl -s -o "$WORK_DIR/staff24.json" -w '%{http_code}' -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_B2C\",\"trip_sheet_ids\":[\"$T5\"]}")
STAFF24_ID=$(jq -r '.invoice.id // empty' "$WORK_DIR/staff24.json")

if [ "$STAFF24_STATUS" = "201" ] && [ -n "$STAFF24_ID" ]; then
  pass "RBAC: staff can create a draft invoice (invoices:draft): 201"
else
  fail "Staff can draft (Step 24)" "status '$STAFF24_STATUS'"
fi

# ─── Step 25: RBAC — staff can read back what they created (fixed in this task) ───
STAFF25_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/invoices/$STAFF24_ID" -H "Authorization: Bearer $STAFF_A_TOKEN")

if [ "$STAFF25_STATUS" = "200" ]; then
  pass "RBAC: staff can read invoices (invoices:read fixed to include staff): 200"
else
  fail "Staff can read (Step 25)" "got '$STAFF25_STATUS'"
fi

# ─── Step 26: RBAC — viewer cannot draft ───
VIEWER26_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $VIEWER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_B2C\",\"trip_sheet_ids\":[\"$T5\"]}")

if [ "$VIEWER26_STATUS" = "403" ]; then
  pass "RBAC: viewer cannot create a draft invoice: 403"
else
  fail "Viewer cannot draft (Step 26)" "got '$VIEWER26_STATUS'"
fi

# ─── Step 27: cross-tenant isolation ───
CROSS27_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/invoices/$INV_MULTI" -H "Authorization: Bearer $OWNER_B_TOKEN")

if [ "$CROSS27_STATUS" = "404" ]; then
  pass "Cross-tenant isolation: tenant B cannot read tenant A's invoice: 404"
else
  fail "Cross-tenant isolation (Step 27)" "got '$CROSS27_STATUS'"
fi

# ─── Step 28: DB-layer isolation ───
DB28_COUNT=$(psql "${DATABASE_URL:-}" -tAc "SELECT COUNT(*) FROM invoices;" 2>/dev/null | tr -d '[:space:]')

if [ "$DB28_COUNT" = "0" ]; then
  pass "DB-layer isolation: direct psql with no tenant context set sees 0 invoice rows"
else
  fail "DB-layer isolation (Step 28)" "expected 0, got '$DB28_COUNT'"
fi

# ─── Step 29: access matrix has all 4 invoices:* keys with the spec'd role sets ───
MATRIX_CHECK=$(node -e "
const m = require('./src/config/accessMatrix');
const expect = {
  'invoices:read': ['owner','admin','accountant','staff','viewer'],
  'invoices:draft': ['owner','admin','accountant','staff'],
  'invoices:issue': ['owner','admin','accountant'],
  'invoices:cancel': ['owner','admin'],
};
let ok = true;
for (const [k, v] of Object.entries(expect)) {
  const actual = m[k] || [];
  if (actual.length !== v.length || !v.every((r) => actual.includes(r))) ok = false;
}
console.log(ok ? 'true' : 'false');
")

if [ "$MATRIX_CHECK" = "true" ]; then
  pass "accessMatrix.js has all 4 invoices:* keys with the spec'd role sets"
else
  fail "accessMatrix invoices:* keys (Step 29)" "mismatch — see src/config/accessMatrix.js"
fi

# ─── Step 30: regression — GET /trips and GET /trips/:id still work ───
REG30_LIST_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/trips?limit=100" -H "Authorization: Bearer $OWNER_A_TOKEN")
REG30_GET_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/trips/$T2" -H "Authorization: Bearer $OWNER_A_TOKEN")

if [ "$REG30_LIST_STATUS" = "200" ] && [ "$REG30_GET_STATUS" = "200" ]; then
  pass "Regression: GET /trips and GET /trips/:id (Module 3) still work"
else
  fail "Regression Module 3 trips (Step 30)" "list status '$REG30_LIST_STATUS', get status '$REG30_GET_STATUS'"
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
  printf '%s✓ All %s checks passed. Invoice foundation module (Task 4.1) is working correctly.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
  echo
  echo "Tenant A owner: $OWNER_A_EMAIL"
  echo "Tenant A accountant: $ACCT_A_EMAIL"
  echo "Tenant A staff: $STAFF_A_EMAIL"
  echo "Tenant A viewer: $VIEWER_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 0
fi
