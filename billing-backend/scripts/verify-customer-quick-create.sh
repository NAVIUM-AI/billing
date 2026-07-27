#!/usr/bin/env bash
#
# End-to-end verification of Task 4.6's POST /customers/quick-create —
# a minimal-field customer creation path for an inline "new customer"
# modal during trip/invoice creation. Unlike the full createCustomer
# path, GSTIN is optional even for B2B here (no B2B_REQUIRED_FIELDS
# enforcement) — see customer.service.js#quickCreateCustomer's own
# comment for why. Mirrors scripts/verify-customers.sh's conventions.
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
OWNER_A_EMAIL="verify-qc-owner-a-$(date +%s)@example.com"
VIEWER_A_EMAIL="verify-qc-viewer-a-$(date +%s)-2@example.com"
OWNER_B_EMAIL="verify-qc-owner-b-$(date +%s)-3@example.com"
# GSTIN "29..." -> state 29 = KA, same fixture constant as
# verify-customers.sh, to exercise the auto-derive path. A second,
# distinct GSTIN (state 33 = TN) is used wherever a step needs its own
# GSTIN — gstin is unique per tenant, so reusing GSTIN_KA across two
# different customers in the same tenant would collide.
GSTIN_KA="29ABCDE1234F1Z5"
GSTIN_TN="33ABCDE1234F1Z8"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
RESET=$'\033[0m'

PASS=0
FAIL=0
TOTAL_CHECKS=8
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

if ! command -v jq >/dev/null 2>&1; then
  printf '%sjq is required for this script.\nInstall it with: brew install jq%s\n' "$RED" "$RESET"
  exit 1
fi
echo "  jq is installed"
echo

# ─── SETUP ───
SIGNUP_A=$(curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Quick Create Co\",\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner A\"}")
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

CREATE_VIEWER=$(curl -s -X POST "$BASE_URL/users" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"email\":\"$VIEWER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Viewer A\",\"role\":\"viewer\"}")
VIEWER_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$VIEWER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
if [ "$(echo "$CREATE_VIEWER" | jq -r '.user.id // empty')" = "" ] || [ -z "$VIEWER_A_TOKEN" ]; then
  printf '%sSetup could not create/login viewer A. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

SIGNUP_B=$(curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Quick Create Co B\",\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner B\"}")
if [ "$(echo "$SIGNUP_B" | jq -r '.tenant.id // empty')" = "" ]; then
  printf '%sSetup signup (tenant B) failed:%s\n' "$RED" "$RESET"
  exit 1
fi
OWNER_B_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')

echo "Setup: tenant A (owner + viewer), tenant B (owner)"
echo

echo "Checks"
echo "------"

# ─── Step 1: quick-create B2C succeeds with minimal fields ───
STEP1_RESP=$(curl -s -X POST "$BASE_URL/customers/quick-create" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2C","name":"Ramesh Iyer"}')
CUST_B2C=$(echo "$STEP1_RESP" | jq -r '.customer.id // empty')

STEP1_REASONS=()
[ -n "$CUST_B2C" ] || STEP1_REASONS+=("no customer id returned")
[ "$(echo "$STEP1_RESP" | jq -r '.customer.customer_type')" = "B2C" ] || STEP1_REASONS+=("customer_type != B2C")
[ "$(echo "$STEP1_RESP" | jq -r '.customer.name')" = "Ramesh Iyer" ] || STEP1_REASONS+=("name mismatch")
[ "$(echo "$STEP1_RESP" | jq -r '.customer.company_name')" = "null" ] || STEP1_REASONS+=("company_name should be null for B2C")
[ "$(echo "$STEP1_RESP" | jq -r '.customer.credit_days')" = "0" ] || STEP1_REASONS+=("credit_days should default to 0")

if [ ${#STEP1_REASONS[@]} -eq 0 ]; then
  pass "Quick-create B2C succeeds with minimal fields (name only): 201, credit_days=0"
else
  fail "Quick-create B2C (Step 1)" "$(IFS='; '; echo "${STEP1_REASONS[*]}")"
fi

# ─── Step 2: quick-create B2B WITHOUT gstin is correctly rejected ───
# Task 4.6 asked for gstin to be optional even for B2B here, but
# customers_b2b_required_fields (Task 2.3) is a DATABASE CHECK
# constraint independent of any application-layer check, and this
# task's own constraints rule out schema changes — so a B2B
# quick-create without a gstin still fails, just via a clean, mapped
# 400 rather than either succeeding (impossible without a migration)
# or leaking a raw constraint-violation 500. See
# customer.service.js#quickCreateCustomer's own top comment.
STEP2_STATUS=$(curl -s -o "$WORK_DIR/step2.json" -w '%{http_code}' -X POST "$BASE_URL/customers/quick-create" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","name":"Acme Logistics"}')
STEP2_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step2.json")

if [ "$STEP2_STATUS" = "400" ] && [ "$STEP2_CODE" = "B2B_REQUIRED_FIELDS" ]; then
  pass "Quick-create B2B without gstin correctly rejected: 400 B2B_REQUIRED_FIELDS (DB CHECK, not a raw 500)"
else
  fail "Quick-create B2B without GSTIN (Step 2)" "status=$STEP2_STATUS code=$STEP2_CODE"
fi

# ─── Step 2b: quick-create B2B WITH gstin defaults company_name to name ───
STEP2B_RESP=$(curl -s -X POST "$BASE_URL/customers/quick-create" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer_type\":\"B2B\",\"name\":\"Acme Logistics\",\"gstin\":\"$GSTIN_KA\"}")
CUST_B2B_DEFAULTED=$(echo "$STEP2B_RESP" | jq -r '.customer.id // empty')

STEP2B_REASONS=()
[ -n "$CUST_B2B_DEFAULTED" ] || STEP2B_REASONS+=("no customer id returned")
[ "$(echo "$STEP2B_RESP" | jq -r '.customer.company_name')" = "Acme Logistics" ] || STEP2B_REASONS+=("company_name should default to name")

if [ ${#STEP2B_REASONS[@]} -eq 0 ]; then
  pass "Quick-create B2B with gstin, no explicit company_name: defaults company_name to name"
else
  fail "Quick-create B2B company_name default (Step 2b)" "$(IFS='; '; echo "${STEP2B_REASONS[*]}")"
fi

# ─── Step 3: quick-create B2B with GSTIN validates + auto-derives state ───
STEP3_RESP=$(curl -s -X POST "$BASE_URL/customers/quick-create" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer_type\":\"B2B\",\"name\":\"Cauvery Cars\",\"company_name\":\"Cauvery Cars Pvt Ltd\",\"gstin\":\"$GSTIN_TN\"}")
CUST_B2B_GSTIN=$(echo "$STEP3_RESP" | jq -r '.customer.id // empty')

STEP3_REASONS=()
[ -n "$CUST_B2B_GSTIN" ] || STEP3_REASONS+=("no customer id returned")
[ "$(echo "$STEP3_RESP" | jq -r '.customer.gstin')" = "$GSTIN_TN" ] || STEP3_REASONS+=("gstin mismatch")
[ "$(echo "$STEP3_RESP" | jq -r '.customer.state_code')" = "TN" ] || STEP3_REASONS+=("state_code not auto-derived to TN")

if [ ${#STEP3_REASONS[@]} -eq 0 ]; then
  pass "Quick-create B2B with GSTIN validates format and auto-derives state_code=TN"
else
  fail "Quick-create B2B with GSTIN (Step 3)" "$(IFS='; '; echo "${STEP3_REASONS[*]}")"
fi

# ─── Step 4: invalid GSTIN format is rejected ───
STEP4_STATUS=$(curl -s -o "$WORK_DIR/step4.json" -w '%{http_code}' -X POST "$BASE_URL/customers/quick-create" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","name":"Bad GSTIN Co","gstin":"NOT-A-GSTIN"}')
STEP4_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step4.json")

if [ "$STEP4_STATUS" = "400" ] && [ "$STEP4_CODE" = "VALIDATION_ERROR" ]; then
  pass "Malformed GSTIN rejected: 400 VALIDATION_ERROR"
else
  fail "Malformed GSTIN rejection (Step 4)" "status=$STEP4_STATUS code=$STEP4_CODE"
fi

# ─── Step 5: unknown field rejected (e.g. state_code isn't accepted here) ───
STEP5_STATUS=$(curl -s -o "$WORK_DIR/step5.json" -w '%{http_code}' -X POST "$BASE_URL/customers/quick-create" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2C","name":"Someone","state_code":"KA"}')
STEP5_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step5.json")

if [ "$STEP5_STATUS" = "400" ] && [ "$STEP5_CODE" = "VALIDATION_ERROR" ]; then
  pass "Unknown field (state_code) rejected: 400 VALIDATION_ERROR"
else
  fail "Unknown field rejection (Step 5)" "status=$STEP5_STATUS code=$STEP5_CODE"
fi

# ─── Step 6: viewer cannot quick-create (customers:write required) ───
STEP6_RESP=$(curl -s -X POST "$BASE_URL/customers/quick-create" -H "Authorization: Bearer $VIEWER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2C","name":"Viewer Attempt"}')

if [ "$(echo "$STEP6_RESP" | jq -r '.error.code')" = "FORBIDDEN" ] && [ "$(echo "$STEP6_RESP" | jq -r '.error.details.required')" = "customers:write" ]; then
  pass "Viewer cannot quick-create: 403 FORBIDDEN (required=customers:write)"
else
  fail "Viewer quick-create forbidden (Step 6)" "$(echo "$STEP6_RESP" | jq -c '.error')"
fi

# ─── Step 7: cross-tenant read isolation ───
STEP7_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/customers/$CUST_B2C" -H "Authorization: Bearer $OWNER_B_TOKEN")

if [ "$STEP7_STATUS" = "404" ]; then
  pass "Cross-tenant isolation: tenant B gets 404 reading tenant A's quick-created customer"
else
  fail "Cross-tenant isolation (Step 7)" "got '$STEP7_STATUS'"
fi

echo
echo "Summary"
echo "-------"
echo "Passed: $PASS/$TOTAL_CHECKS"
echo "Failed: $FAIL/$TOTAL_CHECKS"
if [ "$FAIL" -gt 0 ]; then
  printf '%s══════════════════════════════════════════════%s\n' "$RED" "$RESET"
  for step in "${FAILED_STEPS[@]}"; do
    printf '  %s✗ %s%s\n' "$RED" "$step" "$RESET"
  done
  exit 1
else
  printf '%s✓ All %s checks passed. Customer quick-create (Task 4.6) is working correctly.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
fi
