#!/usr/bin/env bash
#
# End-to-end verification of the Task 4.3 invoice lifecycle: DRAFT ->
# ISSUED -> CANCELLED (with credit note), atomic numbering, tenant/
# customer snapshotting, and trip status wiring (FINALIZED <-> INVOICED).
# Mirrors scripts/verify-invoice-draft.sh's structure. Prints a
# PASS/FAIL summary and exits 1 if anything failed.
#
# Rule 11: aggregate/derived-number assertions (concurrent-issue
# sequence contiguity, credit-note counts) are checked for
# self-consistency against state this SAME script already created,
# not against independently re-derived numbers. Exact paise amounts
# ARE asserted where the inputs are ones this script controls directly
# (trip km/hours/reimbursements), same as verify-invoice-draft.sh.
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
OWNER_A_EMAIL="verify-inv-lc-owner-a-$(date +%s)@example.com"
ADMIN_A_EMAIL="verify-inv-lc-admin-a-$(date +%s)-2@example.com"
ACCT_A_EMAIL="verify-inv-lc-acct-a-$(date +%s)-3@example.com"
STAFF_A_EMAIL="verify-inv-lc-staff-a-$(date +%s)-4@example.com"
VIEWER_A_EMAIL="verify-inv-lc-viewer-a-$(date +%s)-5@example.com"
OWNER_B_EMAIL="verify-inv-lc-owner-b-$(date +%s)-6@example.com"

# Rule 8: all trip dates computed as offsets BACK from today.
days_ago() { date -v-"$1"d +%Y-%m-%d; }
YESTERDAY=$(days_ago 1)
DAYS_AGO_2=$(days_ago 2)
DAYS_AGO_3=$(days_ago 3)
DAYS_AGO_5=$(days_ago 5)
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
TOTAL_CHECKS=32
FAILED_STEPS=()
CREDIT_NOTE_COUNT=0

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
SIGNUP_CN_PREFIX=$(echo "$SIGNUP_A" | jq -r '.tenant.credit_note_prefix')
SIGNUP_GST_RATE=$(echo "$SIGNUP_A" | jq -r '.tenant.gst_rate')
if [ "$SIGNUP_INVOICE_PREFIX" = "PRA" ] && [ "$SIGNUP_CN_PREFIX" = "PRA-CN" ] && [ "$SIGNUP_GST_RATE" = "5" ]; then
  pass "Signup auto-derives invoice_prefix=PRA, credit_note_prefix=PRA-CN, gst_rate=5 for 'Pravasi Tours'"
else
  fail "Signup auto-derived prefixes" "invoice_prefix='$SIGNUP_INVOICE_PREFIX', credit_note_prefix='$SIGNUP_CN_PREFIX', gst_rate='$SIGNUP_GST_RATE'"
fi

OWNER_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
if [ -z "$OWNER_A_TOKEN" ]; then
  printf '%sSetup did not yield an owner A token. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

# PATCH /settings/business only accepts the fields that actually exist
# on the tenants row (name/gstin/pan/state_code/logo_url/invoice_prefix/
# trip_sheet_prefix/bank_details/settings) — there is no address_line1/
# city/state/pincode/phone/email/website column on tenants at all, so
# those from the task's literal setup instructions are omitted here
# rather than sent and silently stripped. bank_details is a structured
# object (account_name/account_number/ifsc/bank_name/branch/upi_id),
# not a free-text string.
curl -s -X PATCH "$BASE_URL/settings/business" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"state_code":"KA","trip_sheet_prefix":"PRA","gstin":"29ABCDE1234F1Z5","bank_details":{"account_name":"Pravasi Tours","account_number":"12345678","ifsc":"HDFC0000123","bank_name":"HDFC Bank"}}' > /dev/null

CREATE_ADMIN=$(curl -s -X POST "$BASE_URL/users" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Admin A\",\"role\":\"admin\"}")
ADMIN_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
if [ "$(echo "$CREATE_ADMIN" | jq -r '.user.id // empty')" = "" ] || [ -z "$ADMIN_A_TOKEN" ]; then
  printf '%sSetup could not create/login admin A. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

CREATE_ACCT=$(curl -s -X POST "$BASE_URL/users" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ACCT_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Accountant A\",\"role\":\"accountant\"}")
ACCT_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ACCT_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
ACCT_A_USER_ID=$(echo "$CREATE_ACCT" | jq -r '.user.id // empty')
if [ -z "$ACCT_A_USER_ID" ] || [ -z "$ACCT_A_TOKEN" ]; then
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
  -d "{\"businessName\":\"Verify Invoice Lifecycle Co B\",\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner B\"}")
if [ "$(echo "$SIGNUP_B" | jq -r '.tenant.id // empty')" = "" ]; then
  printf '%sSetup signup (tenant B) failed:%s\n' "$RED" "$RESET"
  exit 1
fi
OWNER_B_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')

VEH_K=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA01LF1111","vehicle_type":"KIA_CARNIVAL","make_model":"KIA Carnival","seating_capacity":7}' | jq -r '.vehicle.id // empty')
VEH_S=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA01LF2222","vehicle_type":"SEDAN","make_model":"Honda City"}' | jq -r '.vehicle.id // empty')

CUST_A=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"Acme Logistics","gstin":"29XXXXX1234A1Z6","credit_days":15}' | jq -r '.customer.id // empty')
CUST_M=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"Mumbai Freight Co","gstin":"27XXXXX5678B1Z7","credit_days":30}' | jq -r '.customer.id // empty')
CUST_C=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2C","name":"Ramesh Iyer","phone":"9876512345","state_code":"KA"}' | jq -r '.customer.id // empty')

RULE_LOCAL_SEDAN=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"LOCAL_PACKAGE","vehicle_type":"SEDAN","label":"SEDAN 8H/80KM","base_hours":8,"base_km":80,"base_price_rupees":2200,"extra_km_rate_rupees":14,"extra_hr_rate_rupees":180,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')
RULE_OUTSTATION_KIA=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"OUTSTATION_SLAB","vehicle_type":"KIA_CARNIVAL","label":"KIA Cauvery Slab","slab_rate_rupees":50,"min_km_per_day":250,"driver_batta_per_day_rupees":960,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')
RULE_PERF_SEDAN=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"PERFORMANCE","vehicle_type":"SEDAN","label":"SEDAN Perf","per_km_rate_rupees":14,"performance_batta_rupees":300,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')

if [ -z "$VEH_K" ] || [ -z "$VEH_S" ] || [ -z "$CUST_A" ] || [ -z "$CUST_M" ] || [ -z "$CUST_C" ] || \
   [ -z "$RULE_LOCAL_SEDAN" ] || [ -z "$RULE_OUTSTATION_KIA" ] || [ -z "$RULE_PERF_SEDAN" ]; then
  printf '%sSetup did not yield all required fixtures. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

new_trip() {
  # $1=service_type $2=billing_mode $3=customer $4=vehicle $5=date $6=km $7=hours $8=extra_json(optional)
  local extra="${8:-}"
  curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
    -d "{\"service_type\":\"$1\",\"billing_mode\":\"$2\",\"customer_id\":\"$3\",\"vehicle_id\":\"$4\",\"trip_date\":\"$5\",\"total_km\":$6,\"total_hours\":$7${extra}}" \
    | jq -r '.trip.id // empty'
}
finalize_trip() { curl -s -X POST "$BASE_URL/trips/$1/finalize" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null; }

# Core fixture trips
T1=$(new_trip OUTSTATION GST "$CUST_A" "$VEH_K" "$DAYS_AGO_10" 1699 0 ',"total_days":5,"fasttag_rupees":2440')
T2=$(new_trip LOCAL GST "$CUST_A" "$VEH_S" "$DAYS_AGO_8" 217 12)
T3=$(new_trip LOCAL GST "$CUST_M" "$VEH_S" "$DAYS_AGO_5" 300 14)
T4=$(new_trip LOCAL PERFORMANCE "$CUST_A" "$VEH_S" "$DAYS_AGO_3" 300 8)
T5=$(new_trip LOCAL GST "$CUST_C" "$VEH_S" "$YESTERDAY" 100 8)

if [ -z "$T1" ] || [ -z "$T2" ] || [ -z "$T3" ] || [ -z "$T4" ] || [ -z "$T5" ]; then
  printf '%sSetup did not create all core trips. Aborting.%s\n' "$RED" "$RESET"
  echo "T1=$T1 T2=$T2 T3=$T3 T4=$T4 T5=$T5"
  exit 1
fi
for t in "$T1" "$T2" "$T3" "$T4" "$T5"; do finalize_trip "$t"; done

echo "Setup: tenant A (owner+admin+accountant+staff+viewer), tenant B (owner), KIA+SEDAN vehicles, 3 customers, 3 pricing rules, 5 FINALIZED trips (T1-T5)"
echo

echo "Checks"
echo "------"

# ─── Step 1: create DRAFT invoice ───
INV1_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_A\",\"trip_sheet_ids\":[\"$T1\"]}")
INV_1=$(echo "$INV1_RESP" | jq -r '.invoice.id // empty')
INV_1_SUBTOTAL=$(echo "$INV1_RESP" | jq -r '.invoice.subtotal_paise')
INV_1_GRAND_TOTAL=$(echo "$INV1_RESP" | jq -r '.invoice.grand_total_paise')
INV_1_NET_PAYABLE=$(echo "$INV1_RESP" | jq -r '.invoice.net_payable_paise')

STEP1_REASONS=()
[ "$(echo "$INV1_RESP" | jq -r '.invoice.status')" = "DRAFT" ] || STEP1_REASONS+=("status != DRAFT")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.invoice_number')" = "null" ] || STEP1_REASONS+=("invoice_number != null")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.tenant_snapshot')" = "null" ] || STEP1_REASONS+=("tenant_snapshot != null")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.customer_snapshot')" = "null" ] || STEP1_REASONS+=("customer_snapshot != null")
[ "$(echo "$INV1_RESP" | jq -r '.invoice.issued_at')" = "null" ] || STEP1_REASONS+=("issued_at != null")

if [ -n "$INV_1" ] && [ ${#STEP1_REASONS[@]} -eq 0 ]; then
  pass "DRAFT invoice created: status DRAFT, invoice_number/snapshots/issued_at all null"
else
  fail "Create DRAFT invoice (Step 1)" "$(IFS='; '; echo "${STEP1_REASONS[*]}")"
fi

# ─── Step 2: staff cannot issue ───
STEP2_STATUS=$(curl -s -o "$WORK_DIR/step2.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_1/issue" -H "Authorization: Bearer $STAFF_A_TOKEN")
STEP2_REQUIRED=$(jq -r '.error.details.required // empty' "$WORK_DIR/step2.json")

if [ "$STEP2_STATUS" = "403" ] && [ "$STEP2_REQUIRED" = "invoices:issue" ]; then
  pass "Staff cannot issue: 403 FORBIDDEN (required=invoices:issue)"
else
  fail "Staff cannot issue (Step 2)" "status '$STEP2_STATUS', required '$STEP2_REQUIRED'"
fi

# ─── Step 3: accountant issues INV_1 ───
INV3_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_1/issue" -H "Authorization: Bearer $ACCT_A_TOKEN")
STEP3_REASONS=()
[ "$(echo "$INV3_RESP" | jq -r '.invoice.status')" = "ISSUED" ] || STEP3_REASONS+=("status != ISSUED")
echo "$INV3_RESP" | jq -r '.invoice.invoice_number' | grep -qE '^PRA-[0-9]+/[0-9]{2}-[0-9]{2}$' || STEP3_REASONS+=("invoice_number format wrong: $(echo "$INV3_RESP" | jq -r '.invoice.invoice_number')")
[ "$(echo "$INV3_RESP" | jq -r '.invoice.issued_at')" != "null" ] || STEP3_REASONS+=("issued_at is null")
[ "$(echo "$INV3_RESP" | jq -r '.invoice.issued_by')" = "$ACCT_A_USER_ID" ] || STEP3_REASONS+=("issued_by != accountant's user id")
[ "$(echo "$INV3_RESP" | jq -r '.invoice.tenant_snapshot.name')" = "Pravasi Tours" ] || STEP3_REASONS+=("tenant_snapshot.name wrong")
[ "$(echo "$INV3_RESP" | jq -r '.invoice.tenant_snapshot.gstin')" = "29ABCDE1234F1Z5" ] || STEP3_REASONS+=("tenant_snapshot.gstin wrong")
[ "$(echo "$INV3_RESP" | jq -r '.invoice.tenant_snapshot.bank_details.account_number')" = "12345678" ] || STEP3_REASONS+=("tenant_snapshot.bank_details missing/wrong")
[ "$(echo "$INV3_RESP" | jq -r '.invoice.customer_snapshot.company_name')" = "Acme Logistics" ] || STEP3_REASONS+=("customer_snapshot.company_name wrong")
[ "$(echo "$INV3_RESP" | jq -r '.invoice.customer_snapshot.gstin')" = "29XXXXX1234A1Z6" ] || STEP3_REASONS+=("customer_snapshot.gstin wrong")
[ "$(echo "$INV3_RESP" | jq -r '.invoice.customer_snapshot.credit_days')" = "15" ] || STEP3_REASONS+=("customer_snapshot.credit_days != 15")
[ -n "$(echo "$INV3_RESP" | jq -r '.invoice.amount_in_words')" ] && [ "$(echo "$INV3_RESP" | jq -r '.invoice.amount_in_words')" != "null" ] || STEP3_REASONS+=("amount_in_words empty")

if [ ${#STEP3_REASONS[@]} -eq 0 ]; then
  pass "Accountant issues INV_1: number allocated (PRA-1/FY), snapshots frozen with real tenant/customer data"
else
  fail "Issue INV_1 (Step 3)" "$(IFS='; '; echo "${STEP3_REASONS[*]}") -- resp: $INV3_RESP"
fi

T1_AFTER_ISSUE=$(curl -s "$BASE_URL/trips/$T1" -H "Authorization: Bearer $OWNER_A_TOKEN")
if [ "$(echo "$T1_AFTER_ISSUE" | jq -r '.trip.status')" = "INVOICED" ] && \
   [ "$(echo "$T1_AFTER_ISSUE" | jq -r '.trip.invoice_id')" = "$INV_1" ] && \
   [ "$(echo "$T1_AFTER_ISSUE" | jq -r '.trip.held_by_invoice_id')" = "null" ]; then
  pass "T1 transitions FINALIZED -> INVOICED on issue: invoice_id set, held_by_invoice_id cleared"
else
  fail "T1 status after issue" "$(echo "$T1_AFTER_ISSUE" | jq -c '.trip | {status, invoice_id, held_by_invoice_id}')"
fi

# ─── Step 4: re-issue rejected ───
STEP4_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_1/issue" -H "Authorization: Bearer $ACCT_A_TOKEN")
STEP4_ALLOWED=$(echo "$STEP4_RESP" | jq -c '.error.details.allowed_transitions')

if [ "$(echo "$STEP4_RESP" | jq -r '.error.code')" = "INVALID_INVOICE_STATE_TRANSITION" ] && \
   [ "$(echo "$STEP4_RESP" | jq -r '.error.details.current_status')" = "ISSUED" ] && \
   [ "$STEP4_ALLOWED" = '["PAID","CANCELLED"]' ]; then
  pass "Re-issuing an ISSUED invoice: 409 INVALID_INVOICE_STATE_TRANSITION, allowed_transitions=[PAID,CANCELLED]"
else
  fail "Re-issue rejected (Step 4)" "code '$(echo "$STEP4_RESP" | jq -r '.error.code')', allowed '$STEP4_ALLOWED'"
fi

# ─── Step 5: PATCH ISSUED invoice rejected ───
STEP5_RESP=$(curl -s -X PATCH "$BASE_URL/invoices/$INV_1" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"notes":"trying to edit"}')
if [ "$(echo "$STEP5_RESP" | jq -r '.error.code')" = "INVOICE_NOT_EDITABLE" ] && [ "$(echo "$STEP5_RESP" | jq -r '.error.details.current_status')" = "ISSUED" ]; then
  pass "PATCH on ISSUED invoice: 409 INVOICE_NOT_EDITABLE"
else
  fail "PATCH ISSUED rejected (Step 5)" "$(echo "$STEP5_RESP" | jq -c '.error')"
fi

# ─── Step 6: DELETE ISSUED invoice rejected ───
STEP6_RESP=$(curl -s -X DELETE "$BASE_URL/invoices/$INV_1" -H "Authorization: Bearer $ACCT_A_TOKEN")
if [ "$(echo "$STEP6_RESP" | jq -r '.error.code')" = "INVOICE_NOT_DELETABLE" ]; then
  pass "DELETE on ISSUED invoice: 409 INVOICE_NOT_DELETABLE"
else
  fail "DELETE ISSUED rejected (Step 6)" "$(echo "$STEP6_RESP" | jq -c '.error')"
fi

# ─── Step 7: line description edit on ISSUED rejected ───
GET7=$(curl -s "$BASE_URL/invoices/$INV_1" -H "Authorization: Bearer $ACCT_A_TOKEN")
LINE_INV1_ID=$(echo "$GET7" | jq -r '.invoice.lines[0].id')
STEP7_RESP=$(curl -s -X PATCH "$BASE_URL/invoices/$INV_1/lines/$LINE_INV1_ID" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"description":"x"}')
if [ "$(echo "$STEP7_RESP" | jq -r '.error.code')" = "INVOICE_NOT_EDITABLE" ]; then
  pass "Line description edit on ISSUED invoice: 409 INVOICE_NOT_EDITABLE"
else
  fail "Line edit ISSUED rejected (Step 7)" "$(echo "$STEP7_RESP" | jq -c '.error')"
fi

# ─── Step 8: snapshot immutability — rename tenant, INV_1's snapshot unchanged ───
curl -s -X PATCH "$BASE_URL/settings/business" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Pravasi Tours (renamed)"}' > /dev/null
GET8=$(curl -s "$BASE_URL/invoices/$INV_1" -H "Authorization: Bearer $ACCT_A_TOKEN")
if [ "$(echo "$GET8" | jq -r '.invoice.tenant_snapshot.name')" = "Pravasi Tours" ]; then
  pass "Snapshot immutability: renaming the tenant does NOT retroactively change INV_1's frozen tenant_snapshot.name"
else
  fail "Snapshot immutability (Step 8)" "got '$(echo "$GET8" | jq -r '.invoice.tenant_snapshot.name')'"
fi

# ─── Step 9: second invoice — number increments ───
INV9_DRAFT=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_A\",\"trip_sheet_ids\":[\"$T2\"]}")
INV_2=$(echo "$INV9_DRAFT" | jq -r '.invoice.id')
INV9_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_2/issue" -H "Authorization: Bearer $ACCT_A_TOKEN")

if echo "$INV9_RESP" | jq -r '.invoice.invoice_number' | grep -qE '^PRA-2/[0-9]{2}-[0-9]{2}$'; then
  pass "Second TAX invoice number increments sequentially: $(echo "$INV9_RESP" | jq -r '.invoice.invoice_number')"
else
  fail "Sequential numbering (Step 9)" "got '$(echo "$INV9_RESP" | jq -r '.invoice.invoice_number')'"
fi

# ─── Step 10: PERFORMANCE invoice uses a separate sequence ───
INV10_DRAFT=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"PERFORMANCE\",\"customer_id\":\"$CUST_A\",\"trip_sheet_ids\":[\"$T4\"]}")
INV_PERF=$(echo "$INV10_DRAFT" | jq -r '.invoice.id')
INV10_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_PERF/issue" -H "Authorization: Bearer $ACCT_A_TOKEN")

STEP10_REASONS=()
echo "$INV10_RESP" | jq -r '.invoice.invoice_number' | grep -qE '^PRA-PS-1/[0-9]{2}-[0-9]{2}$' || STEP10_REASONS+=("invoice_number wrong: $(echo "$INV10_RESP" | jq -r '.invoice.invoice_number')")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.gst_rate_snapshot')" = "null" ] || STEP10_REASONS+=("gst_rate_snapshot != null")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.cgst_paise')" = "0" ] || STEP10_REASONS+=("cgst_paise != 0")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.sgst_paise')" = "0" ] || STEP10_REASONS+=("sgst_paise != 0")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.igst_paise')" = "0" ] || STEP10_REASONS+=("igst_paise != 0")
[ "$(echo "$INV10_RESP" | jq -r '.invoice.total_gst_paise')" = "0" ] || STEP10_REASONS+=("total_gst_paise != 0")

if [ ${#STEP10_REASONS[@]} -eq 0 ]; then
  pass "PERFORMANCE invoice uses its own PRA-PS-1 sequence, zero GST fields"
else
  fail "PERFORMANCE numbering/GST (Step 10)" "$(IFS='; '; echo "${STEP10_REASONS[*]}")"
fi

# ─── Step 11: cancel a DRAFT — no credit note ───
INV11_DRAFT=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_C\",\"trip_sheet_ids\":[\"$T5\"]}")
INV_5_DRAFT=$(echo "$INV11_DRAFT" | jq -r '.invoice.id')
INV11_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_5_DRAFT/cancel" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"Wrong customer selected"}')

STEP11_REASONS=()
[ "$(echo "$INV11_RESP" | jq -r '.invoice.status')" = "CANCELLED" ] || STEP11_REASONS+=("status != CANCELLED")
[ "$(echo "$INV11_RESP" | jq -r '.invoice.cancelled_at')" != "null" ] || STEP11_REASONS+=("cancelled_at is null")
[ "$(echo "$INV11_RESP" | jq -r '.invoice.cancellation_reason')" = "Wrong customer selected" ] || STEP11_REASONS+=("cancellation_reason wrong")
[ "$(echo "$INV11_RESP" | jq -r '.credit_note')" = "null" ] || STEP11_REASONS+=("credit_note != null for a DRAFT cancel")

T5_AFTER=$(curl -s "$BASE_URL/trips/$T5" -H "Authorization: Bearer $OWNER_A_TOKEN")
[ "$(echo "$T5_AFTER" | jq -r '.trip.status')" = "FINALIZED" ] || STEP11_REASONS+=("T5 status != FINALIZED after DRAFT cancel")
[ "$(echo "$T5_AFTER" | jq -r '.trip.held_by_invoice_id')" = "null" ] || STEP11_REASONS+=("T5 hold not released")

if [ ${#STEP11_REASONS[@]} -eq 0 ]; then
  pass "Cancel a DRAFT invoice: no credit note, T5's hold released and status back to FINALIZED"
else
  fail "Cancel DRAFT (Step 11)" "$(IFS='; '; echo "${STEP11_REASONS[*]}")"
fi

# ─── Step 12: cancel an ISSUED invoice — credit note issued ───
INV12_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_1/cancel" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"Customer disputed billing"}')
CN_1=$(echo "$INV12_RESP" | jq -r '.credit_note.id // empty')
CREDIT_NOTE_COUNT=$((CREDIT_NOTE_COUNT + 1))

STEP12_REASONS=()
[ "$(echo "$INV12_RESP" | jq -r '.invoice.status')" = "CANCELLED" ] || STEP12_REASONS+=("invoice status != CANCELLED")
[ -n "$CN_1" ] || STEP12_REASONS+=("credit_note_id missing")
[ "$(echo "$INV12_RESP" | jq -r '.invoice.credit_note_id')" = "$CN_1" ] || STEP12_REASONS+=("invoice.credit_note_id != credit_note.id")
echo "$INV12_RESP" | jq -r '.credit_note.credit_note_number' | grep -qE '^PRA-CN-[0-9]+/[0-9]{2}-[0-9]{2}$' || STEP12_REASONS+=("credit_note_number format wrong")
[ "$(echo "$INV12_RESP" | jq -r '.credit_note.original_invoice_id')" = "$INV_1" ] || STEP12_REASONS+=("original_invoice_id != INV_1")
# Rule 11: self-consistency against INV_1's OWN totals (captured at
# Step 1/3), not a freshly re-derived pricing calculation.
[ "$(echo "$INV12_RESP" | jq -r '.credit_note.subtotal_paise')" = "$INV_1_SUBTOTAL" ] || STEP12_REASONS+=("credit_note.subtotal_paise != invoice's own subtotal_paise")
[ "$(echo "$INV12_RESP" | jq -r '.credit_note.grand_total_paise')" = "$INV_1_GRAND_TOTAL" ] || STEP12_REASONS+=("credit_note.grand_total_paise != invoice's own grand_total_paise")
[ "$(echo "$INV12_RESP" | jq -r '.credit_note.net_payable_paise')" = "$INV_1_NET_PAYABLE" ] || STEP12_REASONS+=("credit_note.net_payable_paise != invoice's own net_payable_paise")
# The credit note snapshots tenant/customer state AT CANCEL TIME (now),
# not at the original invoice's issue time — so unlike INV_1's OWN
# tenant_snapshot (frozen pre-rename, see Step 8), the credit note
# correctly shows the CURRENT (renamed) name. This is the intended
# behavior: each document snapshots independently, at its own moment
# of creation.
[ "$(echo "$INV12_RESP" | jq -r '.credit_note.tenant_snapshot.name')" = "Pravasi Tours (renamed)" ] || STEP12_REASONS+=("credit_note.tenant_snapshot.name should reflect the CURRENT (renamed) name at cancel time")
[ "$(echo "$INV12_RESP" | jq -r '.credit_note.customer_snapshot.company_name')" = "Acme Logistics" ] || STEP12_REASONS+=("credit_note.customer_snapshot.company_name wrong")
[ "$(echo "$INV12_RESP" | jq -r '.credit_note.reason')" = "Customer disputed billing" ] || STEP12_REASONS+=("credit_note.reason wrong")
[ -n "$(echo "$INV12_RESP" | jq -r '.credit_note.amount_in_words')" ] && [ "$(echo "$INV12_RESP" | jq -r '.credit_note.amount_in_words')" != "null" ] || STEP12_REASONS+=("credit_note.amount_in_words empty")

if [ ${#STEP12_REASONS[@]} -eq 0 ]; then
  pass "Cancel ISSUED invoice: credit note $( echo "$INV12_RESP" | jq -r '.credit_note.credit_note_number') issued, totals mirror the invoice, snapshot reflects current tenant state"
else
  fail "Cancel ISSUED with credit note (Step 12)" "$(IFS='; '; echo "${STEP12_REASONS[*]}") -- resp: $INV12_RESP"
fi

T1_AFTER_CANCEL=$(curl -s "$BASE_URL/trips/$T1" -H "Authorization: Bearer $OWNER_A_TOKEN")
if [ "$(echo "$T1_AFTER_CANCEL" | jq -r '.trip.status')" = "FINALIZED" ] && [ "$(echo "$T1_AFTER_CANCEL" | jq -r '.trip.invoice_id')" = "null" ]; then
  pass "T1 reversed INVOICED -> FINALIZED on cancel, invoice_id cleared (re-invoiceable)"
else
  fail "T1 status after cancel" "$(echo "$T1_AFTER_CANCEL" | jq -c '.trip | {status, invoice_id}')"
fi

# ─── Step 13: CANCELLED invoice is immutable ───
STEP13_RESP=$(curl -s -X PATCH "$BASE_URL/invoices/$INV_1" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" -d '{"notes":"x"}')
if [ "$(echo "$STEP13_RESP" | jq -r '.error.code')" = "INVOICE_NOT_EDITABLE" ]; then
  pass "PATCH on CANCELLED invoice: 409 INVOICE_NOT_EDITABLE"
else
  fail "PATCH CANCELLED rejected (Step 13)" "$(echo "$STEP13_RESP" | jq -c '.error')"
fi

# ─── Step 14: cancel a CANCELLED invoice ───
STEP14_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_1/cancel" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" -d '{"reason":"try again"}')
if [ "$(echo "$STEP14_RESP" | jq -r '.error.code')" = "INVALID_INVOICE_STATE_TRANSITION" ] && \
   [ "$(echo "$STEP14_RESP" | jq -r '.error.details.current_status')" = "CANCELLED" ] && \
   [ "$(echo "$STEP14_RESP" | jq -c '.error.details.allowed_transitions')" = "[]" ]; then
  pass "Cancel an already-CANCELLED invoice: 409 INVALID_INVOICE_STATE_TRANSITION, allowed_transitions=[]"
else
  fail "Cancel CANCELLED rejected (Step 14)" "$(echo "$STEP14_RESP" | jq -c '.error')"
fi

# ─── Step 15: cancel without reason ───
INV15_DRAFT=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_M\",\"trip_sheet_ids\":[\"$T3\"]}")
INV_X=$(echo "$INV15_DRAFT" | jq -r '.invoice.id')
curl -s -X POST "$BASE_URL/invoices/$INV_X/issue" -H "Authorization: Bearer $ACCT_A_TOKEN" > /dev/null

STEP15_STATUS=$(curl -s -o "$WORK_DIR/step15.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_X/cancel" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" -d '{}')
STEP15_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step15.json")

if [ "$STEP15_STATUS" = "400" ] && [ "$STEP15_CODE" = "VALIDATION_ERROR" ]; then
  pass "Cancel without a reason: 400 VALIDATION_ERROR"
else
  fail "Cancel without reason (Step 15)" "status '$STEP15_STATUS', code '$STEP15_CODE'"
fi

# ─── Step 16: cancel by staff -> 403 ───
STEP16_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_X/cancel" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" -d '{"reason":"test"}')
if [ "$(echo "$STEP16_RESP" | jq -r '.error.code')" = "FORBIDDEN" ] && [ "$(echo "$STEP16_RESP" | jq -r '.error.details.required')" = "invoices:cancel" ]; then
  pass "Cancel by staff: 403 FORBIDDEN (required=invoices:cancel)"
else
  fail "Staff cannot cancel (Step 16)" "$(echo "$STEP16_RESP" | jq -c '.error')"
fi

# ─── Step 17: cancel by accountant -> 403 (only admin+ can cancel) ───
STEP17_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_X/cancel" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" -d '{"reason":"test"}')
if [ "$(echo "$STEP17_RESP" | jq -r '.error.code')" = "FORBIDDEN" ]; then
  pass "Cancel by accountant: 403 FORBIDDEN (invoices:cancel is owner/admin only)"
else
  fail "Accountant cannot cancel (Step 17)" "$(echo "$STEP17_RESP" | jq -c '.error')"
fi

# ─── Step 18: re-invoicing after cancel — T1 is reusable ───
STEP18_STATUS=$(curl -s -o "$WORK_DIR/step18.json" -w '%{http_code}' -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_A\",\"trip_sheet_ids\":[\"$T1\"]}")

if [ "$STEP18_STATUS" = "201" ]; then
  pass "Re-invoicing T1 after its original invoice was cancelled: 201 (trip is FINALIZED and unheld again)"
else
  fail "Re-invoice after cancel (Step 18)" "status '$STEP18_STATUS', body $(cat "$WORK_DIR/step18.json")"
fi

# ─── Step 19: concurrent issue race — 5 distinct invoices ───
RACE_INV_IDS=()
for i in $(seq 1 5); do
  t=$(new_trip LOCAL GST "$CUST_A" "$VEH_S" "$YESTERDAY" 70 6)
  finalize_trip "$t"
  d=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
    -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_A\",\"trip_sheet_ids\":[\"$t\"]}" | jq -r '.invoice.id // empty')
  RACE_INV_IDS+=("$d")
done

for i in $(seq 1 5); do
  curl -s -o "$WORK_DIR/race-$i.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/${RACE_INV_IDS[$((i-1))]}/issue" \
    -H "Authorization: Bearer $ACCT_A_TOKEN" > "$WORK_DIR/race-$i.status" &
done
wait

RACE_200_COUNT=0
RACE_NUMBERS=()
for i in $(seq 1 5); do
  code=$(cat "$WORK_DIR/race-$i.status" 2>/dev/null)
  if [ "$code" = "200" ]; then
    RACE_200_COUNT=$((RACE_200_COUNT + 1))
    num=$(jq -r '.invoice.invoice_number' "$WORK_DIR/race-$i.json")
    seq_part=$(echo "$num" | sed -E 's/^PRA-([0-9]+)\/.*$/\1/')
    RACE_NUMBERS+=("$seq_part")
  fi
done

SORTED_NUMBERS=$(printf '%s\n' "${RACE_NUMBERS[@]}" | sort -n | tr '\n' ',' | sed 's/,$//')
UNIQUE_COUNT=$(printf '%s\n' "${RACE_NUMBERS[@]}" | sort -n -u | wc -l | tr -d '[:space:]')
CONTIGUOUS="true"
MIN_SEQ=$(printf '%s\n' "${RACE_NUMBERS[@]}" | sort -n | head -1)
i=0
for n in $(printf '%s\n' "${RACE_NUMBERS[@]}" | sort -n); do
  expected=$((MIN_SEQ + i))
  [ "$n" = "$expected" ] || CONTIGUOUS="false"
  i=$((i + 1))
done

if [ "$RACE_200_COUNT" = "5" ] && [ "$UNIQUE_COUNT" = "5" ] && [ "$CONTIGUOUS" = "true" ]; then
  pass "5 concurrent issues on 5 distinct invoices: all 200, sequence numbers distinct and contiguous ($SORTED_NUMBERS)"
else
  fail "Concurrent issue, distinct invoices (Step 19)" "200s=$RACE_200_COUNT, unique=$UNIQUE_COUNT, contiguous=$CONTIGUOUS, numbers=$SORTED_NUMBERS"
fi

# ─── Step 20: concurrent issue on the SAME invoice ───
T_SAME=$(new_trip LOCAL GST "$CUST_A" "$VEH_S" "$YESTERDAY" 70 6)
finalize_trip "$T_SAME"
INV_SAME=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_A\",\"trip_sheet_ids\":[\"$T_SAME\"]}" | jq -r '.invoice.id // empty')

for i in $(seq 1 5); do
  curl -s -o "$WORK_DIR/same-$i.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_SAME/issue" \
    -H "Authorization: Bearer $ACCT_A_TOKEN" > "$WORK_DIR/same-$i.status" &
done
wait

SAME_200=0
SAME_409=0
SAME_OTHER=0
for i in $(seq 1 5); do
  code=$(cat "$WORK_DIR/same-$i.status" 2>/dev/null)
  err=$(jq -r '.error.code // empty' "$WORK_DIR/same-$i.json" 2>/dev/null)
  if [ "$code" = "200" ]; then
    SAME_200=$((SAME_200 + 1))
  elif [ "$code" = "409" ] && [ "$err" = "INVALID_INVOICE_STATE_TRANSITION" ]; then
    SAME_409=$((SAME_409 + 1))
  else
    SAME_OTHER=$((SAME_OTHER + 1))
  fi
done

if [ "$SAME_200" = "1" ] && [ "$SAME_409" = "4" ] && [ "$SAME_OTHER" = "0" ]; then
  pass "5 concurrent issues on the SAME invoice: exactly 1×200, 4×409 INVALID_INVOICE_STATE_TRANSITION"
else
  fail "Concurrent issue, same invoice (Step 20)" "200s=$SAME_200, 409s=$SAME_409, other=$SAME_OTHER"
fi

# ─── Step 21: skipped — a DRAFT trip can never reach an invoice at all
# (Task 4.1 rejects TRIP_NOT_FINALIZED at draft creation), so there is
# no live HTTP path that could even attempt to issue one. Nothing to test.

# ─── Step 22: multi-trip invoice cancels ALL its trips back to FINALIZED ───
T_MULTI_1=$(new_trip LOCAL GST "$CUST_A" "$VEH_S" "$DAYS_AGO_2" 70 6)
T_MULTI_2=$(new_trip LOCAL GST "$CUST_A" "$VEH_S" "$DAYS_AGO_2" 70 6)
finalize_trip "$T_MULTI_1"
finalize_trip "$T_MULTI_2"

INV22_DRAFT=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_A\",\"trip_sheet_ids\":[\"$T_MULTI_1\",\"$T_MULTI_2\"]}")
INV_MULTI=$(echo "$INV22_DRAFT" | jq -r '.invoice.id')
curl -s -X POST "$BASE_URL/invoices/$INV_MULTI/issue" -H "Authorization: Bearer $ACCT_A_TOKEN" > /dev/null
# Cancelled by ADMIN here (not owner) — exercises the other role in
# invoices:cancel=[owner,admin] that Steps 16/17 didn't cover.
INV22_CANCEL=$(curl -s -X POST "$BASE_URL/invoices/$INV_MULTI/cancel" -H "Authorization: Bearer $ADMIN_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"Duplicate invoice created by mistake"}')
CREDIT_NOTE_COUNT=$((CREDIT_NOTE_COUNT + 1))

M1_STATUS=$(curl -s "$BASE_URL/trips/$T_MULTI_1" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.trip.status')
M2_STATUS=$(curl -s "$BASE_URL/trips/$T_MULTI_2" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.trip.status')

if [ "$(echo "$INV22_CANCEL" | jq -r '.invoice.status')" = "CANCELLED" ] && [ "$M1_STATUS" = "FINALIZED" ] && [ "$M2_STATUS" = "FINALIZED" ]; then
  pass "Admin cancels a multi-trip ISSUED invoice: BOTH trips reverse INVOICED -> FINALIZED"
else
  fail "Multi-trip cancel reversal (Step 22)" "invoice status '$(echo "$INV22_CANCEL" | jq -r '.invoice.status')', T_MULTI_1='$M1_STATUS', T_MULTI_2='$M2_STATUS'"
fi

# ─── Step 23: cross-tenant invoice issue -> 404 ───
T_CROSS=$(new_trip LOCAL GST "$CUST_A" "$VEH_S" "$YESTERDAY" 70 6)
finalize_trip "$T_CROSS"
INV_CROSS=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_A\",\"trip_sheet_ids\":[\"$T_CROSS\"]}" | jq -r '.invoice.id // empty')

STEP23_STATUS=$(curl -s -o "$WORK_DIR/step23.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_CROSS/issue" -H "Authorization: Bearer $OWNER_B_TOKEN")
STEP23_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step23.json")

if [ "$STEP23_STATUS" = "404" ] && [ "$STEP23_CODE" = "INVOICE_NOT_FOUND" ]; then
  pass "Cross-tenant invoice issue: 404 INVOICE_NOT_FOUND"
else
  fail "Cross-tenant issue (Step 23)" "status '$STEP23_STATUS', code '$STEP23_CODE'"
fi

# ─── Step 24: cross-tenant credit note read -> 404 ───
STEP24_STATUS=$(curl -s -o "$WORK_DIR/step24.json" -w '%{http_code}' "$BASE_URL/credit-notes/$CN_1" -H "Authorization: Bearer $OWNER_B_TOKEN")
STEP24_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step24.json")

if [ "$STEP24_STATUS" = "404" ] && [ "$STEP24_CODE" = "CREDIT_NOTE_NOT_FOUND" ]; then
  pass "Cross-tenant credit note read: 404 CREDIT_NOTE_NOT_FOUND"
else
  fail "Cross-tenant credit note (Step 24)" "status '$STEP24_STATUS', code '$STEP24_CODE'"
fi

# ─── Step 25: list credit notes ───
LIST25=$(curl -s "$BASE_URL/credit-notes" -H "Authorization: Bearer $OWNER_A_TOKEN")
LIST25_LEN=$(echo "$LIST25" | jq '.credit_notes | length')

if [ "$LIST25_LEN" = "$CREDIT_NOTE_COUNT" ]; then
  pass "List credit notes: $LIST25_LEN entries, matches the $CREDIT_NOTE_COUNT credit-note cancellations this script performed"
else
  fail "List credit notes (Step 25)" "expected $CREDIT_NOTE_COUNT, got $LIST25_LEN"
fi

# ─── Step 26: viewer can list/read credit notes ───
STEP26_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/credit-notes" -H "Authorization: Bearer $VIEWER_A_TOKEN")

if [ "$STEP26_STATUS" = "200" ]; then
  pass "Viewer can list credit notes (invoices:read includes viewer): 200"
else
  fail "Viewer credit-note access (Step 26)" "got '$STEP26_STATUS'"
fi

# ─── Step 27: DB-layer RLS ───
DB27_CN=$(psql "${DATABASE_URL:-}" -tAc "SELECT COUNT(*) FROM credit_notes;" 2>/dev/null | tr -d '[:space:]')
DB27_SEQ=$(psql "${DATABASE_URL:-}" -tAc "SELECT COUNT(*) FROM credit_note_number_sequences;" 2>/dev/null | tr -d '[:space:]')

if [ "$DB27_CN" = "0" ] && [ "$DB27_SEQ" = "0" ]; then
  pass "DB-layer isolation: direct psql with no tenant context set sees 0 rows in credit_notes and credit_note_number_sequences"
else
  fail "DB-layer isolation (Step 27)" "credit_notes=$DB27_CN, credit_note_number_sequences=$DB27_SEQ"
fi

# ─── Step 28: amount_in_words well-formed on an issued invoice ───
GET28=$(curl -s "$BASE_URL/invoices/$INV_2" -H "Authorization: Bearer $OWNER_A_TOKEN")
if echo "$GET28" | jq -r '.invoice.amount_in_words' | grep -qE '^Rupees .+ Only$'; then
  pass "amount_in_words on an issued invoice matches /^Rupees .+ Only\$/"
else
  fail "amount_in_words format (Step 28)" "got '$(echo "$GET28" | jq -r '.invoice.amount_in_words')'"
fi

# ─── Step 29: new invoices snapshot the CURRENT (post-rename) tenant state ───
T_SNAP=$(new_trip LOCAL GST "$CUST_A" "$VEH_S" "$YESTERDAY" 70 6)
finalize_trip "$T_SNAP"
INV29_DRAFT=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_A\",\"trip_sheet_ids\":[\"$T_SNAP\"]}")
INV_SNAP=$(echo "$INV29_DRAFT" | jq -r '.invoice.id')
INV29_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_SNAP/issue" -H "Authorization: Bearer $ACCT_A_TOKEN")

if [ "$(echo "$INV29_RESP" | jq -r '.invoice.tenant_snapshot.name')" = "Pravasi Tours (renamed)" ]; then
  pass "A newly issued invoice snapshots the CURRENT tenant name ('Pravasi Tours (renamed)'), unlike INV_1's pre-rename snapshot"
else
  fail "Current-state snapshot on new issue (Step 29)" "got '$(echo "$INV29_RESP" | jq -r '.invoice.tenant_snapshot.name')'"
fi

# ─── Step 30: regression — trip create/list/performance-sheet, and the
# invoiceable picker excluding a not-yet-finalized trip ───
T_REGRESS=$(new_trip LOCAL GST "$CUST_A" "$VEH_S" "$YESTERDAY" 60 5)
STEP30_REASONS=()

LIST30=$(curl -s "$BASE_URL/trips?limit=100" -H "Authorization: Bearer $OWNER_A_TOKEN")
echo "$LIST30" | jq --arg id "$T_REGRESS" '[.trips[].id] | any(. == $id)' | grep -q true || STEP30_REASONS+=("fresh trip missing from GET /trips")

PICK30_BEFORE=$(curl -s "$BASE_URL/customers/$CUST_A/invoiceable-trips" -H "Authorization: Bearer $ACCT_A_TOKEN")
HAS_BEFORE=$(echo "$PICK30_BEFORE" | jq --arg id "$T_REGRESS" '[.groups.LOCAL.trips[], .groups.OUTSTATION.trips[]] | any(.id == $id)')
[ "$HAS_BEFORE" = "false" ] || STEP30_REASONS+=("DRAFT trip appeared in invoiceable picker before finalize")

finalize_trip "$T_REGRESS"
PICK30_AFTER=$(curl -s "$BASE_URL/customers/$CUST_A/invoiceable-trips" -H "Authorization: Bearer $ACCT_A_TOKEN")
HAS_AFTER=$(echo "$PICK30_AFTER" | jq --arg id "$T_REGRESS" '[.groups.LOCAL.trips[], .groups.OUTSTATION.trips[]] | any(.id == $id)')
[ "$HAS_AFTER" = "true" ] || STEP30_REASONS+=("finalized trip missing from invoiceable picker")

PERF30_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/trips/performance-sheet" -H "Authorization: Bearer $OWNER_A_TOKEN")
[ "$PERF30_STATUS" = "200" ] || STEP30_REASONS+=("GET /trips/performance-sheet status '$PERF30_STATUS'")

if [ ${#STEP30_REASONS[@]} -eq 0 ]; then
  pass "Regression: trip create/list, performance sheet, and invoiceable-picker finalize-gating (Modules 3/4.2) all still work"
else
  fail "Regression checks (Step 30)" "$(IFS='; '; echo "${STEP30_REASONS[*]}")"
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
  echo "Tenant A admin: $ADMIN_A_EMAIL"
  echo "Tenant A accountant: $ACCT_A_EMAIL"
  echo "Tenant A staff: $STAFF_A_EMAIL"
  echo "Tenant A viewer: $VIEWER_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 1
else
  printf '%s✓ All %s checks passed. Invoice lifecycle module (Task 4.3) is working correctly.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
  echo
  echo "Tenant A owner: $OWNER_A_EMAIL"
  echo "Tenant A admin: $ADMIN_A_EMAIL"
  echo "Tenant A accountant: $ACCT_A_EMAIL"
  echo "Tenant A staff: $STAFF_A_EMAIL"
  echo "Tenant A viewer: $VIEWER_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 0
fi
