#!/usr/bin/env bash
#
# End-to-end verification of the Task 1.4 tenant isolation layer: two
# tenants each create pings via the API, then we check that each tenant
# only ever sees its own rows — including through the deliberately
# WHERE-less /pings/leak-test endpoint — and finally that the database
# itself (not just the application's queries) refuses to return rows
# when no tenant session variable is set. Prints a PASS/FAIL summary
# and exits 1 if anything failed.
#
# Deliberately `set -u` but NOT `set -e`: we want every check to run
# even if an earlier one fails, so the summary reports everything
# that's broken in one pass instead of stopping at the first failure.
set -u

BASE_URL="http://localhost:8000/api/v1"
# This project's local dev DB runs directly under Homebrew Postgres (no
# Docker container), connected to as the dedicated non-superuser
# 'billing_app' role that owns the tables — matching how the app itself
# connects (see DATABASE_URL in .env). Superusers always bypass RLS, so
# the DB-layer check below only proves anything when run as this role.
DB_NAME="${DB_NAME:-billing_dev}"
DB_ROLE="${DB_ROLE:-billing_app}"

# example.com is IANA-reserved for documentation/testing and passes the
# app's own Joi email() validator (see scripts/verify-auth.sh for why a
# made-up TLD would fail this same check).
TENANT_A_EMAIL="verify-tenant-a-$(date +%s)@example.com"
TENANT_B_EMAIL="verify-tenant-b-$(date +%s)-2@example.com"
TEST_PASSWORD="Passw0rd123"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
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
  printf '%sCould not connect to database "%s" as role "%s".\nCheck Postgres is running and the role exists.%s\n' \
    "$RED" "$DB_NAME" "$DB_ROLE" "$RESET"
  exit 1
fi
echo "  connected to database '$DB_NAME' as role '$DB_ROLE'"

if ! command -v jq >/dev/null 2>&1; then
  printf '%sjq is required for this script.\nInstall it with: brew install jq%s\n' "$RED" "$RESET"
  exit 1
fi
echo "  jq is installed"
echo

# ─── SETUP: sign up two tenants and log in as each ───
# Not scored checks — just getting two isolated tenants with valid
# access tokens so the checks below have something to exercise.
signup_and_login() {
  local email="$1" business="$2" out_prefix="$3"

  local signup_status
  signup_status=$(curl -s -o "$WORK_DIR/${out_prefix}-signup.json" -w '%{http_code}' \
    -X POST "$BASE_URL/auth/signup" \
    -H "Content-Type: application/json" \
    -d "{\"businessName\":\"$business\",\"email\":\"$email\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Verify Tester\"}")
  if [ "$signup_status" != "201" ]; then
    printf '%sSetup signup failed for %s (status %s):%s\n' "$RED" "$email" "$signup_status" "$RESET"
    cat "$WORK_DIR/${out_prefix}-signup.json"
    echo
    exit 1
  fi

  local login_status
  login_status=$(curl -s -o "$WORK_DIR/${out_prefix}-login.json" -w '%{http_code}' \
    -X POST "$BASE_URL/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$TEST_PASSWORD\"}")
  if [ "$login_status" != "200" ]; then
    printf '%sSetup login failed for %s (status %s):%s\n' "$RED" "$email" "$login_status" "$RESET"
    cat "$WORK_DIR/${out_prefix}-login.json"
    echo
    exit 1
  fi
}

signup_and_login "$TENANT_A_EMAIL" "Verify Tenant A Co" "a"
signup_and_login "$TENANT_B_EMAIL" "Verify Tenant B Co" "b"

ACCESS_A=$(jq -r '.accessToken // empty' "$WORK_DIR/a-login.json")
ACCESS_B=$(jq -r '.accessToken // empty' "$WORK_DIR/b-login.json")
TENANT_A_ID=$(jq -r '.user.tenant_id // empty' "$WORK_DIR/a-login.json")
TENANT_B_ID=$(jq -r '.user.tenant_id // empty' "$WORK_DIR/b-login.json")

if [ -z "$ACCESS_A" ] || [ -z "$ACCESS_B" ] || [ -z "$TENANT_A_ID" ] || [ -z "$TENANT_B_ID" ]; then
  printf '%sSetup did not yield usable tokens/tenant ids. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi
echo "Setup: tenant A ($TENANT_A_ID) and tenant B ($TENANT_B_ID) signed up and logged in"
echo

# ─── SETUP: create 2 pings for each tenant ───
create_ping() {
  local access="$1" message="$2" out_file="$3"
  curl -s -o "$out_file" -X POST "$BASE_URL/pings" \
    -H "Authorization: Bearer $access" \
    -H "Content-Type: application/json" \
    -d "{\"message\":\"$message\"}"
}

create_ping "$ACCESS_A" "A-hello" "$WORK_DIR/a-ping1.json"
create_ping "$ACCESS_A" "A-world" "$WORK_DIR/a-ping2.json"
create_ping "$ACCESS_B" "B-hello" "$WORK_DIR/b-ping1.json"
create_ping "$ACCESS_B" "B-world" "$WORK_DIR/b-ping2.json"
echo "Setup: created 2 pings each for tenant A and tenant B"
echo

echo "Checks"
echo "------"

# ─── STEP 1: GET /pings as A → exactly 2 rows, all tenant A's ───
curl -s -o "$WORK_DIR/a-pings.json" "$BASE_URL/pings" -H "Authorization: Bearer $ACCESS_A"
A_COUNT=$(jq '.pings | length' "$WORK_DIR/a-pings.json" 2>/dev/null)
A_OTHER_TENANTS=$(jq --arg tid "$TENANT_A_ID" '[.pings[] | select(.tenant_id != $tid)] | length' "$WORK_DIR/a-pings.json" 2>/dev/null)

STEP1_REASONS=()
[ "$A_COUNT" = "2" ] || STEP1_REASONS+=("expected 2 pings, got '$A_COUNT'")
[ "$A_OTHER_TENANTS" = "0" ] || STEP1_REASONS+=("$A_OTHER_TENANTS row(s) belong to a different tenant")

if [ ${#STEP1_REASONS[@]} -eq 0 ]; then
  pass "GET /pings as tenant A: exactly 2 rows, all tenant A's"
else
  fail "GET /pings as tenant A: exactly 2 rows, all tenant A's" "$(IFS='; '; echo "${STEP1_REASONS[*]}")"
fi

# ─── STEP 2: GET /pings as B → exactly 2 rows, all tenant B's ───
curl -s -o "$WORK_DIR/b-pings.json" "$BASE_URL/pings" -H "Authorization: Bearer $ACCESS_B"
B_COUNT=$(jq '.pings | length' "$WORK_DIR/b-pings.json" 2>/dev/null)
B_OTHER_TENANTS=$(jq --arg tid "$TENANT_B_ID" '[.pings[] | select(.tenant_id != $tid)] | length' "$WORK_DIR/b-pings.json" 2>/dev/null)

STEP2_REASONS=()
[ "$B_COUNT" = "2" ] || STEP2_REASONS+=("expected 2 pings, got '$B_COUNT'")
[ "$B_OTHER_TENANTS" = "0" ] || STEP2_REASONS+=("$B_OTHER_TENANTS row(s) belong to a different tenant")

if [ ${#STEP2_REASONS[@]} -eq 0 ]; then
  pass "GET /pings as tenant B: exactly 2 rows, all tenant B's"
else
  fail "GET /pings as tenant B: exactly 2 rows, all tenant B's" "$(IFS='; '; echo "${STEP2_REASONS[*]}")"
fi

# ─── STEP 3: GET /pings/leak-test as A → still exactly 2 rows, all A's.
#             The query behind this endpoint has NO WHERE clause at all,
#             so if this passes, isolation is coming from Postgres RLS,
#             not from a WHERE tenant_id = ... the app happened to add. ───
curl -s -o "$WORK_DIR/a-leak.json" "$BASE_URL/pings/leak-test" -H "Authorization: Bearer $ACCESS_A"
LEAK_COUNT=$(jq '.pings | length' "$WORK_DIR/a-leak.json" 2>/dev/null)
LEAK_OTHER_TENANTS=$(jq --arg tid "$TENANT_A_ID" '[.pings[] | select(.tenant_id != $tid)] | length' "$WORK_DIR/a-leak.json" 2>/dev/null)

STEP3_REASONS=()
[ "$LEAK_COUNT" = "2" ] || STEP3_REASONS+=("expected 2 pings, got '$LEAK_COUNT'")
[ "$LEAK_OTHER_TENANTS" = "0" ] || STEP3_REASONS+=("$LEAK_OTHER_TENANTS row(s) belong to a different tenant — RLS did not filter a WHERE-less query")

if [ ${#STEP3_REASONS[@]} -eq 0 ]; then
  pass "GET /pings/leak-test as tenant A (no WHERE clause): still exactly 2 rows, all tenant A's"
else
  fail "GET /pings/leak-test as tenant A (no WHERE clause): still exactly 2 rows, all tenant A's" "$(IFS='; '; echo "${STEP3_REASONS[*]}")"
fi

# ─── STEP 4: DB-layer check, connecting directly as the app role
#             (billing_app), bypassing the API and middleware entirely.
#             This is the check that actually proves RLS — not just
#             application code — is what's enforcing isolation. ───
DB_COUNT_A=$(psql -U "$DB_ROLE" -d "$DB_NAME" -tAc \
  "SELECT set_config('app.current_tenant_id', '$TENANT_A_ID', false); SELECT COUNT(*) FROM tenant_pings;" 2>/dev/null | tail -n1)
DB_COUNT_B=$(psql -U "$DB_ROLE" -d "$DB_NAME" -tAc \
  "SELECT set_config('app.current_tenant_id', '$TENANT_B_ID', false); SELECT COUNT(*) FROM tenant_pings;" 2>/dev/null | tail -n1)
# A fresh connection that never sets app.current_tenant_id at all — this
# is what an attacker would get if they somehow obtained a DB shell as
# the app role without going through our middleware.
DB_COUNT_NONE=$(psql -U "$DB_ROLE" -d "$DB_NAME" -tAc \
  "SELECT COUNT(*) FROM tenant_pings;" 2>/dev/null | tail -n1)

printf '%sDB-layer check (connected directly as '\''%s'\'', bypassing the API):%s\n' "$YELLOW" "$DB_ROLE" "$RESET"
printf '  app.current_tenant_id = tenant A → %s row(s) (expect 2)\n' "$DB_COUNT_A"
printf '  app.current_tenant_id = tenant B → %s row(s) (expect 2)\n' "$DB_COUNT_B"
printf '  app.current_tenant_id unset      → %s row(s) (expect 0)\n' "$DB_COUNT_NONE"
echo

STEP4_REASONS=()
[ "$DB_COUNT_A" = "2" ] || STEP4_REASONS+=("as tenant A: expected 2 rows, got '$DB_COUNT_A'")
[ "$DB_COUNT_B" = "2" ] || STEP4_REASONS+=("as tenant B: expected 2 rows, got '$DB_COUNT_B'")
[ "$DB_COUNT_NONE" = "0" ] || STEP4_REASONS+=("with no tenant context set: expected 0 rows, got '$DB_COUNT_NONE' — RLS is NOT enforced at the DB layer")

if [ ${#STEP4_REASONS[@]} -eq 0 ]; then
  pass "DB layer: RLS scopes tenant_pings correctly per session var, and returns 0 rows with no context set"
else
  fail "DB layer: RLS scopes tenant_pings correctly per session var, and returns 0 rows with no context set" "$(IFS='; '; echo "${STEP4_REASONS[*]}")"
fi

# ─── SUMMARY ───
echo
printf '%s══════════════════════════════════════════════%s\n' "$YELLOW" "$RESET"
echo "VERIFICATION SUMMARY"
printf '%s══════════════════════════════════════════════%s\n' "$YELLOW" "$RESET"
echo "Passed: $PASS/4"
echo "Failed: $FAIL/4"
echo

if [ "$FAIL" -gt 0 ]; then
  echo "Failed steps:"
  for step in "${FAILED_STEPS[@]}"; do
    printf '  %s✗ %s%s\n' "$RED" "$step" "$RESET"
  done
  echo
  echo "Tenant A test user: $TENANT_A_EMAIL"
  echo "Tenant B test user: $TENANT_B_EMAIL"
  exit 1
else
  printf '%s✓ All 4 checks passed. Tenant isolation is enforced at both the application and database layers.%s\n' "$GREEN" "$RESET"
  echo
  echo "Tenant A test user: $TENANT_A_EMAIL"
  echo "Tenant B test user: $TENANT_B_EMAIL"
  exit 0
fi
