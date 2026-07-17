#!/usr/bin/env bash
#
# End-to-end verification of the Task 2.1 vehicle master module:
# creation + normalization, duplicate detection (including across
# formatting variants and against archived records), validation,
# listing/search/filter, cross-tenant isolation (both at the API and
# directly at the DB layer), RBAC (staff can write, viewer cannot per
# the access matrix), and archive/unarchive idempotence. Prints a
# PASS/FAIL summary and exits 1 if anything failed.
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
OWNER_A_EMAIL="verify-veh-owner-a-$(date +%s)@example.com"
STAFF_A_EMAIL="verify-veh-staff-a-$(date +%s)-2@example.com"
OWNER_B_EMAIL="verify-veh-owner-b-$(date +%s)-3@example.com"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
TOTAL_CHECKS=21
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
  -d "{\"businessName\":\"Verify Vehicles Co A\",\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner A\"}")
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
  printf '%sSetup could not create staff1_a. Aborting.%s\n' "$RED" "$RESET"
  echo "$CREATE_STAFF"
  exit 1
fi

STAFF_A_LOGIN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$STAFF_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")
STAFF_A_TOKEN=$(echo "$STAFF_A_LOGIN" | jq -r '.accessToken // empty')

SIGNUP_B_STATUS=$(curl -s -o "$WORK_DIR/signup-b.json" -w '%{http_code}' -X POST "$BASE_URL/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Vehicles Co B\",\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner B\"}")
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

# ─── Step 1: create with owner ───
CREATE1_STATUS=$(curl -s -o "$WORK_DIR/create1.json" -w '%{http_code}' -X POST "$BASE_URL/vehicles" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA 51 AK 1031","vehicle_type":"SEDAN","make_model":"Honda City","seating_capacity":4}')
VEHICLE_ID=$(jq -r '.vehicle.id // empty' "$WORK_DIR/create1.json")
V1_NUMBER=$(jq -r '.vehicle.vehicle_number // empty' "$WORK_DIR/create1.json")
V1_DISPLAY=$(jq -r '.vehicle.vehicle_number_display // empty' "$WORK_DIR/create1.json")
V1_STATE=$(jq -r '.vehicle.registration_state // empty' "$WORK_DIR/create1.json")

STEP1_REASONS=()
[ "$CREATE1_STATUS" = "201" ] || STEP1_REASONS+=("expected status 201, got '$CREATE1_STATUS'")
[ "$V1_NUMBER" = "KA51AK1031" ] || STEP1_REASONS+=("vehicle_number not normalized (got '$V1_NUMBER')")
[ "$V1_DISPLAY" = "KA 51 AK 1031" ] || STEP1_REASONS+=("vehicle_number_display mismatch (got '$V1_DISPLAY')")
[ "$V1_STATE" = "KA" ] || STEP1_REASONS+=("registration_state not auto-derived (got '$V1_STATE')")

if [ ${#STEP1_REASONS[@]} -eq 0 ]; then
  pass "Create vehicle: 201, number normalized, display preserved, registration_state auto-derived"
else
  fail "Create vehicle: 201, number normalized, display preserved, registration_state auto-derived" "$(IFS='; '; echo "${STEP1_REASONS[*]}")"
fi

if [ -z "$VEHICLE_ID" ]; then
  printf '%sCould not create the first vehicle — aborting remaining checks that depend on it.%s\n' "$RED" "$RESET"
  VEHICLE_ID="00000000-0000-0000-0000-000000000000"
fi

# ─── Step 2: duplicate detection (different spacing) ───
DUP_STATUS=$(curl -s -o "$WORK_DIR/dup.json" -w '%{http_code}' -X POST "$BASE_URL/vehicles" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"ka51ak1031","vehicle_type":"SEDAN"}')
DUP_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/dup.json")

if [ "$DUP_STATUS" = "409" ] && [ "$DUP_CODE" = "VEHICLE_ALREADY_EXISTS" ]; then
  pass "Duplicate detection across formatting variants: 409 VEHICLE_ALREADY_EXISTS"
else
  fail "Duplicate detection across formatting variants: 409 VEHICLE_ALREADY_EXISTS" "status '$DUP_STATUS', code '$DUP_CODE'"
fi

# ─── Step 3: invalid registration format ───
BAD_FORMAT_STATUS=$(curl -s -o "$WORK_DIR/bad-format.json" -w '%{http_code}' -X POST "$BASE_URL/vehicles" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"XYZ","vehicle_type":"SEDAN"}')
BAD_FORMAT_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/bad-format.json")

if [ "$BAD_FORMAT_STATUS" = "400" ] && [ "$BAD_FORMAT_CODE" = "VALIDATION_ERROR" ]; then
  pass "Invalid registration format: 400 VALIDATION_ERROR"
else
  fail "Invalid registration format: 400 VALIDATION_ERROR" "status '$BAD_FORMAT_STATUS', code '$BAD_FORMAT_CODE'"
fi

# ─── Step 4: invalid vehicle_type ───
BAD_TYPE_STATUS=$(curl -s -o "$WORK_DIR/bad-type.json" -w '%{http_code}' -X POST "$BASE_URL/vehicles" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA51AK9999","vehicle_type":"HELICOPTER"}')
BAD_TYPE_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/bad-type.json")

if [ "$BAD_TYPE_STATUS" = "400" ] && [ "$BAD_TYPE_CODE" = "VALIDATION_ERROR" ]; then
  pass "Invalid vehicle_type: 400 VALIDATION_ERROR"
else
  fail "Invalid vehicle_type: 400 VALIDATION_ERROR" "status '$BAD_TYPE_STATUS', code '$BAD_TYPE_CODE'"
fi

# ─── Step 5: create second vehicle for filter tests ───
CREATE2_STATUS=$(curl -s -o "$WORK_DIR/create2.json" -w '%{http_code}' -X POST "$BASE_URL/vehicles" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA01AM7323","vehicle_type":"KIA_CARNIVAL","make_model":"KIA Carnival","seating_capacity":7}')

if [ "$CREATE2_STATUS" = "201" ]; then
  pass "Create second vehicle (KIA Carnival): 201"
else
  fail "Create second vehicle (KIA Carnival): 201" "expected 201, got '$CREATE2_STATUS'"
fi

# ─── Step 6: list, no filters ───
LIST1_STATUS=$(curl -s -o "$WORK_DIR/list1.json" -w '%{http_code}' "$BASE_URL/vehicles" \
  -H "Authorization: Bearer $OWNER_A_TOKEN")
LIST1_TOTAL=$(jq -r '.pagination.total // -1' "$WORK_DIR/list1.json")
LIST1_LEN=$(jq -r '.vehicles | length' "$WORK_DIR/list1.json")

if [ "$LIST1_STATUS" = "200" ] && [ "$LIST1_TOTAL" = "2" ] && [ "$LIST1_LEN" = "2" ]; then
  pass "List vehicles, no filters: 200, total 2, 2 rows returned"
else
  fail "List vehicles, no filters: 200, total 2, 2 rows returned" "status '$LIST1_STATUS', total '$LIST1_TOTAL', len '$LIST1_LEN'"
fi

# ─── Step 7: list, type filter ───
LIST2_TOTAL=$(curl -s "$BASE_URL/vehicles?type=SEDAN" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pagination.total // -1')

if [ "$LIST2_TOTAL" = "1" ]; then
  pass "List vehicles, type=SEDAN filter: total 1"
else
  fail "List vehicles, type=SEDAN filter: total 1" "got total '$LIST2_TOTAL'"
fi

# ─── Step 8: list, search on make_model ───
LIST3_TOTAL=$(curl -s "$BASE_URL/vehicles?search=carnival" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pagination.total // -1')

if [ "$LIST3_TOTAL" = "1" ]; then
  pass "List vehicles, search=carnival (make_model fuzzy match): total 1"
else
  fail "List vehicles, search=carnival (make_model fuzzy match): total 1" "got total '$LIST3_TOTAL'"
fi

# ─── Step 9: list, search on canonical vehicle number ───
LIST4_TOTAL=$(curl -s "$BASE_URL/vehicles?search=KA51" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pagination.total // -1')

if [ "$LIST4_TOTAL" -ge 1 ] 2>/dev/null; then
  pass "List vehicles, search=KA51 (canonical number match): >= 1 hit (got $LIST4_TOTAL)"
else
  fail "List vehicles, search=KA51 (canonical number match): >= 1 hit" "got total '$LIST4_TOTAL'"
fi

# ─── Step 10: get by ID ───
GET1_STATUS=$(curl -s -o "$WORK_DIR/get1.json" -w '%{http_code}' "$BASE_URL/vehicles/$VEHICLE_ID" \
  -H "Authorization: Bearer $OWNER_A_TOKEN")
GET1_MAKE=$(jq -r '.vehicle.make_model // empty' "$WORK_DIR/get1.json")

if [ "$GET1_STATUS" = "200" ] && [ "$GET1_MAKE" = "Honda City" ]; then
  pass "GET /vehicles/{id} as owner: 200, Honda City"
else
  fail "GET /vehicles/{id} as owner: 200, Honda City" "status '$GET1_STATUS', make_model '$GET1_MAKE'"
fi

# ─── Step 11: cross-tenant leak test — the money shot ───
LEAK_STATUS=$(curl -s -o "$WORK_DIR/leak.json" -w '%{http_code}' "$BASE_URL/vehicles/$VEHICLE_ID" \
  -H "Authorization: Bearer $OWNER_B_TOKEN")
LEAK_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/leak.json")

if [ "$LEAK_STATUS" = "404" ] && [ "$LEAK_CODE" = "VEHICLE_NOT_FOUND" ]; then
  pass "Cross-tenant GET /vehicles/{id} (tenant B reading tenant A's vehicle): 404 VEHICLE_NOT_FOUND"
else
  fail "Cross-tenant GET /vehicles/{id} (tenant B reading tenant A's vehicle): 404 VEHICLE_NOT_FOUND" "status '$LEAK_STATUS', code '$LEAK_CODE'"
fi

# ─── Step 12: update fields ───
UPDATE_STATUS=$(curl -s -o "$WORK_DIR/update.json" -w '%{http_code}' -X PATCH "$BASE_URL/vehicles/$VEHICLE_ID" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"seating_capacity":5,"notes":"AC issue fixed"}')
UPDATE_SEATS=$(jq -r '.vehicle.seating_capacity // empty' "$WORK_DIR/update.json")
UPDATE_NOTES=$(jq -r '.vehicle.notes // empty' "$WORK_DIR/update.json")

if [ "$UPDATE_STATUS" = "200" ] && [ "$UPDATE_SEATS" = "5" ] && [ "$UPDATE_NOTES" = "AC issue fixed" ]; then
  pass "PATCH /vehicles/{id}: 200, seating_capacity and notes updated"
else
  fail "PATCH /vehicles/{id}: 200, seating_capacity and notes updated" "status '$UPDATE_STATUS', seats '$UPDATE_SEATS', notes '$UPDATE_NOTES'"
fi

# ─── Step 13: attempt to update vehicle_number (immutable) ───
IMMUTABLE_STATUS=$(curl -s -o "$WORK_DIR/immutable.json" -w '%{http_code}' -X PATCH "$BASE_URL/vehicles/$VEHICLE_ID" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA51ZZ0001"}')
IMMUTABLE_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/immutable.json")

if [ "$IMMUTABLE_STATUS" = "400" ] && [ "$IMMUTABLE_CODE" = "VALIDATION_ERROR" ]; then
  pass "PATCH vehicle_number rejected (immutable field): 400 VALIDATION_ERROR"
else
  fail "PATCH vehicle_number rejected (immutable field): 400 VALIDATION_ERROR" "status '$IMMUTABLE_STATUS', code '$IMMUTABLE_CODE'"
fi

# ─── Step 14: staff CAN write (vehicles:write includes staff) ───
STAFF_WRITE_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE_URL/vehicles/$VEHICLE_ID" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"notes":"Staff edit ok"}')

if [ "$STAFF_WRITE_STATUS" = "200" ]; then
  pass "PATCH /vehicles/{id} as staff: 200 (vehicles:write includes staff)"
else
  fail "PATCH /vehicles/{id} as staff: 200 (vehicles:write includes staff)" "expected 200, got '$STAFF_WRITE_STATUS'"
fi

# ─── Step 15: static check — viewer is NOT in vehicles:write ───
MATRIX_LINE=$(grep "'vehicles:write'" src/config/accessMatrix.js 2>/dev/null || grep '"vehicles:write"' src/config/accessMatrix.js 2>/dev/null)

if [ -n "$MATRIX_LINE" ] && ! echo "$MATRIX_LINE" | grep -q "viewer"; then
  pass "Static check: 'viewer' is not present on the vehicles:write line in accessMatrix.js"
else
  fail "Static check: 'viewer' is not present on the vehicles:write line in accessMatrix.js" "line was: '$MATRIX_LINE'"
fi

# ─── Step 16: archive ───
ARCHIVE_STATUS=$(curl -s -o "$WORK_DIR/archive.json" -w '%{http_code}' -X POST "$BASE_URL/vehicles/$VEHICLE_ID/archive" \
  -H "Authorization: Bearer $OWNER_A_TOKEN")
ARCHIVE_ACTIVE=$(jq -r '.vehicle.is_active' "$WORK_DIR/archive.json")

if [ "$ARCHIVE_STATUS" = "200" ] && [ "$ARCHIVE_ACTIVE" = "false" ]; then
  pass "POST /vehicles/{id}/archive: 200, is_active now false"
else
  fail "POST /vehicles/{id}/archive: 200, is_active now false" "status '$ARCHIVE_STATUS', is_active '$ARCHIVE_ACTIVE'"
fi

# ─── Step 17: archived vehicles excluded from default list ───
LIST5_TOTAL=$(curl -s "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pagination.total // -1')

if [ "$LIST5_TOTAL" = "1" ]; then
  pass "List vehicles after archive (default, no includeArchived): total 1"
else
  fail "List vehicles after archive (default, no includeArchived): total 1" "got total '$LIST5_TOTAL'"
fi

# ─── Step 18: includeArchived=true shows both ───
LIST6_TOTAL=$(curl -s "$BASE_URL/vehicles?includeArchived=true" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pagination.total // -1')

if [ "$LIST6_TOTAL" = "2" ]; then
  pass "List vehicles with includeArchived=true: total 2"
else
  fail "List vehicles with includeArchived=true: total 2" "got total '$LIST6_TOTAL'"
fi

# ─── Step 19: re-create archived vehicle → informative error ───
RECREATE_STATUS=$(curl -s -o "$WORK_DIR/recreate.json" -w '%{http_code}' -X POST "$BASE_URL/vehicles" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA51AK1031","vehicle_type":"SEDAN"}')
RECREATE_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/recreate.json")
RECREATE_VEHICLE_ID=$(jq -r '.error.details.vehicleId // empty' "$WORK_DIR/recreate.json")

STEP19_REASONS=()
[ "$RECREATE_STATUS" = "409" ] || STEP19_REASONS+=("expected status 409, got '$RECREATE_STATUS'")
[ "$RECREATE_CODE" = "VEHICLE_ARCHIVED_EXISTS" ] || STEP19_REASONS+=("expected code VEHICLE_ARCHIVED_EXISTS, got '$RECREATE_CODE'")
[ "$RECREATE_VEHICLE_ID" = "$VEHICLE_ID" ] || STEP19_REASONS+=("expected details.vehicleId '$VEHICLE_ID', got '$RECREATE_VEHICLE_ID'")

if [ ${#STEP19_REASONS[@]} -eq 0 ]; then
  pass "Re-create archived vehicle: 409 VEHICLE_ARCHIVED_EXISTS with matching details.vehicleId"
else
  fail "Re-create archived vehicle: 409 VEHICLE_ARCHIVED_EXISTS with matching details.vehicleId" "$(IFS='; '; echo "${STEP19_REASONS[*]}")"
fi

# ─── Step 20: unarchive ───
UNARCHIVE_STATUS=$(curl -s -o "$WORK_DIR/unarchive.json" -w '%{http_code}' -X POST "$BASE_URL/vehicles/$VEHICLE_ID/unarchive" \
  -H "Authorization: Bearer $OWNER_A_TOKEN")
UNARCHIVE_ACTIVE=$(jq -r '.vehicle.is_active' "$WORK_DIR/unarchive.json")

if [ "$UNARCHIVE_STATUS" = "200" ] && [ "$UNARCHIVE_ACTIVE" = "true" ]; then
  pass "POST /vehicles/{id}/unarchive: 200, is_active now true"
else
  fail "POST /vehicles/{id}/unarchive: 200, is_active now true" "status '$UNARCHIVE_STATUS', is_active '$UNARCHIVE_ACTIVE'"
fi

# ─── Step 21: DB-layer isolation check — connecting directly as the
#              app role, bypassing the API entirely, with no tenant
#              session var set. RLS should block everything. ───
DB_COUNT=$(psql -U "$DB_ROLE" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM vehicles;" 2>/dev/null | tr -d '[:space:]')

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
  printf '%s✓ All %s checks passed. Vehicle master module is working correctly.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
  echo
  echo "Tenant A owner: $OWNER_A_EMAIL"
  echo "Tenant A staff: $STAFF_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 0
fi
