#!/usr/bin/env bash
#
# End-to-end verification of the Task 1.5 RBAC + business settings +
# user management flow: business profile read/update, permission-gated
# access (owner vs staff), owner self-protection (can't demote or
# deactivate self), and that deactivating a user immediately revokes
# their refresh token. Prints a PASS/FAIL summary and exits 1 if
# anything failed.
#
# Deliberately `set -u` but NOT `set -e`: we want every check to run
# even if an earlier one fails, so the summary reports everything
# that's broken in one pass instead of stopping at the first failure.
set -u

BASE_URL="http://localhost:8000/api/v1"
TEST_PASSWORD="Passw0rd123"
OWNER_EMAIL="verify-rbac-owner-$(date +%s)@example.com"
STAFF_EMAIL="verify-rbac-staff-$(date +%s)-2@example.com"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
TOTAL_CHECKS=16
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

if ! command -v jq >/dev/null 2>&1; then
  printf '%sjq is required for this script.\nInstall it with: brew install jq%s\n' "$RED" "$RESET"
  exit 1
fi
echo "  jq is installed"
echo

# ─── SETUP (a): signup Tenant A's owner, log in ───
SIGNUP_STATUS=$(curl -s -o "$WORK_DIR/signup.json" -w '%{http_code}' -X POST "$BASE_URL/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify RBAC Co\",\"email\":\"$OWNER_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner Tester\"}")
if [ "$SIGNUP_STATUS" != "201" ]; then
  printf '%sSetup signup failed (status %s):%s\n' "$RED" "$SIGNUP_STATUS" "$RESET"
  cat "$WORK_DIR/signup.json"
  echo
  exit 1
fi
OWNER_ID=$(jq -r '.user.id' "$WORK_DIR/signup.json")

OWNER_LOGIN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")
OWNER_ACCESS=$(echo "$OWNER_LOGIN" | jq -r '.accessToken // empty')

if [ -z "$OWNER_ACCESS" ] || [ -z "$OWNER_ID" ]; then
  printf '%sSetup did not yield an owner token/id. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi
echo "Setup: owner ($OWNER_ID) signed up and logged in"
echo

echo "Checks"
echo "------"

# ─── (b): GET /settings/business as owner → 200 with profile ───
GET1_STATUS=$(curl -s -o "$WORK_DIR/get1.json" -w '%{http_code}' "$BASE_URL/settings/business" \
  -H "Authorization: Bearer $OWNER_ACCESS")
GET1_NAME=$(jq -r '.profile.name // empty' "$WORK_DIR/get1.json")

if [ "$GET1_STATUS" = "200" ] && [ -n "$GET1_NAME" ]; then
  pass "GET /settings/business as owner: 200 with profile"
else
  fail "GET /settings/business as owner: 200 with profile" "status '$GET1_STATUS', name '$GET1_NAME'"
fi

# ─── (c): PATCH /settings/business as owner → 200 with updated fields ───
PATCH1_STATUS=$(curl -s -o "$WORK_DIR/patch1.json" -w '%{http_code}' -X PATCH "$BASE_URL/settings/business" \
  -H "Authorization: Bearer $OWNER_ACCESS" -H "Content-Type: application/json" \
  -d '{"invoice_prefix":"ACME","bank_details":{"account_name":"Acme Travels","account_number":"1234567890","ifsc":"HDFC0001234","bank_name":"HDFC"}}')
PATCH1_PREFIX=$(jq -r '.profile.invoice_prefix // empty' "$WORK_DIR/patch1.json")
PATCH1_IFSC=$(jq -r '.profile.bank_details.ifsc // empty' "$WORK_DIR/patch1.json")

STEP_C_REASONS=()
[ "$PATCH1_STATUS" = "200" ] || STEP_C_REASONS+=("expected status 200, got '$PATCH1_STATUS'")
[ "$PATCH1_PREFIX" = "ACME" ] || STEP_C_REASONS+=("invoice_prefix not reflected (got '$PATCH1_PREFIX')")
[ "$PATCH1_IFSC" = "HDFC0001234" ] || STEP_C_REASONS+=("bank_details.ifsc not reflected (got '$PATCH1_IFSC')")

if [ ${#STEP_C_REASONS[@]} -eq 0 ]; then
  pass "PATCH /settings/business as owner: 200, updated fields reflected in response"
else
  fail "PATCH /settings/business as owner: 200, updated fields reflected in response" "$(IFS='; '; echo "${STEP_C_REASONS[*]}")"
fi

# ─── (d): GET /settings/business again → confirms persistence ───
GET2_STATUS=$(curl -s -o "$WORK_DIR/get2.json" -w '%{http_code}' "$BASE_URL/settings/business" \
  -H "Authorization: Bearer $OWNER_ACCESS")
GET2_PREFIX=$(jq -r '.profile.invoice_prefix // empty' "$WORK_DIR/get2.json")

if [ "$GET2_STATUS" = "200" ] && [ "$GET2_PREFIX" = "ACME" ]; then
  pass "GET /settings/business again: persisted invoice_prefix 'ACME'"
else
  fail "GET /settings/business again: persisted invoice_prefix 'ACME'" "status '$GET2_STATUS', invoice_prefix '$GET2_PREFIX'"
fi

# ─── (e): POST /users as owner → 201 ───
CREATE_STAFF_STATUS=$(curl -s -o "$WORK_DIR/create-staff.json" -w '%{http_code}' -X POST "$BASE_URL/users" \
  -H "Authorization: Bearer $OWNER_ACCESS" -H "Content-Type: application/json" \
  -d "{\"email\":\"$STAFF_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Staff One\",\"role\":\"staff\"}")
STAFF_ID=$(jq -r '.user.id // empty' "$WORK_DIR/create-staff.json")

if [ "$CREATE_STAFF_STATUS" = "201" ] && [ -n "$STAFF_ID" ]; then
  pass "POST /users as owner: 201, staff1 created"
else
  fail "POST /users as owner: 201, staff1 created" "status '$CREATE_STAFF_STATUS'"
fi

if [ -z "$STAFF_ID" ]; then
  printf '%sCould not create staff1 — aborting remaining checks that depend on it.%s\n' "$RED" "$RESET"
  STAFF_ID="00000000-0000-0000-0000-000000000000"
fi

# ─── (f): login as staff1 ───
STAFF_LOGIN_RAW=$(curl -s -i -X POST "$BASE_URL/auth/login" -c "$WORK_DIR/staff-cookies.txt" \
  -H "Content-Type: application/json" -d "{\"email\":\"$STAFF_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")
STAFF_ACCESS=$(echo "$STAFF_LOGIN_RAW" | tail -n1 | jq -r '.accessToken // empty')
echo "Setup: staff1 ($STAFF_ID) created and logged in"
echo

# ─── (g): GET /settings/business as staff1 → 200 ───
GET_STAFF_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/settings/business" \
  -H "Authorization: Bearer $STAFF_ACCESS")

if [ "$GET_STAFF_STATUS" = "200" ]; then
  pass "GET /settings/business as staff1: 200 (settings:read allows staff)"
else
  fail "GET /settings/business as staff1: 200 (settings:read allows staff)" "status '$GET_STAFF_STATUS'"
fi

# ─── (h): PATCH /settings/business as staff1 → 403 FORBIDDEN, details.required === settings:update ───
PATCH_STAFF_STATUS=$(curl -s -o "$WORK_DIR/patch-staff.json" -w '%{http_code}' -X PATCH "$BASE_URL/settings/business" \
  -H "Authorization: Bearer $STAFF_ACCESS" -H "Content-Type: application/json" -d '{"name":"Hacked"}')
PATCH_STAFF_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/patch-staff.json")
PATCH_STAFF_REQUIRED=$(jq -r '.error.details.required // empty' "$WORK_DIR/patch-staff.json")

STEP_H_REASONS=()
[ "$PATCH_STAFF_STATUS" = "403" ] || STEP_H_REASONS+=("expected status 403, got '$PATCH_STAFF_STATUS'")
[ "$PATCH_STAFF_CODE" = "FORBIDDEN" ] || STEP_H_REASONS+=("expected code FORBIDDEN, got '$PATCH_STAFF_CODE'")
[ "$PATCH_STAFF_REQUIRED" = "settings:update" ] || STEP_H_REASONS+=("expected details.required 'settings:update', got '$PATCH_STAFF_REQUIRED'")

if [ ${#STEP_H_REASONS[@]} -eq 0 ]; then
  pass "PATCH /settings/business as staff1: 403 FORBIDDEN, details.required = settings:update"
else
  fail "PATCH /settings/business as staff1: 403 FORBIDDEN, details.required = settings:update" "$(IFS='; '; echo "${STEP_H_REASONS[*]}")"
fi

# ─── (i): POST /users as staff1 → 403 ───
CREATE_AS_STAFF_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/users" \
  -H "Authorization: Bearer $STAFF_ACCESS" -H "Content-Type: application/json" \
  -d '{"email":"nope@example.com","password":"Passw0rd123","fullName":"Nope","role":"staff"}')

if [ "$CREATE_AS_STAFF_STATUS" = "403" ]; then
  pass "POST /users as staff1: 403"
else
  fail "POST /users as staff1: 403" "expected 403, got '$CREATE_AS_STAFF_STATUS'"
fi

# ─── (j): GET /users as owner → 200 with >= 2 users ───
LIST_STATUS=$(curl -s -o "$WORK_DIR/list-users.json" -w '%{http_code}' "$BASE_URL/users" \
  -H "Authorization: Bearer $OWNER_ACCESS")
LIST_TOTAL=$(jq -r '.pagination.total // 0' "$WORK_DIR/list-users.json")

if [ "$LIST_STATUS" = "200" ] && [ "$LIST_TOTAL" -ge 2 ]; then
  pass "GET /users as owner: 200 with >= 2 users (got $LIST_TOTAL)"
else
  fail "GET /users as owner: 200 with >= 2 users" "status '$LIST_STATUS', total '$LIST_TOTAL'"
fi

# ─── (k): PATCH /users/{staff1_id}/role as owner → accountant, 200 ───
ROLE_STATUS=$(curl -s -o "$WORK_DIR/role.json" -w '%{http_code}' -X PATCH "$BASE_URL/users/$STAFF_ID/role" \
  -H "Authorization: Bearer $OWNER_ACCESS" -H "Content-Type: application/json" -d '{"role":"accountant"}')
ROLE_VALUE=$(jq -r '.user.role // empty' "$WORK_DIR/role.json")

if [ "$ROLE_STATUS" = "200" ] && [ "$ROLE_VALUE" = "accountant" ]; then
  pass "PATCH /users/{staff1}/role as owner: 200, role now 'accountant'"
else
  fail "PATCH /users/{staff1}/role as owner: 200, role now 'accountant'" "status '$ROLE_STATUS', role '$ROLE_VALUE'"
fi

# ─── (l): PATCH /users/{owner_id}/role as owner (self-demote) → 403 CANNOT_DEMOTE_SELF ───
SELF_DEMOTE_STATUS=$(curl -s -o "$WORK_DIR/self-demote.json" -w '%{http_code}' -X PATCH "$BASE_URL/users/$OWNER_ID/role" \
  -H "Authorization: Bearer $OWNER_ACCESS" -H "Content-Type: application/json" -d '{"role":"admin"}')
SELF_DEMOTE_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/self-demote.json")

if [ "$SELF_DEMOTE_STATUS" = "403" ] && [ "$SELF_DEMOTE_CODE" = "CANNOT_DEMOTE_SELF" ]; then
  pass "PATCH /users/{owner}/role as owner (self-demote): 403 CANNOT_DEMOTE_SELF"
else
  fail "PATCH /users/{owner}/role as owner (self-demote): 403 CANNOT_DEMOTE_SELF" "status '$SELF_DEMOTE_STATUS', code '$SELF_DEMOTE_CODE'"
fi

# ─── (m): PATCH /users/{owner_id}/status as owner (self-deactivate) → 403 CANNOT_DEACTIVATE_SELF ───
SELF_DEACTIVATE_STATUS=$(curl -s -o "$WORK_DIR/self-deactivate.json" -w '%{http_code}' -X PATCH "$BASE_URL/users/$OWNER_ID/status" \
  -H "Authorization: Bearer $OWNER_ACCESS" -H "Content-Type: application/json" -d '{"isActive":false}')
SELF_DEACTIVATE_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/self-deactivate.json")

if [ "$SELF_DEACTIVATE_STATUS" = "403" ] && [ "$SELF_DEACTIVATE_CODE" = "CANNOT_DEACTIVATE_SELF" ]; then
  pass "PATCH /users/{owner}/status as owner (self-deactivate): 403 CANNOT_DEACTIVATE_SELF"
else
  fail "PATCH /users/{owner}/status as owner (self-deactivate): 403 CANNOT_DEACTIVATE_SELF" "status '$SELF_DEACTIVATE_STATUS', code '$SELF_DEACTIVATE_CODE'"
fi

# ─── (n): PATCH /users/{staff1_id}/status as owner → isActive false, 200 ───
DEACTIVATE_STATUS=$(curl -s -o "$WORK_DIR/deactivate.json" -w '%{http_code}' -X PATCH "$BASE_URL/users/$STAFF_ID/status" \
  -H "Authorization: Bearer $OWNER_ACCESS" -H "Content-Type: application/json" -d '{"isActive":false}')
DEACTIVATE_IS_ACTIVE=$(jq -r '.user.is_active' "$WORK_DIR/deactivate.json")

if [ "$DEACTIVATE_STATUS" = "200" ] && [ "$DEACTIVATE_IS_ACTIVE" = "false" ]; then
  pass "PATCH /users/{staff1}/status as owner: 200, is_active now false"
else
  fail "PATCH /users/{staff1}/status as owner: 200, is_active now false" "status '$DEACTIVATE_STATUS', is_active '$DEACTIVATE_IS_ACTIVE'"
fi

# ─── (o): staff1's OLD access token — still works within the 15-min
#          window (access tokens are stateless, this is expected, not
#          a bug); but the refresh cookie must now be revoked. ───
OLD_TOKEN_ME_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/auth/me" \
  -H "Authorization: Bearer $STAFF_ACCESS")

if [ "$OLD_TOKEN_ME_STATUS" = "200" ]; then
  pass "staff1's pre-deactivation access token still works for GET /auth/me (expected: stateless JWT, valid until natural expiry)"
else
  fail "staff1's pre-deactivation access token still works for GET /auth/me (expected: stateless JWT, valid until natural expiry)" "expected 200, got '$OLD_TOKEN_ME_STATUS'"
fi

STAFF_REFRESH_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/auth/refresh" \
  -b "$WORK_DIR/staff-cookies.txt")

if [ "$STAFF_REFRESH_STATUS" = "401" ]; then
  pass "staff1's refresh token revoked on deactivation: POST /auth/refresh now 401"
else
  fail "staff1's refresh token revoked on deactivation: POST /auth/refresh now 401" "expected 401, got '$STAFF_REFRESH_STATUS'"
fi

# ─── (p): invalid GSTIN patch → 400 VALIDATION_ERROR ───
BAD_GSTIN_STATUS=$(curl -s -o "$WORK_DIR/bad-gstin.json" -w '%{http_code}' -X PATCH "$BASE_URL/settings/business" \
  -H "Authorization: Bearer $OWNER_ACCESS" -H "Content-Type: application/json" -d '{"gstin":"invalid"}')
BAD_GSTIN_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/bad-gstin.json")

if [ "$BAD_GSTIN_STATUS" = "400" ] && [ "$BAD_GSTIN_CODE" = "VALIDATION_ERROR" ]; then
  pass "PATCH /settings/business with invalid GSTIN: 400 VALIDATION_ERROR"
else
  fail "PATCH /settings/business with invalid GSTIN: 400 VALIDATION_ERROR" "status '$BAD_GSTIN_STATUS', code '$BAD_GSTIN_CODE'"
fi

# ─── (q): empty patch → 400 VALIDATION_ERROR ───
EMPTY_PATCH_STATUS=$(curl -s -o "$WORK_DIR/empty-patch.json" -w '%{http_code}' -X PATCH "$BASE_URL/settings/business" \
  -H "Authorization: Bearer $OWNER_ACCESS" -H "Content-Type: application/json" -d '{}')
EMPTY_PATCH_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/empty-patch.json")

if [ "$EMPTY_PATCH_STATUS" = "400" ] && [ "$EMPTY_PATCH_CODE" = "VALIDATION_ERROR" ]; then
  pass "PATCH /settings/business with empty body: 400 VALIDATION_ERROR"
else
  fail "PATCH /settings/business with empty body: 400 VALIDATION_ERROR" "status '$EMPTY_PATCH_STATUS', code '$EMPTY_PATCH_CODE'"
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
  echo "Owner test user: $OWNER_EMAIL"
  echo "Staff test user: $STAFF_EMAIL"
  exit 1
else
  printf '%s✓ All %s checks passed. RBAC + business settings + user management are working correctly.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
  echo
  echo "Owner test user: $OWNER_EMAIL"
  echo "Staff test user: $STAFF_EMAIL"
  exit 0
fi
