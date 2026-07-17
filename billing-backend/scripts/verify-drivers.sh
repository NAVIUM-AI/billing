#!/usr/bin/env bash
#
# End-to-end verification of the Task 2.2 driver master module:
# creation with phone/license normalization, duplicate detection across
# both phone and license (independently, across formatting variants),
# optional-field semantics (multiple NULL phones/licenses coexisting),
# validation, list/search, cross-tenant isolation (API + DB layer),
# RBAC (staff can write), and archive/unarchive. Mirrors
# scripts/verify-vehicles.sh (Task 2.1). Prints a PASS/FAIL summary and
# exits 1 if anything failed.
#
# Deliberately `set -u` but NOT `set -e`: we want every check to run
# even if an earlier one fails, so the summary reports everything
# that's broken in one pass instead of stopping at the first failure.
set -u

BASE_URL="http://localhost:8000/api/v1"
# See scripts/verify-tenant-isolation.sh for why this is direct
# Homebrew Postgres (no Docker container) connected to as the
# dedicated non-superuser 'billing_app' role — matches DATABASE_URL.
DB_NAME="${DB_NAME:-billing_dev}"
DB_ROLE="${DB_ROLE:-billing_app}"

TEST_PASSWORD="Passw0rd123"
OWNER_A_EMAIL="verify-drv-owner-a-$(date +%s)@example.com"
STAFF_A_EMAIL="verify-drv-staff-a-$(date +%s)-2@example.com"
OWNER_B_EMAIL="verify-drv-owner-b-$(date +%s)-3@example.com"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
TOTAL_CHECKS=17
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

# ─── SETUP: tenant A (owner + staff), tenant B (owner) ───
SIGNUP_A_STATUS=$(curl -s -o "$WORK_DIR/signup-a.json" -w '%{http_code}' -X POST "$BASE_URL/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Drivers Co A\",\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner A\"}")
if [ "$SIGNUP_A_STATUS" != "201" ]; then
  printf '%sSetup signup (tenant A) failed (status %s):%s\n' "$RED" "$SIGNUP_A_STATUS" "$RESET"
  cat "$WORK_DIR/signup-a.json"; echo
  exit 1
fi

OWNER_A_LOGIN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")
OWNER_A_TOKEN=$(echo "$OWNER_A_LOGIN" | jq -r '.accessToken // empty')

if [ -z "$OWNER_A_TOKEN" ]; then
  printf '%sSetup did not yield an owner A token. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

CREATE_STAFF=$(curl -s -X POST "$BASE_URL/users" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$STAFF_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Staff A\",\"role\":\"staff\"}")
if [ "$(echo "$CREATE_STAFF" | jq -r '.user.id // empty')" = "" ]; then
  printf '%sSetup could not create staff A. Aborting.%s\n' "$RED" "$RESET"
  echo "$CREATE_STAFF"
  exit 1
fi

STAFF_A_LOGIN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$STAFF_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")
STAFF_A_TOKEN=$(echo "$STAFF_A_LOGIN" | jq -r '.accessToken // empty')

SIGNUP_B_STATUS=$(curl -s -o "$WORK_DIR/signup-b.json" -w '%{http_code}' -X POST "$BASE_URL/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Drivers Co B\",\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner B\"}")
if [ "$SIGNUP_B_STATUS" != "201" ]; then
  printf '%sSetup signup (tenant B) failed (status %s):%s\n' "$RED" "$SIGNUP_B_STATUS" "$RESET"
  cat "$WORK_DIR/signup-b.json"; echo
  exit 1
fi
OWNER_B_LOGIN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")
OWNER_B_TOKEN=$(echo "$OWNER_B_LOGIN" | jq -r '.accessToken // empty')

if [ -z "$STAFF_A_TOKEN" ] || [ -z "$OWNER_B_TOKEN" ]; then
  printf '%sSetup did not yield all required tokens. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi
echo "Setup: tenant A (owner + staff) and tenant B (owner) signed up and logged in"
echo

echo "Checks"
echo "------"

# ─── Step 1: create with full data ───
CREATE1_STATUS=$(curl -s -o "$WORK_DIR/create1.json" -w '%{http_code}' -X POST "$BASE_URL/drivers" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"full_name":"Muralidhar N","phone":"+91 98765 43210","license_number":"ka0120210012345","license_expiry_date":"2030-12-31","address_line":"Bangalore","emergency_contact":"9945692217","notes":"Senior driver"}')
DRIVER_ID=$(jq -r '.driver.id // empty' "$WORK_DIR/create1.json")
D1_NAME=$(jq -r '.driver.full_name // empty' "$WORK_DIR/create1.json")
D1_PHONE=$(jq -r '.driver.phone // empty' "$WORK_DIR/create1.json")
D1_PHONE_DISPLAY=$(jq -r '.driver.phone_display // empty' "$WORK_DIR/create1.json")
D1_LICENSE=$(jq -r '.driver.license_number // empty' "$WORK_DIR/create1.json")

STEP1_REASONS=()
[ "$CREATE1_STATUS" = "201" ] || STEP1_REASONS+=("expected status 201, got '$CREATE1_STATUS'")
[ "$D1_NAME" = "Muralidhar N" ] || STEP1_REASONS+=("full_name mismatch (got '$D1_NAME')")
[ "$D1_PHONE" = "919876543210" ] || STEP1_REASONS+=("phone not normalized (got '$D1_PHONE')")
[ "$D1_PHONE_DISPLAY" = "+91 98765 43210" ] || STEP1_REASONS+=("phone_display mismatch (got '$D1_PHONE_DISPLAY')")
[ "$D1_LICENSE" = "KA0120210012345" ] || STEP1_REASONS+=("license_number not uppercased (got '$D1_LICENSE')")

if [ ${#STEP1_REASONS[@]} -eq 0 ]; then
  pass "Create driver with full data: 201, phone normalized, display preserved, license uppercased"
else
  fail "Create driver with full data: 201, phone normalized, display preserved, license uppercased" "$(IFS='; '; echo "${STEP1_REASONS[*]}")"
fi

if [ -z "$DRIVER_ID" ]; then
  printf '%sCould not create the first driver — aborting remaining checks that depend on it.%s\n' "$RED" "$RESET"
  DRIVER_ID="00000000-0000-0000-0000-000000000000"
fi

# ─── Step 2: duplicate phone across formatting variants ───
DUP_PHONE_STATUS=$(curl -s -o "$WORK_DIR/dup-phone.json" -w '%{http_code}' -X POST "$BASE_URL/drivers" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"full_name":"Someone Else","phone":"098765 43210"}')
DUP_PHONE_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/dup-phone.json")

if [ "$DUP_PHONE_STATUS" = "409" ] && [ "$DUP_PHONE_CODE" = "DRIVER_PHONE_ALREADY_EXISTS" ]; then
  pass "Duplicate phone across formatting variants: 409 DRIVER_PHONE_ALREADY_EXISTS"
else
  fail "Duplicate phone across formatting variants: 409 DRIVER_PHONE_ALREADY_EXISTS" "status '$DUP_PHONE_STATUS', code '$DUP_PHONE_CODE'"
fi

# ─── Step 3: duplicate license ───
DUP_LICENSE_STATUS=$(curl -s -o "$WORK_DIR/dup-license.json" -w '%{http_code}' -X POST "$BASE_URL/drivers" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"full_name":"Third Person","phone":"9123456789","license_number":"ka0120210012345"}')
DUP_LICENSE_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/dup-license.json")

if [ "$DUP_LICENSE_STATUS" = "409" ] && [ "$DUP_LICENSE_CODE" = "DRIVER_LICENSE_ALREADY_EXISTS" ]; then
  pass "Duplicate license: 409 DRIVER_LICENSE_ALREADY_EXISTS"
else
  fail "Duplicate license: 409 DRIVER_LICENSE_ALREADY_EXISTS" "status '$DUP_LICENSE_STATUS', code '$DUP_LICENSE_CODE'"
fi

# ─── Step 4: create WITHOUT phone or license ───
CREATE4_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/drivers" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"full_name":"Anonymous Driver"}')

if [ "$CREATE4_STATUS" = "201" ]; then
  pass "Create driver without phone/license: 201 (both fields truly optional)"
else
  fail "Create driver without phone/license: 201 (both fields truly optional)" "expected 201, got '$CREATE4_STATUS'"
fi

# ─── Step 5: create ANOTHER without phone/license — two NULLs coexist ───
CREATE5_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/drivers" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"full_name":"Another Anon"}')

if [ "$CREATE5_STATUS" = "201" ]; then
  pass "Create a second driver without phone/license: 201 (two NULL phones AND two NULL licenses coexist)"
else
  fail "Create a second driver without phone/license: 201 (two NULL phones AND two NULL licenses coexist)" "expected 201, got '$CREATE5_STATUS'"
fi

# ─── Step 6: create with only phone ───
CREATE6_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/drivers" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"full_name":"Ravi Kumar","phone":"9445566778"}')

if [ "$CREATE6_STATUS" = "201" ]; then
  pass "Create driver with only phone (no license): 201"
else
  fail "Create driver with only phone (no license): 201" "expected 201, got '$CREATE6_STATUS'"
fi

# ─── Step 7: invalid phone ───
BAD_PHONE_STATUS=$(curl -s -o "$WORK_DIR/bad-phone.json" -w '%{http_code}' -X POST "$BASE_URL/drivers" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"full_name":"Bad Phone","phone":"12345"}')
BAD_PHONE_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/bad-phone.json")

if [ "$BAD_PHONE_STATUS" = "400" ] && [ "$BAD_PHONE_CODE" = "VALIDATION_ERROR" ]; then
  pass "Invalid phone: 400 VALIDATION_ERROR"
else
  fail "Invalid phone: 400 VALIDATION_ERROR" "status '$BAD_PHONE_STATUS', code '$BAD_PHONE_CODE'"
fi

# ─── Step 8: missing name ───
MISSING_NAME_STATUS=$(curl -s -o "$WORK_DIR/missing-name.json" -w '%{http_code}' -X POST "$BASE_URL/drivers" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"phone":"9887766554"}')
MISSING_NAME_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/missing-name.json")

if [ "$MISSING_NAME_STATUS" = "400" ] && [ "$MISSING_NAME_CODE" = "VALIDATION_ERROR" ]; then
  pass "Missing full_name: 400 VALIDATION_ERROR"
else
  fail "Missing full_name: 400 VALIDATION_ERROR" "status '$MISSING_NAME_STATUS', code '$MISSING_NAME_CODE'"
fi

# ─── Step 9: list, all ───
LIST1_TOTAL=$(curl -s "$BASE_URL/drivers" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pagination.total // -1')

if [ "$LIST1_TOTAL" = "4" ]; then
  pass "List drivers, no filters: total 4"
else
  fail "List drivers, no filters: total 4" "got total '$LIST1_TOTAL'"
fi

# ─── Step 10: search by name ───
LIST2_TOTAL=$(curl -s "$BASE_URL/drivers?search=murali" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pagination.total // -1')

if [ "$LIST2_TOTAL" = "1" ]; then
  pass "List drivers, search=murali (name match): total 1"
else
  fail "List drivers, search=murali (name match): total 1" "got total '$LIST2_TOTAL'"
fi

# ─── Step 11: search by phone digits ───
LIST3_TOTAL=$(curl -s "$BASE_URL/drivers?search=9876" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pagination.total // -1')

if [ "$LIST3_TOTAL" = "1" ]; then
  pass "List drivers, search=9876 (phone digits match): total 1"
else
  fail "List drivers, search=9876 (phone digits match): total 1" "got total '$LIST3_TOTAL'"
fi

# ─── Step 12: cross-tenant leak test ───
LEAK_STATUS=$(curl -s -o "$WORK_DIR/leak.json" -w '%{http_code}' "$BASE_URL/drivers/$DRIVER_ID" \
  -H "Authorization: Bearer $OWNER_B_TOKEN")
LEAK_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/leak.json")

if [ "$LEAK_STATUS" = "404" ] && [ "$LEAK_CODE" = "DRIVER_NOT_FOUND" ]; then
  pass "Cross-tenant GET /drivers/{id} (tenant B reading tenant A's driver): 404 DRIVER_NOT_FOUND"
else
  fail "Cross-tenant GET /drivers/{id} (tenant B reading tenant A's driver): 404 DRIVER_NOT_FOUND" "status '$LEAK_STATUS', code '$LEAK_CODE'"
fi

# ─── Step 13: update phone ───
UPDATE_STATUS=$(curl -s -o "$WORK_DIR/update.json" -w '%{http_code}' -X PATCH "$BASE_URL/drivers/$DRIVER_ID" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"phone":"9000011111"}')
UPDATE_PHONE=$(jq -r '.driver.phone // empty' "$WORK_DIR/update.json")

if [ "$UPDATE_STATUS" = "200" ] && [ "$UPDATE_PHONE" = "919000011111" ]; then
  pass "PATCH /drivers/{id} phone: 200, normalized to 919000011111"
else
  fail "PATCH /drivers/{id} phone: 200, normalized to 919000011111" "status '$UPDATE_STATUS', phone '$UPDATE_PHONE'"
fi

# ─── Step 14: staff can write ───
STAFF_WRITE_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE_URL/drivers/$DRIVER_ID" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"notes":"Updated by staff"}')

if [ "$STAFF_WRITE_STATUS" = "200" ]; then
  pass "PATCH /drivers/{id} as staff: 200 (drivers:write includes staff)"
else
  fail "PATCH /drivers/{id} as staff: 200 (drivers:write includes staff)" "expected 200, got '$STAFF_WRITE_STATUS'"
fi

# ─── Step 15: archive → excluded from default list ───
ARCHIVE_STATUS=$(curl -s -o "$WORK_DIR/archive.json" -w '%{http_code}' -X POST "$BASE_URL/drivers/$DRIVER_ID/archive" \
  -H "Authorization: Bearer $OWNER_A_TOKEN")
ARCHIVE_ACTIVE=$(jq -r '.driver.is_active' "$WORK_DIR/archive.json")
LIST4_TOTAL=$(curl -s "$BASE_URL/drivers" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pagination.total // -1')
LIST5_TOTAL=$(curl -s "$BASE_URL/drivers?includeArchived=true" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pagination.total // -1')

STEP15_REASONS=()
[ "$ARCHIVE_STATUS" = "200" ] || STEP15_REASONS+=("archive expected status 200, got '$ARCHIVE_STATUS'")
[ "$ARCHIVE_ACTIVE" = "false" ] || STEP15_REASONS+=("archive expected is_active false, got '$ARCHIVE_ACTIVE'")
[ "$LIST4_TOTAL" = "3" ] || STEP15_REASONS+=("default list after archive: expected total 3, got '$LIST4_TOTAL'")
[ "$LIST5_TOTAL" = "4" ] || STEP15_REASONS+=("includeArchived=true: expected total 4, got '$LIST5_TOTAL'")

if [ ${#STEP15_REASONS[@]} -eq 0 ]; then
  pass "Archive driver: 200, is_active false, excluded from default list (total 3), included with includeArchived=true (total 4)"
else
  fail "Archive driver: 200, is_active false, excluded from default list (total 3), included with includeArchived=true (total 4)" "$(IFS='; '; echo "${STEP15_REASONS[*]}")"
fi

# ─── Step 16: unarchive ───
UNARCHIVE_STATUS=$(curl -s -o "$WORK_DIR/unarchive.json" -w '%{http_code}' -X POST "$BASE_URL/drivers/$DRIVER_ID/unarchive" \
  -H "Authorization: Bearer $OWNER_A_TOKEN")
UNARCHIVE_ACTIVE=$(jq -r '.driver.is_active' "$WORK_DIR/unarchive.json")

if [ "$UNARCHIVE_STATUS" = "200" ] && [ "$UNARCHIVE_ACTIVE" = "true" ]; then
  pass "POST /drivers/{id}/unarchive: 200, is_active now true"
else
  fail "POST /drivers/{id}/unarchive: 200, is_active now true" "status '$UNARCHIVE_STATUS', is_active '$UNARCHIVE_ACTIVE'"
fi

# ─── Step 17: DB-layer isolation check — connecting directly as the
#              app role, bypassing the API entirely, with no tenant
#              session var set. RLS should block everything. ───
DB_COUNT=$(psql -U "$DB_ROLE" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM drivers;" 2>/dev/null | tr -d '[:space:]')

if [ "$DB_COUNT" = "0" ]; then
  pass "DB-layer isolation: direct psql as '$DB_ROLE' with no tenant context set sees 0 rows"
else
  fail "DB-layer isolation: direct psql as '$DB_ROLE' with no tenant context set sees 0 rows" "expected 0, got '$DB_COUNT'"
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
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 1
else
  printf '%s✓ All %s checks passed. Driver master module is working correctly.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
  echo
  echo "Tenant A owner: $OWNER_A_EMAIL"
  echo "Tenant A staff: $STAFF_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 0
fi
