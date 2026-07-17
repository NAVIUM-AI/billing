#!/usr/bin/env bash
#
# End-to-end verification of the Task 2.3 customer master module:
# B2C/B2B polymorphism (conditional required fields), GSTIN validation
# + state-code cross-check + auto-derivation, duplicate detection
# (GSTIN + phone, across formatting/case variants), list/search/filter,
# cross-tenant isolation (API + DB layer), the B2B-only contacts
# sub-resource (including atomic primary-flag flipping), immutable
# customer_type, and archive/unarchive. Mirrors
# scripts/verify-vehicles.sh / verify-drivers.sh (Tasks 2.1/2.2). Prints
# a PASS/FAIL summary and exits 1 if anything failed.
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
OWNER_A_EMAIL="verify-cust-owner-a-$(date +%s)@example.com"
STAFF_A_EMAIL="verify-cust-staff-a-$(date +%s)-2@example.com"
OWNER_B_EMAIL="verify-cust-owner-b-$(date +%s)-3@example.com"
# GSTIN "29..." -> state 29 = KA. Used throughout to exercise the
# auto-derive / cross-check logic against a real mapping.
GSTIN_KA="29ABCDE1234F1Z5"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
TOTAL_CHECKS=24
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

# ─── SETUP: tenant A (owner + staff, state_code=KA), tenant B (owner) ───
SIGNUP_A_STATUS=$(curl -s -o "$WORK_DIR/signup-a.json" -w '%{http_code}' -X POST "$BASE_URL/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Customers Co A\",\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner A\"}")
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

curl -s -X PATCH "$BASE_URL/settings/business" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H "Content-Type: application/json" -d '{"state_code":"KA"}' > /dev/null

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
  -d "{\"businessName\":\"Verify Customers Co B\",\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner B\"}")
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
echo "Setup: tenant A (owner + staff, state_code=KA) and tenant B (owner) signed up and logged in"
echo

echo "Checks"
echo "------"

# ─── Step 1: create B2C — happy path ───
CREATE1_STATUS=$(curl -s -o "$WORK_DIR/create1.json" -w '%{http_code}' -X POST "$BASE_URL/customers" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2C","name":"Ramesh Iyer","phone":"+91 98765 12345","email":"ramesh@example.com","address":{"city":"Bangalore","state":"Karnataka","pincode":"560001"}}')
B2C_ID=$(jq -r '.customer.id // empty' "$WORK_DIR/create1.json")
C1_TYPE=$(jq -r '.customer.customer_type // empty' "$WORK_DIR/create1.json")
C1_PHONE=$(jq -r '.customer.phone // empty' "$WORK_DIR/create1.json")
C1_EMAIL=$(jq -r '.customer.email // empty' "$WORK_DIR/create1.json")

STEP1_REASONS=()
[ "$CREATE1_STATUS" = "201" ] || STEP1_REASONS+=("expected status 201, got '$CREATE1_STATUS'")
[ "$C1_TYPE" = "B2C" ] || STEP1_REASONS+=("customer_type mismatch (got '$C1_TYPE')")
[ "$C1_PHONE" = "919876512345" ] || STEP1_REASONS+=("phone not normalized (got '$C1_PHONE')")
[ "$C1_EMAIL" = "ramesh@example.com" ] || STEP1_REASONS+=("email mismatch (got '$C1_EMAIL')")

if [ ${#STEP1_REASONS[@]} -eq 0 ]; then
  pass "Create B2C customer: 201, phone normalized, email preserved"
else
  fail "Create B2C customer: 201, phone normalized, email preserved" "$(IFS='; '; echo "${STEP1_REASONS[*]}")"
fi
[ -n "$B2C_ID" ] || B2C_ID="00000000-0000-0000-0000-000000000000"

# ─── Step 2: create B2B — happy path with GSTIN, state_code auto-derived ───
CREATE2_STATUS=$(curl -s -o "$WORK_DIR/create2.json" -w '%{http_code}' -X POST "$BASE_URL/customers" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer_type\":\"B2B\",\"company_name\":\"Acme Logistics Pvt Ltd\",\"name\":\"Priya (AP)\",\"gstin\":\"$GSTIN_KA\",\"email\":\"ap@acme-example.com\",\"credit_days\":30}")
B2B_ID=$(jq -r '.customer.id // empty' "$WORK_DIR/create2.json")
C2_STATE=$(jq -r '.customer.state_code // empty' "$WORK_DIR/create2.json")
C2_CREDIT=$(jq -r '.customer.credit_days // empty' "$WORK_DIR/create2.json")

STEP2_REASONS=()
[ "$CREATE2_STATUS" = "201" ] || STEP2_REASONS+=("expected status 201, got '$CREATE2_STATUS'")
[ "$C2_STATE" = "KA" ] || STEP2_REASONS+=("state_code not auto-derived from GSTIN (got '$C2_STATE')")
[ "$C2_CREDIT" = "30" ] || STEP2_REASONS+=("credit_days mismatch (got '$C2_CREDIT')")

if [ ${#STEP2_REASONS[@]} -eq 0 ]; then
  pass "Create B2B customer with GSTIN: 201, state_code auto-derived to KA, credit_days 30"
else
  fail "Create B2B customer with GSTIN: 201, state_code auto-derived to KA, credit_days 30" "$(IFS='; '; echo "${STEP2_REASONS[*]}")"
fi
[ -n "$B2B_ID" ] || B2B_ID="00000000-0000-0000-0000-000000000000"

# ─── Step 3: B2B missing gstin ───
MISSING_GSTIN_STATUS=$(curl -s -o "$WORK_DIR/missing-gstin.json" -w '%{http_code}' -X POST "$BASE_URL/customers" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"NoGST Corp"}')
MISSING_GSTIN_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/missing-gstin.json")

if [ "$MISSING_GSTIN_STATUS" = "400" ] && [ "$MISSING_GSTIN_CODE" = "B2B_REQUIRED_FIELDS" ]; then
  pass "B2B missing gstin: 400 B2B_REQUIRED_FIELDS"
else
  fail "B2B missing gstin: 400 B2B_REQUIRED_FIELDS" "status '$MISSING_GSTIN_STATUS', code '$MISSING_GSTIN_CODE'"
fi

# ─── Step 4: B2C missing name ───
MISSING_NAME_STATUS=$(curl -s -o "$WORK_DIR/missing-name.json" -w '%{http_code}' -X POST "$BASE_URL/customers" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2C","phone":"9887766554"}')
MISSING_NAME_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/missing-name.json")

if [ "$MISSING_NAME_STATUS" = "400" ] && { [ "$MISSING_NAME_CODE" = "VALIDATION_ERROR" ] || [ "$MISSING_NAME_CODE" = "B2C_REQUIRED_FIELDS" ]; }; then
  pass "B2C missing name: 400 ($MISSING_NAME_CODE)"
else
  fail "B2C missing name: 400 VALIDATION_ERROR or B2C_REQUIRED_FIELDS" "status '$MISSING_NAME_STATUS', code '$MISSING_NAME_CODE'"
fi

# ─── Step 5: GSTIN / state mismatch ───
MISMATCH_STATUS=$(curl -s -o "$WORK_DIR/mismatch.json" -w '%{http_code}' -X POST "$BASE_URL/customers" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer_type\":\"B2B\",\"company_name\":\"Wrong State Ltd\",\"gstin\":\"$GSTIN_KA\",\"state_code\":\"MH\"}")
MISMATCH_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/mismatch.json")
MISMATCH_GSTIN_STATE=$(jq -r '.error.details.gstin_state // empty' "$WORK_DIR/mismatch.json")

if [ "$MISMATCH_STATUS" = "400" ] && [ "$MISMATCH_CODE" = "GSTIN_STATE_MISMATCH" ] && [ "$MISMATCH_GSTIN_STATE" = "KA" ]; then
  pass "GSTIN/state mismatch: 400 GSTIN_STATE_MISMATCH, details.gstin_state = KA"
else
  fail "GSTIN/state mismatch: 400 GSTIN_STATE_MISMATCH, details.gstin_state = KA" "status '$MISMATCH_STATUS', code '$MISMATCH_CODE', gstin_state '$MISMATCH_GSTIN_STATE'"
fi

# ─── Step 6: invalid GSTIN format ───
BAD_GSTIN_STATUS=$(curl -s -o "$WORK_DIR/bad-gstin.json" -w '%{http_code}' -X POST "$BASE_URL/customers" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"Bad GSTIN Ltd","gstin":"NOT-A-GSTIN"}')
BAD_GSTIN_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/bad-gstin.json")

if [ "$BAD_GSTIN_STATUS" = "400" ] && [ "$BAD_GSTIN_CODE" = "VALIDATION_ERROR" ]; then
  pass "Invalid GSTIN format: 400 VALIDATION_ERROR"
else
  fail "Invalid GSTIN format: 400 VALIDATION_ERROR" "status '$BAD_GSTIN_STATUS', code '$BAD_GSTIN_CODE'"
fi

# ─── Step 7: duplicate GSTIN ───
DUP_GSTIN_STATUS=$(curl -s -o "$WORK_DIR/dup-gstin.json" -w '%{http_code}' -X POST "$BASE_URL/customers" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"customer_type\":\"B2B\",\"company_name\":\"Acme Twin\",\"gstin\":\"$GSTIN_KA\"}")
DUP_GSTIN_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/dup-gstin.json")

if [ "$DUP_GSTIN_STATUS" = "409" ] && [ "$DUP_GSTIN_CODE" = "CUSTOMER_GSTIN_ALREADY_EXISTS" ]; then
  pass "Duplicate GSTIN: 409 CUSTOMER_GSTIN_ALREADY_EXISTS"
else
  fail "Duplicate GSTIN: 409 CUSTOMER_GSTIN_ALREADY_EXISTS" "status '$DUP_GSTIN_STATUS', code '$DUP_GSTIN_CODE'"
fi

# ─── Step 8: duplicate phone across formatting variants ───
DUP_PHONE_STATUS=$(curl -s -o "$WORK_DIR/dup-phone.json" -w '%{http_code}' -X POST "$BASE_URL/customers" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2C","name":"Different Person","phone":"098765 12345"}')
DUP_PHONE_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/dup-phone.json")

if [ "$DUP_PHONE_STATUS" = "409" ] && [ "$DUP_PHONE_CODE" = "CUSTOMER_PHONE_ALREADY_EXISTS" ]; then
  pass "Duplicate phone across formatting variants: 409 CUSTOMER_PHONE_ALREADY_EXISTS"
else
  fail "Duplicate phone across formatting variants: 409 CUSTOMER_PHONE_ALREADY_EXISTS" "status '$DUP_PHONE_STATUS', code '$DUP_PHONE_CODE'"
fi

# ─── Step 9: list, no filters ───
LIST1_TOTAL=$(curl -s "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pagination.total // -1')

if [ "$LIST1_TOTAL" = "2" ]; then
  pass "List customers, no filters: total 2"
else
  fail "List customers, no filters: total 2" "got total '$LIST1_TOTAL'"
fi

# ─── Step 10: list filter by type ───
LIST2_TOTAL=$(curl -s "$BASE_URL/customers?customer_type=B2B" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pagination.total // -1')

if [ "$LIST2_TOTAL" = "1" ]; then
  pass "List customers, customer_type=B2B filter: total 1"
else
  fail "List customers, customer_type=B2B filter: total 1" "got total '$LIST2_TOTAL'"
fi

# ─── Step 11: search by company name ───
LIST3_TOTAL=$(curl -s "$BASE_URL/customers?search=acme" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pagination.total // -1')

if [ "$LIST3_TOTAL" = "1" ]; then
  pass "List customers, search=acme (company_name match): total 1"
else
  fail "List customers, search=acme (company_name match): total 1" "got total '$LIST3_TOTAL'"
fi

# ─── Step 12: search by GSTIN, case-insensitive input ───
LIST4_TOTAL=$(curl -s "$BASE_URL/customers?search=$(echo "$GSTIN_KA" | tr 'A-Z' 'a-z')" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pagination.total // -1')

if [ "$LIST4_TOTAL" = "1" ]; then
  pass "List customers, search by lowercase GSTIN: total 1"
else
  fail "List customers, search by lowercase GSTIN: total 1" "got total '$LIST4_TOTAL'"
fi

# ─── Step 13: search by phone digits ───
LIST5_RESPONSE=$(curl -s "$BASE_URL/customers?search=9876" -H "Authorization: Bearer $OWNER_A_TOKEN")
LIST5_TOTAL=$(echo "$LIST5_RESPONSE" | jq -r '.pagination.total // -1')
LIST5_NAME=$(echo "$LIST5_RESPONSE" | jq -r '.customers[0].name // empty')

if [ "$LIST5_TOTAL" = "1" ] && [ "$LIST5_NAME" = "Ramesh Iyer" ]; then
  pass "List customers, search=9876 (phone digits match): total 1 (Ramesh Iyer)"
else
  fail "List customers, search=9876 (phone digits match): total 1 (Ramesh Iyer)" "total '$LIST5_TOTAL', name '$LIST5_NAME'"
fi

# ─── Step 14: cross-tenant leak test ───
LEAK_STATUS=$(curl -s -o "$WORK_DIR/leak.json" -w '%{http_code}' "$BASE_URL/customers/$B2B_ID" \
  -H "Authorization: Bearer $OWNER_B_TOKEN")
LEAK_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/leak.json")

if [ "$LEAK_STATUS" = "404" ] && [ "$LEAK_CODE" = "CUSTOMER_NOT_FOUND" ]; then
  pass "Cross-tenant GET /customers/{id} (tenant B reading tenant A's customer): 404 CUSTOMER_NOT_FOUND"
else
  fail "Cross-tenant GET /customers/{id} (tenant B reading tenant A's customer): 404 CUSTOMER_NOT_FOUND" "status '$LEAK_STATUS', code '$LEAK_CODE'"
fi

# ─── Step 15: update B2B credit_days ───
UPDATE_STATUS=$(curl -s -o "$WORK_DIR/update.json" -w '%{http_code}' -X PATCH "$BASE_URL/customers/$B2B_ID" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"credit_days":45}')
UPDATE_CREDIT=$(jq -r '.customer.credit_days // empty' "$WORK_DIR/update.json")

if [ "$UPDATE_STATUS" = "200" ] && [ "$UPDATE_CREDIT" = "45" ]; then
  pass "PATCH /customers/{id} credit_days: 200, credit_days now 45"
else
  fail "PATCH /customers/{id} credit_days: 200, credit_days now 45" "status '$UPDATE_STATUS', credit_days '$UPDATE_CREDIT'"
fi

# ─── Step 16: attempt to change customer_type (immutable) ───
IMMUTABLE_STATUS=$(curl -s -o "$WORK_DIR/immutable.json" -w '%{http_code}' -X PATCH "$BASE_URL/customers/$B2C_ID" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B"}')
IMMUTABLE_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/immutable.json")

if [ "$IMMUTABLE_STATUS" = "400" ] && [ "$IMMUTABLE_CODE" = "VALIDATION_ERROR" ]; then
  pass "PATCH customer_type rejected (immutable field): 400 VALIDATION_ERROR"
else
  fail "PATCH customer_type rejected (immutable field): 400 VALIDATION_ERROR" "status '$IMMUTABLE_STATUS', code '$IMMUTABLE_CODE'"
fi

# ─── Step 17: add contact to B2B customer ───
CONTACT1_STATUS=$(curl -s -o "$WORK_DIR/contact1.json" -w '%{http_code}' -X POST "$BASE_URL/customers/$B2B_ID/contacts" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Sunita Ops","role":"Ops Head","phone":"9012345678","is_primary":true}')

if [ "$CONTACT1_STATUS" = "201" ]; then
  pass "Add primary contact to B2B customer: 201"
else
  fail "Add primary contact to B2B customer: 201" "expected 201, got '$CONTACT1_STATUS'"
fi

# ─── Step 18: add SECOND primary contact — first flips off ───
CONTACT2_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/customers/$B2B_ID/contacts" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Manoj MD","role":"MD","phone":"9111222333","is_primary":true}')
CONTACTS_LIST=$(curl -s "$BASE_URL/customers/$B2B_ID/contacts" -H "Authorization: Bearer $OWNER_A_TOKEN")
PRIMARY_COUNT=$(echo "$CONTACTS_LIST" | jq '[.contacts[] | select(.is_primary == true)] | length')
PRIMARY_NAME=$(echo "$CONTACTS_LIST" | jq -r '.contacts[] | select(.is_primary == true) | .name')

STEP18_REASONS=()
[ "$CONTACT2_STATUS" = "201" ] || STEP18_REASONS+=("expected status 201, got '$CONTACT2_STATUS'")
[ "$PRIMARY_COUNT" = "1" ] || STEP18_REASONS+=("expected exactly 1 primary contact, got $PRIMARY_COUNT")
[ "$PRIMARY_NAME" = "Manoj MD" ] || STEP18_REASONS+=("expected primary contact 'Manoj MD', got '$PRIMARY_NAME'")

if [ ${#STEP18_REASONS[@]} -eq 0 ]; then
  pass "Add second primary contact: 201, first contact's primary flag flips off atomically (only Manoj MD is primary)"
else
  fail "Add second primary contact: 201, first contact's primary flag flips off atomically (only Manoj MD is primary)" "$(IFS='; '; echo "${STEP18_REASONS[*]}")"
fi

# ─── Step 19: contact on B2C rejected ───
CONTACT_B2C_STATUS=$(curl -s -o "$WORK_DIR/contact-b2c.json" -w '%{http_code}' -X POST "$BASE_URL/customers/$B2C_ID/contacts" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Anyone","phone":"9333444555"}')
CONTACT_B2C_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/contact-b2c.json")

if [ "$CONTACT_B2C_STATUS" = "400" ] && [ "$CONTACT_B2C_CODE" = "CONTACTS_B2B_ONLY" ]; then
  pass "Add contact to B2C customer: 400 CONTACTS_B2B_ONLY"
else
  fail "Add contact to B2C customer: 400 CONTACTS_B2B_ONLY" "status '$CONTACT_B2C_STATUS', code '$CONTACT_B2C_CODE'"
fi

# ─── Step 20: getCustomer with contacts included ───
GET_CONTACTS_COUNT=$(curl -s "$BASE_URL/customers/$B2B_ID?withContacts=true" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq '.customer.contacts | length')

if [ "$GET_CONTACTS_COUNT" = "2" ]; then
  pass "GET /customers/{id}?withContacts=true: customer.contacts.length === 2"
else
  fail "GET /customers/{id}?withContacts=true: customer.contacts.length === 2" "got length '$GET_CONTACTS_COUNT'"
fi

# ─── Step 21: archive B2C ───
ARCHIVE_STATUS=$(curl -s -o "$WORK_DIR/archive.json" -w '%{http_code}' -X POST "$BASE_URL/customers/$B2C_ID/archive" \
  -H "Authorization: Bearer $OWNER_A_TOKEN")
ARCHIVE_ACTIVE=$(jq -r '.customer.is_active' "$WORK_DIR/archive.json")
LIST6_TOTAL=$(curl -s "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pagination.total // -1')
LIST7_TOTAL=$(curl -s "$BASE_URL/customers?includeArchived=true" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pagination.total // -1')

STEP21_REASONS=()
[ "$ARCHIVE_STATUS" = "200" ] || STEP21_REASONS+=("archive expected status 200, got '$ARCHIVE_STATUS'")
[ "$ARCHIVE_ACTIVE" = "false" ] || STEP21_REASONS+=("archive expected is_active false, got '$ARCHIVE_ACTIVE'")
[ "$LIST6_TOTAL" = "1" ] || STEP21_REASONS+=("default list after archive: expected total 1, got '$LIST6_TOTAL'")
[ "$LIST7_TOTAL" = "2" ] || STEP21_REASONS+=("includeArchived=true: expected total 2, got '$LIST7_TOTAL'")

if [ ${#STEP21_REASONS[@]} -eq 0 ]; then
  pass "Archive B2C: 200, excluded from default list (total 1), included with includeArchived=true (total 2)"
else
  fail "Archive B2C: 200, excluded from default list (total 1), included with includeArchived=true (total 2)" "$(IFS='; '; echo "${STEP21_REASONS[*]}")"
fi

# ─── Step 22: unarchive ───
UNARCHIVE_STATUS=$(curl -s -o "$WORK_DIR/unarchive.json" -w '%{http_code}' -X POST "$BASE_URL/customers/$B2C_ID/unarchive" \
  -H "Authorization: Bearer $OWNER_A_TOKEN")
UNARCHIVE_ACTIVE=$(jq -r '.customer.is_active' "$WORK_DIR/unarchive.json")

if [ "$UNARCHIVE_STATUS" = "200" ] && [ "$UNARCHIVE_ACTIVE" = "true" ]; then
  pass "POST /customers/{id}/unarchive: 200, is_active now true"
else
  fail "POST /customers/{id}/unarchive: 200, is_active now true" "status '$UNARCHIVE_STATUS', is_active '$UNARCHIVE_ACTIVE'"
fi

# ─── Step 23: staff can write ───
STAFF_WRITE_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE_URL/customers/$B2B_ID" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"notes":"Staff updated"}')

if [ "$STAFF_WRITE_STATUS" = "200" ]; then
  pass "PATCH /customers/{id} as staff: 200 (customers:write includes staff)"
else
  fail "PATCH /customers/{id} as staff: 200 (customers:write includes staff)" "expected 200, got '$STAFF_WRITE_STATUS'"
fi

# ─── Step 24: DB-layer isolation check on both tables ───
DB_COUNT_CUSTOMERS=$(psql -U "$DB_ROLE" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM customers;" 2>/dev/null | tr -d '[:space:]')
DB_COUNT_CONTACTS=$(psql -U "$DB_ROLE" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM customer_contacts;" 2>/dev/null | tr -d '[:space:]')

if [ "$DB_COUNT_CUSTOMERS" = "0" ] && [ "$DB_COUNT_CONTACTS" = "0" ]; then
  pass "DB-layer isolation: direct psql as '$DB_ROLE' with no tenant context set sees 0 rows in both customers and customer_contacts"
else
  fail "DB-layer isolation: direct psql as '$DB_ROLE' with no tenant context set sees 0 rows in both customers and customer_contacts" "customers='$DB_COUNT_CUSTOMERS', customer_contacts='$DB_COUNT_CONTACTS'"
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
  printf '%s✓ All %s checks passed. Customer master module is working correctly.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
  echo
  echo "Tenant A owner: $OWNER_A_EMAIL"
  echo "Tenant A staff: $STAFF_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 0
fi
