#!/usr/bin/env bash
#
# End-to-end verification of the Task 4.4 payments ledger: recording
# payments against invoices, standalone customer advances, applying
# advances to invoices, payment cancellation, the derived ISSUED<->PAID
# transition, the customer ledger, and the receivables aging report.
# Mirrors scripts/verify-invoice-lifecycle.sh's structure. Prints a
# PASS/FAIL summary and exits 1 if anything failed.
#
# Rule 11: ledger/aging aggregate assertions are checked for
# self-consistency against the entries/buckets in the SAME response,
# not against independently re-derived numbers — same approach as
# verify-invoice-picker.sh's picker summaries. The core payment-amount
# assertions (Steps 1-16ish) ARE exact, since those trace directly to
# fixed, known LOCAL_PACKAGE rule fixtures already proven in
# verify-payments.sh's sibling scripts.
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
OWNER_A_EMAIL="verify-pay-owner-a-$(date +%s)@example.com"
ADMIN_A_EMAIL="verify-pay-admin-a-$(date +%s)-2@example.com"
ACCT_A_EMAIL="verify-pay-acct-a-$(date +%s)-3@example.com"
STAFF_A_EMAIL="verify-pay-staff-a-$(date +%s)-4@example.com"
VIEWER_A_EMAIL="verify-pay-viewer-a-$(date +%s)-5@example.com"
OWNER_B_EMAIL="verify-pay-owner-b-$(date +%s)-6@example.com"

# Rule 8: all trip dates computed as offsets BACK from today.
days_ago() { date -v-"$1"d +%Y-%m-%d; }
days_from_now() { date -v+"$1"d +%Y-%m-%d; }
YESTERDAY=$(days_ago 1)
DAYS_AGO_10=$(days_ago 10)
DAYS_AGO_20=$(days_ago 20)
DAYS_AGO_50=$(days_ago 50)
DAYS_FROM_NOW_50=$(days_from_now 50)

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
OWNER_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
if [ -z "$OWNER_A_TOKEN" ]; then
  printf '%sSetup did not yield an owner A token. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

curl -s -X PATCH "$BASE_URL/settings/business" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"state_code":"KA","trip_sheet_prefix":"PRA"}' > /dev/null

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
  -d "{\"businessName\":\"Verify Payments Co B\",\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner B\"}")
if [ "$(echo "$SIGNUP_B" | jq -r '.tenant.id // empty')" = "" ]; then
  printf '%sSetup signup (tenant B) failed:%s\n' "$RED" "$RESET"
  exit 1
fi
OWNER_B_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')

VEH_S=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA01PY1111","vehicle_type":"SEDAN","make_model":"Honda City"}' | jq -r '.vehicle.id // empty')

CUST_A=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"Acme Logistics","gstin":"29ABCDE1234F1Z5","credit_days":15}' | jq -r '.customer.id // empty')
CUST_M=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"Mumbai Corp","gstin":"27ABCDE1234F1Z5","credit_days":30}' | jq -r '.customer.id // empty')
CUST_C=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2C","name":"Ramesh Iyer","phone":"9876512345","state_code":"KA"}' | jq -r '.customer.id // empty')

RULE_LOCAL_SEDAN=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"LOCAL_PACKAGE","vehicle_type":"SEDAN","label":"SEDAN 8H/80KM","base_hours":8,"base_km":80,"base_price_rupees":2200,"extra_km_rate_rupees":14,"extra_hr_rate_rupees":180,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')

if [ -z "$VEH_S" ] || [ -z "$CUST_A" ] || [ -z "$CUST_M" ] || [ -z "$CUST_C" ] || [ -z "$RULE_LOCAL_SEDAN" ]; then
  printf '%sSetup did not yield all required fixtures. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

# Every trip below is 100km/8h against the same LOCAL_PACKAGE rule:
# base 2200 + extra_km (100-80)*14=280 -> 2480, GST 5% intra-state
# (CUST_A/CUST_C, both KA) = 124 (62 CGST + 62 SGST), grand = 2604.
# CUST_M is inter-state (MH) -> IGST 124 instead, same 2604 total.
# net_payable_paise = 260400 in every case. Confirmed empirically
# against this exact rule fixture before writing this script.
new_trip_and_issue() {
  # $1=customer $2=date -> echoes "trip_id invoice_id"
  local trip_id inv_id
  trip_id=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
    -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$1\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$2\",\"total_km\":100,\"total_hours\":8}" | jq -r '.trip.id // empty')
  curl -s -X POST "$BASE_URL/trips/$trip_id/finalize" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
  inv_id=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
    -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$1\",\"trip_sheet_ids\":[\"$trip_id\"]}" | jq -r '.invoice.id // empty')
  curl -s -X POST "$BASE_URL/invoices/$inv_id/issue" -H "Authorization: Bearer $ACCT_A_TOKEN" > /dev/null
  echo "$trip_id $inv_id"
}

read -r T1 INV_1 <<< "$(new_trip_and_issue "$CUST_A" "$DAYS_AGO_50")"
read -r T2 INV_2 <<< "$(new_trip_and_issue "$CUST_A" "$DAYS_AGO_20")"
read -r T3 INV_3 <<< "$(new_trip_and_issue "$CUST_M" "$DAYS_AGO_10")"
read -r T4 INV_4 <<< "$(new_trip_and_issue "$CUST_C" "$YESTERDAY")"

T5=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_A\",\"vehicle_id\":\"$VEH_S\",\"trip_date\":\"$YESTERDAY\",\"total_km\":100,\"total_hours\":8}" | jq -r '.trip.id // empty')
curl -s -X POST "$BASE_URL/trips/$T5/finalize" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
INV_5=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_A\",\"trip_sheet_ids\":[\"$T5\"]}" | jq -r '.invoice.id // empty')
# INV_5 deliberately stays DRAFT (never issued).

if [ -z "$INV_1" ] || [ -z "$INV_2" ] || [ -z "$INV_3" ] || [ -z "$INV_4" ] || [ -z "$INV_5" ]; then
  printf '%sSetup did not create all invoices. Aborting.%s\n' "$RED" "$RESET"
  echo "INV_1=$INV_1 INV_2=$INV_2 INV_3=$INV_3 INV_4=$INV_4 INV_5=$INV_5"
  exit 1
fi

NET1=$(curl -s "$BASE_URL/invoices/$INV_1" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.invoice.net_payable_paise')
if [ "$NET1" = "260400" ]; then
  pass "Fixture invoice net_payable_paise is exactly 260400 (₹2,604) as pre-computed from the LOCAL_PACKAGE rule"
else
  fail "Fixture math (setup)" "expected net_payable_paise 260400, got '$NET1'"
fi

echo "Setup: tenant A (owner+admin+accountant+staff+viewer), tenant B (owner), SEDAN vehicle, 3 customers, 1 pricing rule, 4 ISSUED invoices (INV_1-4, each ₹2,604) + 1 DRAFT (INV_5)"
echo

echo "Checks"
echo "------"

# ─── Step 1: full payment on ISSUED invoice ───
STEP1_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_1/payments" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"amount_rupees\":2604,\"payment_mode\":\"NEFT\",\"reference_number\":\"NEFT-UTR-001\",\"received_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}")
STEP1_REASONS=()
[ "$(echo "$STEP1_RESP" | jq -r '.payment.amount_paise')" = "260400" ] || STEP1_REASONS+=("amount_paise != 260400")
[ "$(echo "$STEP1_RESP" | jq -r '.payment.invoice_id')" = "$INV_1" ] || STEP1_REASONS+=("invoice_id != INV_1")
[ "$(echo "$STEP1_RESP" | jq -r '.payment.customer_id')" = "$CUST_A" ] || STEP1_REASONS+=("customer_id != CUST_A")
[ "$(echo "$STEP1_RESP" | jq -r '.payment.status')" = "RECORDED" ] || STEP1_REASONS+=("status != RECORDED")
[ "$(echo "$STEP1_RESP" | jq -r '.spillover_advance')" = "null" ] || STEP1_REASONS+=("spillover_advance != null")
[ "$(echo "$STEP1_RESP" | jq -r '.invoice_transitioned_to_paid')" = "true" ] || STEP1_REASONS+=("invoice_transitioned_to_paid != true")
STEP1_INV_STATUS=$(curl -s "$BASE_URL/invoices/$INV_1" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.invoice.status')
[ "$STEP1_INV_STATUS" = "PAID" ] || STEP1_REASONS+=("invoice status != PAID, got '$STEP1_INV_STATUS'")

if [ ${#STEP1_REASONS[@]} -eq 0 ]; then
  pass "Full payment (₹2,604 NEFT) on INV_1: recorded, invoice auto-transitions ISSUED -> PAID"
else
  fail "Full payment (Step 1)" "$(IFS='; '; echo "${STEP1_REASONS[*]}")"
fi

# ─── Step 2: duplicate reference rejected ───
STEP2_STATUS=$(curl -s -o "$WORK_DIR/step2.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_2/payments" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount_rupees":100,"payment_mode":"NEFT","reference_number":"NEFT-UTR-001"}')
STEP2_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step2.json")

if [ "$STEP2_STATUS" = "409" ] && [ "$STEP2_CODE" = "PAYMENT_REFERENCE_DUPLICATE" ]; then
  pass "Duplicate NEFT reference on a different invoice: 409 PAYMENT_REFERENCE_DUPLICATE"
else
  fail "Duplicate reference (Step 2)" "status '$STEP2_STATUS', code '$STEP2_CODE'"
fi

# ─── Step 3: CASH doesn't need a reference ───
STEP3_STATUS=$(curl -s -o "$WORK_DIR/step3.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_2/payments" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount_rupees":100,"payment_mode":"CASH"}')

if [ "$STEP3_STATUS" = "201" ]; then
  pass "CASH payment without reference_number: 201"
else
  fail "CASH no reference (Step 3)" "status '$STEP3_STATUS', body $(cat "$WORK_DIR/step3.json")"
fi

# ─── Step 4: CASH with reference rejected ───
STEP4_STATUS=$(curl -s -o "$WORK_DIR/step4.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_2/payments" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount_rupees":100,"payment_mode":"CASH","reference_number":"should-not-be-allowed"}')
STEP4_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step4.json")

if [ "$STEP4_STATUS" = "400" ] && [ "$STEP4_CODE" = "VALIDATION_ERROR" ]; then
  pass "CASH payment WITH a reference_number: 400 VALIDATION_ERROR"
else
  fail "CASH with reference rejected (Step 4)" "status '$STEP4_STATUS', code '$STEP4_CODE'"
fi

# ─── Step 5: non-CASH without reference rejected ───
STEP5_STATUS=$(curl -s -o "$WORK_DIR/step5.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_2/payments" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount_rupees":100,"payment_mode":"UPI"}')
STEP5_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step5.json")

if [ "$STEP5_STATUS" = "400" ] && [ "$STEP5_CODE" = "VALIDATION_ERROR" ]; then
  pass "UPI payment without reference_number: 400 VALIDATION_ERROR"
else
  fail "Non-CASH without reference (Step 5)" "status '$STEP5_STATUS', code '$STEP5_CODE'"
fi

# ─── Step 6: payment on DRAFT invoice rejected ───
STEP6_STATUS=$(curl -s -o "$WORK_DIR/step6.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_5/payments" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount_rupees":100,"payment_mode":"CASH"}')
STEP6_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step6.json")

if [ "$STEP6_STATUS" = "400" ] && [ "$STEP6_CODE" = "PAYMENT_NOT_ALLOWED_STATE" ]; then
  pass "Payment on a DRAFT invoice: 400 PAYMENT_NOT_ALLOWED_STATE"
else
  fail "Payment on DRAFT (Step 6)" "status '$STEP6_STATUS', code '$STEP6_CODE'"
fi

# ─── Step 7: partial payment ───
STEP7_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_2/payments" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount_rupees":1000,"payment_mode":"UPI","reference_number":"UPI-TXN-001"}')

if [ "$(echo "$STEP7_RESP" | jq -r '.invoice_transitioned_to_paid')" = "false" ]; then
  pass "Partial payment (₹1,000) on INV_2 (already ₹100 CASH paid): does not transition to PAID yet"
else
  fail "Partial payment (Step 7)" "$(echo "$STEP7_RESP" | jq -c '.')"
fi

# ─── Step 8: complete partial -> PAID transition ───
STEP8_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_2/payments" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount_rupees":1504,"payment_mode":"UPI","reference_number":"UPI-TXN-002"}')
STEP8_INV_STATUS=$(curl -s "$BASE_URL/invoices/$INV_2" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.invoice.status')

if [ "$(echo "$STEP8_RESP" | jq -r '.invoice_transitioned_to_paid')" = "true" ] && [ "$STEP8_INV_STATUS" = "PAID" ]; then
  pass "Final ₹15.04... payment (₹1,504) completes INV_2 (100+1000+1504=2604): transitions to PAID"
else
  fail "Complete partial payment (Step 8)" "transitioned '$(echo "$STEP8_RESP" | jq -r '.invoice_transitioned_to_paid')', invoice status '$STEP8_INV_STATUS'"
fi

# ─── Bonus: extra payment on an ALREADY-PAID invoice becomes a pure advance ───
# Verifies the fix documented at the top of payment.service.js — the
# spec's literal split formula would try to insert a zero-amount
# "applied" row here (outstanding = 0), which violates payments' own
# amount_paise > 0 CHECK.
BONUS_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_2/payments" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount_rupees":50,"payment_mode":"CASH"}')
BONUS_REASONS=()
[ "$(echo "$BONUS_RESP" | jq -r '.payment.invoice_id')" = "null" ] || BONUS_REASONS+=("payment.invoice_id should be null (pure advance)")
[ "$(echo "$BONUS_RESP" | jq -r '.payment.amount_paise')" = "5000" ] || BONUS_REASONS+=("payment.amount_paise != 5000")
[ "$(echo "$BONUS_RESP" | jq -r '.payment.customer_id')" = "$CUST_A" ] || BONUS_REASONS+=("payment.customer_id != CUST_A")
[ "$(echo "$BONUS_RESP" | jq -r '.spillover_advance')" = "null" ] || BONUS_REASONS+=("spillover_advance should be null (nothing was split)")

if [ ${#BONUS_REASONS[@]} -eq 0 ]; then
  pass "Extra payment on an already-PAID invoice (₹50 CASH, outstanding=0): becomes a pure unallocated advance, no DB CHECK violation"
else
  fail "Payment on fully-paid invoice becomes advance (bonus)" "$(IFS='; '; echo "${BONUS_REASONS[*]}")"
fi

# ─── Step 9: over-payment splits ───
STEP9_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_3/payments" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount_rupees":3000,"payment_mode":"NEFT","reference_number":"NEFT-UTR-002"}')
STEP9_PAY_ID=$(echo "$STEP9_RESP" | jq -r '.payment.id')
STEP9_REASONS=()
[ "$(echo "$STEP9_RESP" | jq -r '.payment.amount_paise')" = "260400" ] || STEP9_REASONS+=("payment.amount_paise != 260400")
[ "$(echo "$STEP9_RESP" | jq -r '.payment.invoice_id')" = "$INV_3" ] || STEP9_REASONS+=("payment.invoice_id != INV_3")
[ "$(echo "$STEP9_RESP" | jq -r '.spillover_advance.amount_paise')" = "39600" ] || STEP9_REASONS+=("spillover_advance.amount_paise != 39600")
[ "$(echo "$STEP9_RESP" | jq -r '.spillover_advance.invoice_id')" = "null" ] || STEP9_REASONS+=("spillover_advance.invoice_id != null")
[ "$(echo "$STEP9_RESP" | jq -r '.spillover_advance.customer_id')" = "$CUST_M" ] || STEP9_REASONS+=("spillover_advance.customer_id != CUST_M")
[ "$(echo "$STEP9_RESP" | jq -r '.spillover_advance.parent_payment_id')" = "$STEP9_PAY_ID" ] || STEP9_REASONS+=("spillover_advance.parent_payment_id != payment.id")
echo "$STEP9_RESP" | jq -r '.spillover_advance.reference_number' | grep -qE '^NEFT-UTR-002#advance-of-.+$' || STEP9_REASONS+=("spillover_advance.reference_number format wrong")
[ "$(echo "$STEP9_RESP" | jq -r '.invoice_transitioned_to_paid')" = "true" ] || STEP9_REASONS+=("invoice_transitioned_to_paid != true")
STEP9_INV_STATUS=$(curl -s "$BASE_URL/invoices/$INV_3" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.invoice.status')
[ "$STEP9_INV_STATUS" = "PAID" ] || STEP9_REASONS+=("INV_3 status != PAID")

if [ ${#STEP9_REASONS[@]} -eq 0 ]; then
  pass "Over-payment (₹3,000 on a ₹2,604 invoice) splits: ₹2,604 applied + ₹396 spillover advance for CUST_M"
else
  fail "Over-payment split (Step 9)" "$(IFS='; '; echo "${STEP9_REASONS[*]}") -- resp: $STEP9_RESP"
fi

# ─── Step 10: standalone advance ───
STEP10_RESP=$(curl -s -X POST "$BASE_URL/customers/$CUST_A/advances" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount_rupees":5000,"payment_mode":"NEFT","reference_number":"NEFT-UTR-003"}')
ADVANCE_1=$(echo "$STEP10_RESP" | jq -r '.payment.id // empty')
STEP10_REASONS=()
[ "$(echo "$STEP10_RESP" | jq -r '.payment.amount_paise')" = "500000" ] || STEP10_REASONS+=("amount_paise != 500000")
[ "$(echo "$STEP10_RESP" | jq -r '.payment.invoice_id')" = "null" ] || STEP10_REASONS+=("invoice_id != null")
[ "$(echo "$STEP10_RESP" | jq -r '.payment.customer_id')" = "$CUST_A" ] || STEP10_REASONS+=("customer_id != CUST_A")

if [ -n "$ADVANCE_1" ] && [ ${#STEP10_REASONS[@]} -eq 0 ]; then
  pass "Standalone advance for CUST_A (₹5,000 NEFT): recorded with invoice_id=null"
else
  fail "Standalone advance (Step 10)" "$(IFS='; '; echo "${STEP10_REASONS[*]}")"
fi

# ─── Step 11: apply advance to a new invoice — partial consume ───
read -r T6 INV_6 <<< "$(new_trip_and_issue "$CUST_A" "$YESTERDAY")"
STEP11_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_6/apply-advance" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"advance_payment_id\":\"$ADVANCE_1\"}")
STEP11_REASONS=()
[ "$(echo "$STEP11_RESP" | jq -r '.remaining_advance_id')" = "$ADVANCE_1" ] || STEP11_REASONS+=("remaining_advance_id != ADVANCE_1")
[ "$(echo "$STEP11_RESP" | jq -r '.invoice_transitioned_to_paid')" = "true" ] || STEP11_REASONS+=("invoice_transitioned_to_paid != true")
ADVANCE_1_REMAINING=$(curl -s "$BASE_URL/payments/$ADVANCE_1" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.payment.amount_paise')
[ "$ADVANCE_1_REMAINING" = "239600" ] || STEP11_REASONS+=("advance amount_paise != 239600, got '$ADVANCE_1_REMAINING'")

if [ ${#STEP11_REASONS[@]} -eq 0 ]; then
  pass "Apply advance (₹5,000) to INV_6 (₹2,604 outstanding): partial consume, ₹2,396 remains on the advance"
else
  fail "Apply advance partial (Step 11)" "$(IFS='; '; echo "${STEP11_REASONS[*]}") -- resp: $STEP11_RESP"
fi

# ─── Step 12: apply remaining advance to a second new invoice — full consume ───
read -r T7 INV_7 <<< "$(new_trip_and_issue "$CUST_A" "$YESTERDAY")"
STEP12_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_7/apply-advance" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"advance_payment_id\":\"$ADVANCE_1\"}")
STEP12_REASONS=()
[ "$(echo "$STEP12_RESP" | jq -r '.remaining_advance_id')" = "null" ] || STEP12_REASONS+=("remaining_advance_id != null")
ADVANCE_1_AFTER=$(curl -s "$BASE_URL/payments/$ADVANCE_1" -H "Authorization: Bearer $OWNER_A_TOKEN")
[ "$(echo "$ADVANCE_1_AFTER" | jq -r '.payment.invoice_id')" = "$INV_7" ] || STEP12_REASONS+=("advance not reassigned to INV_7")
STEP12_INV7_STATUS=$(curl -s "$BASE_URL/invoices/$INV_7" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.invoice.status')
[ "$STEP12_INV7_STATUS" = "ISSUED" ] || STEP12_REASONS+=("INV_7 status != ISSUED (should still need ₹208 more), got '$STEP12_INV7_STATUS'")

if [ ${#STEP12_REASONS[@]} -eq 0 ]; then
  pass "Apply remaining advance (₹2,396) to INV_7: full consume, advance row reassigned, INV_7 still ISSUED (needs ₹2.08 more)"
else
  fail "Apply advance full consume (Step 12)" "$(IFS='; '; echo "${STEP12_REASONS[*]}")"
fi

# ─── Step 13: cross-customer advance apply rejected ───
ADVANCE_2=$(curl -s -X POST "$BASE_URL/customers/$CUST_M/advances" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount_rupees":1000,"payment_mode":"CASH"}' | jq -r '.payment.id // empty')
read -r T8 INV_8 <<< "$(new_trip_and_issue "$CUST_A" "$YESTERDAY")"
STEP13_STATUS=$(curl -s -o "$WORK_DIR/step13.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_8/apply-advance" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"advance_payment_id\":\"$ADVANCE_2\"}")
STEP13_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step13.json")

if [ "$STEP13_STATUS" = "400" ] && [ "$STEP13_CODE" = "ADVANCE_CUSTOMER_MISMATCH" ]; then
  pass "Applying CUST_M's advance to CUST_A's invoice: 400 ADVANCE_CUSTOMER_MISMATCH"
else
  fail "Cross-customer advance apply (Step 13)" "status '$STEP13_STATUS', code '$STEP13_CODE'"
fi

# ─── Step 14: payment cancellation reverts PAID -> ISSUED ───
PAY_1=$(curl -s "$BASE_URL/payments?invoice_id=$INV_1" -H "Authorization: Bearer $ACCT_A_TOKEN" | jq -r '.payments[0].id // empty')
STEP14_RESP=$(curl -s -X POST "$BASE_URL/payments/$PAY_1/cancel" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"Payment bounced"}')
STEP14_INV1_STATUS=$(curl -s "$BASE_URL/invoices/$INV_1" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.invoice.status')

if [ "$(echo "$STEP14_RESP" | jq -r '.payment.status')" = "CANCELLED" ] && \
   [ "$(echo "$STEP14_RESP" | jq -r '.invoice_reverted')" = "true" ] && \
   [ "$STEP14_INV1_STATUS" = "ISSUED" ]; then
  pass "Cancelling INV_1's payment: payment CANCELLED, invoice_reverted=true, invoice PAID -> ISSUED"
else
  fail "Payment cancellation reverts PAID (Step 14)" "payment status '$(echo "$STEP14_RESP" | jq -r '.payment.status')', reverted '$(echo "$STEP14_RESP" | jq -r '.invoice_reverted')', invoice status '$STEP14_INV1_STATUS'"
fi

# ─── Step 15: cancelled payment's reference can be re-recorded ───
STEP15_STATUS=$(curl -s -o "$WORK_DIR/step15.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_1/payments" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount_rupees":2604,"payment_mode":"NEFT","reference_number":"NEFT-UTR-001"}')

if [ "$STEP15_STATUS" = "201" ]; then
  pass "Re-recording NEFT-UTR-001 after the original was cancelled: 201 (idempotency index only blocks RECORDED rows)"
else
  fail "Re-record cancelled reference (Step 15)" "status '$STEP15_STATUS', body $(cat "$WORK_DIR/step15.json")"
fi

# ─── Step 16: cancel an already-cancelled payment ───
STEP16_STATUS=$(curl -s -o "$WORK_DIR/step16.json" -w '%{http_code}' -X POST "$BASE_URL/payments/$PAY_1/cancel" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"again"}')
STEP16_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step16.json")

if [ "$STEP16_STATUS" = "409" ] && [ "$STEP16_CODE" = "PAYMENT_ALREADY_CANCELLED" ]; then
  pass "Cancelling an already-CANCELLED payment: 409 PAYMENT_ALREADY_CANCELLED"
else
  fail "Cancel already-cancelled (Step 16)" "status '$STEP16_STATUS', code '$STEP16_CODE'"
fi

# ─── Step 17: customer ledger, self-consistent ───
LEDGER17=$(curl -s "$BASE_URL/customers/$CUST_A/ledger" -H "Authorization: Bearer $ACCT_A_TOKEN")
STEP17_REASONS=()
[ "$(echo "$LEDGER17" | jq -r '.customer.id')" = "$CUST_A" ] || STEP17_REASONS+=("customer.id != CUST_A")
for key in total_invoiced_paise total_paid_paise unallocated_advance_paise outstanding_paise; do
  echo "$LEDGER17" | jq -e ".summary | has(\"$key\")" > /dev/null || STEP17_REASONS+=("summary missing $key")
done
HAS_BOTH_TYPES=$(echo "$LEDGER17" | jq '([.entries[].type] | unique | sort) == ["INVOICE","PAYMENT"]')
[ "$HAS_BOTH_TYPES" = "true" ] || STEP17_REASONS+=("entries should mix INVOICE and PAYMENT types")
IS_SORTED=$(echo "$LEDGER17" | jq '
  [.entries[] | (.invoice_date // .received_at)] as $ts
  | $ts == ($ts | sort)
')
[ "$IS_SORTED" = "true" ] || STEP17_REASONS+=("entries not sorted by timestamp ascending")

# Rule 11 self-consistency.
SELF_INVOICED=$(echo "$LEDGER17" | jq '
  .summary.total_invoiced_paise ==
    ([.entries[] | select(.type == "INVOICE" and .status != "CANCELLED") | .debit_paise] | add // 0)
')
[ "$SELF_INVOICED" = "true" ] || STEP17_REASONS+=("total_invoiced_paise doesn't match sum of non-cancelled INVOICE debits")

SELF_PAID=$(echo "$LEDGER17" | jq '
  .summary.total_paid_paise ==
    ([.entries[] | select(.type == "PAYMENT" and .invoice_id != null) | .credit_paise] | add // 0)
')
[ "$SELF_PAID" = "true" ] || STEP17_REASONS+=("total_paid_paise doesn't match sum of invoice-linked PAYMENT credits")

SELF_ADVANCE=$(echo "$LEDGER17" | jq '
  .summary.unallocated_advance_paise ==
    ([.entries[] | select(.type == "PAYMENT" and .invoice_id == null) | .credit_paise] | add // 0)
')
[ "$SELF_ADVANCE" = "true" ] || STEP17_REASONS+=("unallocated_advance_paise doesn't match sum of un-linked PAYMENT credits")

SELF_OUTSTANDING=$(echo "$LEDGER17" | jq '
  .summary.outstanding_paise ==
    (.summary.total_invoiced_paise - .summary.total_paid_paise - .summary.unallocated_advance_paise)
')
[ "$SELF_OUTSTANDING" = "true" ] || STEP17_REASONS+=("outstanding_paise doesn't match total_invoiced - total_paid - unallocated_advance")

if [ ${#STEP17_REASONS[@]} -eq 0 ]; then
  pass "Customer ledger for CUST_A: mixed INVOICE/PAYMENT entries, chronologically sorted, summary self-consistent with entries"
else
  fail "Customer ledger (Step 17)" "$(IFS='; '; echo "${STEP17_REASONS[*]}")"
fi

# ─── Step 18: aging report, self-consistent ───
AGING18=$(curl -s "$BASE_URL/reports/receivables-aging" -H "Authorization: Bearer $ACCT_A_TOKEN")
STEP18_REASONS=()
[ "$(echo "$AGING18" | jq -r '.as_of_date')" != "null" ] || STEP18_REASONS+=("as_of_date missing")
BUCKET_KEYS=$(echo "$AGING18" | jq -c '.summary.buckets_summary | keys | sort')
EXPECTED_KEYS='["CURRENT","DAYS_1_30","DAYS_31_60","DAYS_61_90","DAYS_90_PLUS"]'
[ "$BUCKET_KEYS" = "$EXPECTED_KEYS" ] || STEP18_REASONS+=("buckets_summary keys wrong: $BUCKET_KEYS")

SELF_TOTAL=$(echo "$AGING18" | jq '
  .summary.total_outstanding_paise ==
    ([.summary.buckets_summary[].total_paise] | add // 0)
')
[ "$SELF_TOTAL" = "true" ] || STEP18_REASONS+=("total_outstanding_paise != sum of bucket totals")

SELF_COUNT=$(echo "$AGING18" | jq '
  .summary.total_invoices ==
    ([.summary.buckets_summary[].count] | add // 0)
')
[ "$SELF_COUNT" = "true" ] || STEP18_REASONS+=("total_invoices != sum of bucket counts")

SELF_ENTRIES=$(echo "$AGING18" | jq '
  ([.buckets[].entries[]] | length) as $entryCount
  | ([.summary.buckets_summary[].count] | add // 0) as $bucketCount
  | $entryCount == $bucketCount
')
[ "$SELF_ENTRIES" = "true" ] || STEP18_REASONS+=("total entries across buckets != sum of bucket counts")

TOTAL_OUTSTANDING_18=$(echo "$AGING18" | jq -r '.summary.total_outstanding_paise')
if [ "$TOTAL_OUTSTANDING_18" -gt 0 ] 2>/dev/null; then
  : # expected: INV_4 (CUST_C, never paid) and INV_7 (CUST_A, partially paid) are outstanding
else
  STEP18_REASONS+=("total_outstanding_paise should be > 0, got '$TOTAL_OUTSTANDING_18'")
fi

if [ ${#STEP18_REASONS[@]} -eq 0 ]; then
  pass "Receivables aging report: 5 buckets present, self-consistent totals/counts, total_outstanding_paise=$TOTAL_OUTSTANDING_18"
else
  fail "Aging report (Step 18)" "$(IFS='; '; echo "${STEP18_REASONS[*]}")"
fi

# ─── Step 19: aging with a future as_of_date shifts buckets ───
AGING19=$(curl -s "$BASE_URL/reports/receivables-aging?as_of_date=$DAYS_FROM_NOW_50" -H "Authorization: Bearer $ACCT_A_TOKEN")
TOTAL_OUTSTANDING_19=$(echo "$AGING19" | jq -r '.summary.total_outstanding_paise')
CURRENT_COUNT_18=$(echo "$AGING18" | jq -r '.summary.buckets_summary.CURRENT.count')
CURRENT_COUNT_19=$(echo "$AGING19" | jq -r '.summary.buckets_summary.CURRENT.count')

if [ "$TOTAL_OUTSTANDING_19" = "$TOTAL_OUTSTANDING_18" ] && [ "$CURRENT_COUNT_19" -le "$CURRENT_COUNT_18" ]; then
  pass "Aging as_of_date=+50 days: same total outstanding (no new invoices), but nothing MORE current than today's snapshot"
else
  fail "Future as_of_date shifts buckets (Step 19)" "total18=$TOTAL_OUTSTANDING_18, total19=$TOTAL_OUTSTANDING_19, current18=$CURRENT_COUNT_18, current19=$CURRENT_COUNT_19"
fi

# ─── Step 20: viewer can read ledger ───
STEP20_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/customers/$CUST_A/ledger" -H "Authorization: Bearer $VIEWER_A_TOKEN")

if [ "$STEP20_STATUS" = "200" ]; then
  pass "Viewer can read customer ledger (payments:read includes viewer): 200"
else
  fail "Viewer ledger access (Step 20)" "got '$STEP20_STATUS'"
fi

# ─── Step 21: viewer cannot record payment ───
STEP21_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_5/payments" -H "Authorization: Bearer $VIEWER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount_rupees":100,"payment_mode":"CASH"}')

if [ "$(echo "$STEP21_RESP" | jq -r '.error.code')" = "FORBIDDEN" ] && [ "$(echo "$STEP21_RESP" | jq -r '.error.details.required')" = "payments:record" ]; then
  pass "Viewer cannot record a payment: 403 FORBIDDEN (required=payments:record)"
else
  fail "Viewer forbidden record (Step 21)" "$(echo "$STEP21_RESP" | jq -c '.error')"
fi

# ─── Step 22: staff can record but not cancel ───
read -r T_STAFF INV_STAFF <<< "$(new_trip_and_issue "$CUST_A" "$YESTERDAY")"
STAFF_PAY_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_STAFF/payments" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount_rupees":100,"payment_mode":"CASH"}')
STAFF_PAY_ID=$(echo "$STAFF_PAY_RESP" | jq -r '.payment.id // empty')
STEP22_CANCEL_RESP=$(curl -s -X POST "$BASE_URL/payments/$STAFF_PAY_ID/cancel" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"test"}')

if [ -n "$STAFF_PAY_ID" ] && [ "$(echo "$STEP22_CANCEL_RESP" | jq -r '.error.code')" = "FORBIDDEN" ] && \
   [ "$(echo "$STEP22_CANCEL_RESP" | jq -r '.error.details.required')" = "payments:cancel" ]; then
  pass "Staff can record a payment but not cancel one: 201 then 403 FORBIDDEN (required=payments:cancel)"
else
  fail "Staff record-not-cancel (Step 22)" "staff_pay_id '$STAFF_PAY_ID', cancel error $(echo "$STEP22_CANCEL_RESP" | jq -c '.error')"
fi

# ─── Step 23: accountant can access reports ───
STEP23_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/reports/receivables-aging" -H "Authorization: Bearer $ACCT_A_TOKEN")

if [ "$STEP23_STATUS" = "200" ]; then
  pass "Accountant can access receivables aging report: 200"
else
  fail "Accountant reports access (Step 23)" "got '$STEP23_STATUS'"
fi

# ─── Step 24: staff cannot access reports ───
STEP24_RESP=$(curl -s -X GET "$BASE_URL/reports/receivables-aging" -H "Authorization: Bearer $STAFF_A_TOKEN")

if [ "$(echo "$STEP24_RESP" | jq -r '.error.code')" = "FORBIDDEN" ] && [ "$(echo "$STEP24_RESP" | jq -r '.error.details.required')" = "reports:read" ]; then
  pass "Staff cannot access reports (reports:read excludes staff): 403 FORBIDDEN (required=reports:read)"
else
  fail "Staff reports forbidden (Step 24)" "$(echo "$STEP24_RESP" | jq -c '.error')"
fi

# ─── Step 25: cross-tenant isolation on payments ───
STEP25_STATUS=$(curl -s -o "$WORK_DIR/step25.json" -w '%{http_code}' "$BASE_URL/payments/$PAY_1" -H "Authorization: Bearer $OWNER_B_TOKEN")
STEP25_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step25.json")

if [ "$STEP25_STATUS" = "404" ] && [ "$STEP25_CODE" = "PAYMENT_NOT_FOUND" ]; then
  pass "Cross-tenant payment read: 404 PAYMENT_NOT_FOUND"
else
  fail "Cross-tenant payment (Step 25)" "status '$STEP25_STATUS', code '$STEP25_CODE'"
fi

# ─── Step 26: DB-layer RLS ───
DB26_COUNT=$(psql "${DATABASE_URL:-}" -tAc "SELECT COUNT(*) FROM payments;" 2>/dev/null | tr -d '[:space:]')

if [ "$DB26_COUNT" = "0" ]; then
  pass "DB-layer isolation: direct psql with no tenant context set sees 0 payment rows"
else
  fail "DB-layer isolation (Step 26)" "expected 0, got '$DB26_COUNT'"
fi

# ─── Step 27: received_at cannot be in the future ───
STEP27_STATUS=$(curl -s -o "$WORK_DIR/step27.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_5/payments" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"amount_rupees\":100,\"payment_mode\":\"CASH\",\"received_at\":\"$(days_from_now 30)T00:00:00Z\"}")
STEP27_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step27.json")

if [ "$STEP27_STATUS" = "400" ] && [ "$STEP27_CODE" = "VALIDATION_ERROR" ]; then
  pass "received_at 30 days in the future: 400 VALIDATION_ERROR"
else
  fail "Future received_at (Step 27)" "status '$STEP27_STATUS', code '$STEP27_CODE'"
fi

# ─── Step 28: received_at cannot be more than 90 days in the past ───
STEP28_STATUS=$(curl -s -o "$WORK_DIR/step28.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_5/payments" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"amount_rupees\":100,\"payment_mode\":\"CASH\",\"received_at\":\"$(days_ago 120)T00:00:00Z\"}")
STEP28_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step28.json")

if [ "$STEP28_STATUS" = "400" ] && [ "$STEP28_CODE" = "VALIDATION_ERROR" ]; then
  pass "received_at 120 days in the past (>90 day cap): 400 VALIDATION_ERROR"
else
  fail "Too-old received_at (Step 28)" "status '$STEP28_STATUS', code '$STEP28_CODE'"
fi

# ─── Step 29: list payments with filters ───
LIST29=$(curl -s "$BASE_URL/payments?customer_id=$CUST_A&payment_mode=NEFT" -H "Authorization: Bearer $ACCT_A_TOKEN")
LIST29_ALL_MATCH=$(echo "$LIST29" | jq '[.payments[] | (.customer_id == "'"$CUST_A"'" and .payment_mode == "NEFT")] | all')
LIST29_NONEMPTY=$(echo "$LIST29" | jq '.payments | length > 0')

if [ "$LIST29_ALL_MATCH" = "true" ] && [ "$LIST29_NONEMPTY" = "true" ]; then
  pass "List payments filtered by customer_id + payment_mode=NEFT: all results match both filters"
else
  fail "List payments with filters (Step 29)" "all_match='$LIST29_ALL_MATCH', nonempty='$LIST29_NONEMPTY'"
fi

# ─── Step 30: payment on a CANCELLED invoice rejected ───
# Cancelled by ADMIN here (not owner) — exercises invoices:cancel's
# other permitted role, since every other cancel in this script used
# owner or accountant.
read -r T9 INV_9 <<< "$(new_trip_and_issue "$CUST_A" "$YESTERDAY")"
curl -s -X POST "$BASE_URL/invoices/$INV_9/cancel" -H "Authorization: Bearer $ADMIN_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"Duplicate invoice"}' > /dev/null

STEP30_STATUS=$(curl -s -o "$WORK_DIR/step30.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_9/payments" -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount_rupees":100,"payment_mode":"CASH"}')
STEP30_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step30.json")

if [ "$STEP30_STATUS" = "400" ] && [ "$STEP30_CODE" = "PAYMENT_NOT_ALLOWED_STATE" ]; then
  pass "Payment on a CANCELLED invoice: 400 PAYMENT_NOT_ALLOWED_STATE"
else
  fail "Payment on CANCELLED invoice (Step 30)" "status '$STEP30_STATUS', code '$STEP30_CODE'"
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
  printf '%s✓ All %s checks passed. Payments ledger module (Task 4.4) is working correctly.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
  echo
  echo "Tenant A owner: $OWNER_A_EMAIL"
  echo "Tenant A admin: $ADMIN_A_EMAIL"
  echo "Tenant A accountant: $ACCT_A_EMAIL"
  echo "Tenant A staff: $STAFF_A_EMAIL"
  echo "Tenant A viewer: $VIEWER_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 0
fi
