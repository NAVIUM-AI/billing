#!/usr/bin/env bash
#
# End-to-end verification of the Task 3.3 trip lifecycle module: the
# DRAFT -> FINALIZED -> CANCELLED / (INVOICED, Module 4 only) state
# machine, PATCH editing restricted to DRAFT (whitelisted fields,
# recomputed totals, atomic tolls replacement), finalize/cancel RBAC,
# concurrent-transition safety via row locks (SELECT FOR UPDATE +
# guarded UPDATE), and cross-tenant + DB-layer isolation. Mirrors
# scripts/verify-trip-sheet-outstation.sh (Task 3.2). Prints a
# PASS/FAIL summary and exits 1 if anything failed.
#
# Deliberately `set -u` but NOT `set -e`: we want every check to run
# even if an earlier one fails, so the summary reports everything
# that's broken in one pass instead of stopping at the first failure.
set -u

BASE_URL="http://localhost:8000/api/v1"

# Direct psql against $DATABASE_URL — no Docker container involved.
# Loaded from .env if not already set (see scripts/verify-auth.sh).
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

TEST_PASSWORD="Passw0rd123"
OWNER_A_EMAIL="verify-trips-lc-owner-a-$(date +%s)@example.com"
STAFF_A_EMAIL="verify-trips-lc-staff-a-$(date +%s)-2@example.com"
ACCT_A_EMAIL="verify-trips-lc-acct-a-$(date +%s)-3@example.com"
VIEWER_A_EMAIL="verify-trips-lc-viewer-a-$(date +%s)-4@example.com"
OWNER_B_EMAIL="verify-trips-lc-owner-b-$(date +%s)-5@example.com"

# All trip dates computed as offsets back from today (Rule 8) — a
# hardcoded calendar date drifts into the future relative to whenever
# this script actually runs (see Task 3.1/3.2's own supersede/trip_date
# fixes for why this bit before).
days_ago() { date -v-"$1"d +%Y-%m-%d; }
DATE_T1=$(days_ago 15)
DATE_T2=$(days_ago 14)
DATE_T3=$(days_ago 13)
DATE_T4=$(days_ago 12)
DATE_T5=$(days_ago 11)
DATE_T6=$(days_ago 10)
DATE_T7=$(days_ago 9)
DATE_REGRESSION=$(days_ago 8)

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
TOTAL_CHECKS=30
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
DB_NAME_FOUND=$(echo "$DB_IDENTITY" | cut -d'|' -f1)
DB_ROLE_FOUND=$(echo "$DB_IDENTITY" | cut -d'|' -f2)
echo "  connected to database '$DB_NAME_FOUND' as role '$DB_ROLE_FOUND'"

if ! command -v jq >/dev/null 2>&1; then
  printf '%sjq is required for this script.\nInstall it with: brew install jq%s\n' "$RED" "$RESET"
  exit 1
fi
echo "  jq is installed"
echo

# ─── SETUP ───
SIGNUP_A=$(curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Lifecycle Co A\",\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner A\"}")
if [ "$(echo "$SIGNUP_A" | jq -r '.tenant.id // empty')" = "" ]; then
  printf '%sSetup signup (tenant A) failed:%s\n' "$RED" "$RESET"
  echo "$SIGNUP_A"
  exit 1
fi
OWNER_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
OWNER_A_ID=$(curl -s "$BASE_URL/auth/me" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.user.id // empty')
if [ -z "$OWNER_A_TOKEN" ]; then
  printf '%sSetup did not yield an owner A token. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

curl -s -X PATCH "$BASE_URL/settings/business" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H "Content-Type: application/json" -d '{"state_code":"KA","trip_sheet_prefix":"LC"}' > /dev/null

CREATE_STAFF=$(curl -s -X POST "$BASE_URL/users" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$STAFF_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Staff A\",\"role\":\"staff\"}")
if [ "$(echo "$CREATE_STAFF" | jq -r '.user.id // empty')" = "" ]; then
  printf '%sSetup could not create staff A. Aborting.%s\n' "$RED" "$RESET"
  echo "$CREATE_STAFF"
  exit 1
fi
STAFF_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$STAFF_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')

CREATE_ACCT=$(curl -s -X POST "$BASE_URL/users" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ACCT_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Acct A\",\"role\":\"accountant\"}")
if [ "$(echo "$CREATE_ACCT" | jq -r '.user.id // empty')" = "" ]; then
  printf '%sSetup could not create accountant A. Aborting.%s\n' "$RED" "$RESET"
  echo "$CREATE_ACCT"
  exit 1
fi
ACCT_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ACCT_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')
ACCT_A_ID=$(curl -s "$BASE_URL/auth/me" -H "Authorization: Bearer $ACCT_A_TOKEN" | jq -r '.user.id // empty')

CREATE_VIEWER=$(curl -s -X POST "$BASE_URL/users" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$VIEWER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Viewer A\",\"role\":\"viewer\"}")
if [ "$(echo "$CREATE_VIEWER" | jq -r '.user.id // empty')" = "" ]; then
  printf '%sSetup could not create viewer A. Aborting.%s\n' "$RED" "$RESET"
  echo "$CREATE_VIEWER"
  exit 1
fi
VIEWER_A_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$VIEWER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')

SIGNUP_B=$(curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Lifecycle Co B\",\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner B\"}")
if [ "$(echo "$SIGNUP_B" | jq -r '.tenant.id // empty')" = "" ]; then
  printf '%sSetup signup (tenant B) failed:%s\n' "$RED" "$RESET"
  echo "$SIGNUP_B"
  exit 1
fi
OWNER_B_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')

if [ -z "$STAFF_A_TOKEN" ] || [ -z "$ACCT_A_TOKEN" ] || [ -z "$VIEWER_A_TOKEN" ] || [ -z "$OWNER_B_TOKEN" ]; then
  printf '%sSetup did not yield all required tokens. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

VEH_SEDAN=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA51AK1031","vehicle_type":"SEDAN","seating_capacity":4}' | jq -r '.vehicle.id // empty')

CUST_B2C=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2C","name":"Ramesh Iyer","phone":"9876512345","state_code":"KA"}' | jq -r '.customer.id // empty')

curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"LOCAL_PACKAGE","vehicle_type":"SEDAN","label":"SEDAN 8H/80KM","base_hours":8,"base_km":80,"base_price_rupees":2200,"extra_km_rate_rupees":14,"extra_hr_rate_rupees":180,"effective_from":"2026-01-01"}' > /dev/null
curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"OUTSTATION_SLAB","vehicle_type":"SEDAN","label":"SEDAN Outstation","slab_rate_rupees":25,"min_km_per_day":200,"driver_batta_per_day_rupees":500,"effective_from":"2026-01-01"}' > /dev/null

if [ -z "$VEH_SEDAN" ] || [ -z "$CUST_B2C" ]; then
  printf '%sSetup did not yield all required fixtures. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

echo "Setup: tenant A (owner + staff + accountant + viewer, state_code=KA, trip_sheet_prefix=LC), tenant B (owner), SEDAN vehicle, B2C customer, LOCAL_PACKAGE + OUTSTATION_SLAB rules"
echo

echo "Checks"
echo "------"

create_trip_body() {
  local trip_date="$1"
  echo "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST_B2C\",\"vehicle_id\":\"$VEH_SEDAN\",\"trip_date\":\"$trip_date\",\"total_km\":217,\"total_hours\":12,\"toll_rupees\":0}"
}

# ─── Step 1: Create LOCAL/GST trip (DRAFT) ───
CREATE1_STATUS=$(curl -s -o "$WORK_DIR/trip1.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "$(create_trip_body "$DATE_T1")")
TRIP_1=$(jq -r '.trip.id // empty' "$WORK_DIR/trip1.json")

if [ "$CREATE1_STATUS" = "201" ] && [ "$(jq -r '.trip.status' "$WORK_DIR/trip1.json")" = "DRAFT" ]; then
  pass "Create LOCAL/GST trip: 201, status DRAFT"
else
  fail "Create LOCAL/GST trip: 201, status DRAFT" "status '$CREATE1_STATUS'"
fi
[ -n "$TRIP_1" ] || TRIP_1="00000000-0000-4000-8000-000000000000"

# ─── Step 2: PATCH trip in DRAFT — total_km change, recompute ───
PATCH2=$(curl -s -X PATCH "$BASE_URL/trips/$TRIP_1" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"total_km":250,"total_hours":14}')

STEP2_REASONS=()
[ "$(echo "$PATCH2" | jq -r '.trip.total_km')" = "250" ] || STEP2_REASONS+=("total_km not updated")
[ "$(echo "$PATCH2" | jq -r '.trip.total_hours')" = "14" ] || STEP2_REASONS+=("total_hours not updated")
[ "$(echo "$PATCH2" | jq -r '.trip.status')" = "DRAFT" ] || STEP2_REASONS+=("status changed")
[ "$(echo "$PATCH2" | jq -r '.trip.base_amount_paise')" = "220000" ] || STEP2_REASONS+=("base_amount_paise changed (should be unchanged)")
# extra_km = 250-80=170 * 1400 = 238000; extra_hours = 14-8=6 * 18000 = 108000; extras = 346000
[ "$(echo "$PATCH2" | jq -r '.trip.extras_amount_paise')" = "346000" ] || STEP2_REASONS+=("extras_amount_paise expected 346000, got $(echo "$PATCH2" | jq -r '.trip.extras_amount_paise')")
[ "$(echo "$PATCH2" | jq -r '.trip.subtotal_paise')" = "566000" ] || STEP2_REASONS+=("subtotal_paise expected 566000, got $(echo "$PATCH2" | jq -r '.trip.subtotal_paise')")

if [ ${#STEP2_REASONS[@]} -eq 0 ]; then
  pass "PATCH DRAFT trip (total_km/total_hours): 200, recomputed extras=346000, subtotal=566000"
else
  fail "PATCH DRAFT trip: recompute" "$(IFS='; '; echo "${STEP2_REASONS[*]}")"
fi

# ─── Step 3: PATCH with unknown field ───
PATCH3_STATUS=$(curl -s -o "$WORK_DIR/patch3.json" -w '%{http_code}' -X PATCH "$BASE_URL/trips/$TRIP_1" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"total_km":250,"service_type":"OUTSTATION"}')
PATCH3_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/patch3.json")

if [ "$PATCH3_STATUS" = "400" ] && [ "$PATCH3_CODE" = "VALIDATION_ERROR" ]; then
  pass "PATCH with unknown field (service_type): 400 VALIDATION_ERROR"
else
  fail "PATCH with unknown field: 400 VALIDATION_ERROR" "status '$PATCH3_STATUS', code '$PATCH3_CODE'"
fi

# ─── Step 4: PATCH with immutable field ───
PATCH4_STATUS=$(curl -s -o "$WORK_DIR/patch4.json" -w '%{http_code}' -X PATCH "$BASE_URL/trips/$TRIP_1" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_id":"00000000-0000-4000-8000-000000000000"}')
PATCH4_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/patch4.json")

if [ "$PATCH4_STATUS" = "400" ] && [ "$PATCH4_CODE" = "VALIDATION_ERROR" ]; then
  pass "PATCH with immutable field (customer_id): 400 VALIDATION_ERROR"
else
  fail "PATCH with immutable field: 400 VALIDATION_ERROR" "status '$PATCH4_STATUS', code '$PATCH4_CODE'"
fi

# ─── Step 5: PATCH empty body ───
PATCH5_STATUS=$(curl -s -o "$WORK_DIR/patch5.json" -w '%{http_code}' -X PATCH "$BASE_URL/trips/$TRIP_1" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" -d '{}')
PATCH5_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/patch5.json")

if [ "$PATCH5_STATUS" = "400" ] && [ "$PATCH5_CODE" = "VALIDATION_ERROR" ]; then
  pass "PATCH empty body: 400 VALIDATION_ERROR"
else
  fail "PATCH empty body: 400 VALIDATION_ERROR" "status '$PATCH5_STATUS', code '$PATCH5_CODE'"
fi

# ─── Step 6: PATCH with itemized tolls (atomic replace) ───
PATCH6=$(curl -s -X PATCH "$BASE_URL/trips/$TRIP_1" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"tolls":[{"plaza_name":"Plaza A","amount_rupees":50},{"plaza_name":"Plaza B","amount_rupees":75}]}')

STEP6_REASONS=()
[ "$(echo "$PATCH6" | jq '.trip.tolls | length')" = "2" ] || STEP6_REASONS+=("expected 2 tolls")
[ "$(echo "$PATCH6" | jq -r '.trip.tolls[0].amount_paise')" = "5000" ] || STEP6_REASONS+=("tolls[0].amount_paise mismatch")
[ "$(echo "$PATCH6" | jq -r '.trip.tolls[1].amount_paise')" = "7500" ] || STEP6_REASONS+=("tolls[1].amount_paise mismatch")
[ "$(echo "$PATCH6" | jq -r '.trip.toll_paise')" = "12500" ] || STEP6_REASONS+=("toll_paise expected 12500, got $(echo "$PATCH6" | jq -r '.trip.toll_paise')")

if [ ${#STEP6_REASONS[@]} -eq 0 ]; then
  pass "PATCH with itemized tolls: 200, 2 receipts, toll_paise=12500 (derived totals recomputed)"
else
  fail "PATCH with itemized tolls" "$(IFS='; '; echo "${STEP6_REASONS[*]}")"
fi

# ─── Step 7: PATCH tolls = [] — clears all tolls ───
PATCH7=$(curl -s -X PATCH "$BASE_URL/trips/$TRIP_1" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"tolls":[]}')

if [ "$(echo "$PATCH7" | jq '.trip.tolls | length')" = "0" ] && [ "$(echo "$PATCH7" | jq -r '.trip.toll_paise')" = "0" ]; then
  pass "PATCH tolls=[]: 200, tolls cleared, toll_paise=0"
else
  fail "PATCH tolls=[]: clears all tolls" "tolls length $(echo "$PATCH7" | jq '.trip.tolls | length'), toll_paise $(echo "$PATCH7" | jq -r '.trip.toll_paise')"
fi

# ─── Step 8: PATCH toll_rupees AND tolls array -> conflict ───
# plaza_name "XX", not the task spec's literal "X" — tollReceiptSchema
# (Task 3.2) requires min(2) chars, so a 1-char name 400s as
# VALIDATION_ERROR before ever reaching the conflict check this step
# means to exercise.
PATCH8_STATUS=$(curl -s -o "$WORK_DIR/patch8.json" -w '%{http_code}' -X PATCH "$BASE_URL/trips/$TRIP_1" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"toll_rupees":100,"tolls":[{"plaza_name":"XX","amount_rupees":50}]}')
PATCH8_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/patch8.json")

if [ "$PATCH8_STATUS" = "400" ] && [ "$PATCH8_CODE" = "TOLL_INPUT_CONFLICT" ]; then
  pass "PATCH toll_rupees AND tolls together: 400 TOLL_INPUT_CONFLICT"
else
  fail "PATCH toll_rupees AND tolls: 400 TOLL_INPUT_CONFLICT" "status '$PATCH8_STATUS', code '$PATCH8_CODE'"
fi

# ─── Step 9: PATCH by viewer -> 403 ───
PATCH9_STATUS=$(curl -s -o "$WORK_DIR/patch9.json" -w '%{http_code}' -X PATCH "$BASE_URL/trips/$TRIP_1" \
  -H "Authorization: Bearer $VIEWER_A_TOKEN" -H "Content-Type: application/json" -d '{"total_km":300}')
PATCH9_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/patch9.json")
PATCH9_REQUIRED=$(jq -r '.error.details.required // empty' "$WORK_DIR/patch9.json")

if [ "$PATCH9_STATUS" = "403" ] && [ "$PATCH9_CODE" = "FORBIDDEN" ] && [ "$PATCH9_REQUIRED" = "trips:write" ]; then
  pass "PATCH by viewer: 403 FORBIDDEN, details.required = trips:write"
else
  fail "PATCH by viewer: 403 FORBIDDEN" "status '$PATCH9_STATUS', code '$PATCH9_CODE', required '$PATCH9_REQUIRED'"
fi

# ─── Step 10: staff cannot finalize (no trips:finalize) ───
FIN10_STATUS=$(curl -s -o "$WORK_DIR/fin10.json" -w '%{http_code}' -X POST "$BASE_URL/trips/$TRIP_1/finalize" \
  -H "Authorization: Bearer $STAFF_A_TOKEN")
FIN10_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/fin10.json")
FIN10_REQUIRED=$(jq -r '.error.details.required // empty' "$WORK_DIR/fin10.json")

if [ "$FIN10_STATUS" = "403" ] && [ "$FIN10_CODE" = "FORBIDDEN" ] && [ "$FIN10_REQUIRED" = "trips:finalize" ]; then
  pass "Staff finalize: 403 FORBIDDEN, details.required = trips:finalize (staff has trips:write, not trips:finalize)"
else
  fail "Staff finalize: 403 FORBIDDEN" "status '$FIN10_STATUS', code '$FIN10_CODE', required '$FIN10_REQUIRED'"
fi

# ─── Step 11: accountant finalizes ───
FIN11=$(curl -s -X POST "$BASE_URL/trips/$TRIP_1/finalize" -H "Authorization: Bearer $ACCT_A_TOKEN")

STEP11_REASONS=()
[ "$(echo "$FIN11" | jq -r '.trip.status')" = "FINALIZED" ] || STEP11_REASONS+=("status not FINALIZED")
[ "$(echo "$FIN11" | jq -r '.trip.finalized_at')" != "null" ] || STEP11_REASONS+=("finalized_at is null")
[ "$(echo "$FIN11" | jq -r '.trip.finalized_by')" = "$ACCT_A_ID" ] || STEP11_REASONS+=("finalized_by mismatch (expected $ACCT_A_ID)")

if [ ${#STEP11_REASONS[@]} -eq 0 ]; then
  pass "Accountant finalizes: 200, status FINALIZED, finalized_at/finalized_by set"
else
  fail "Accountant finalizes" "$(IFS='; '; echo "${STEP11_REASONS[*]}")"
fi

# ─── Step 12: PATCH a FINALIZED trip -> 409 ───
PATCH12_STATUS=$(curl -s -o "$WORK_DIR/patch12.json" -w '%{http_code}' -X PATCH "$BASE_URL/trips/$TRIP_1" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" -d '{"total_km":500}')
PATCH12_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/patch12.json")
PATCH12_CURRENT=$(jq -r '.error.details.current_status // empty' "$WORK_DIR/patch12.json")

if [ "$PATCH12_STATUS" = "409" ] && [ "$PATCH12_CODE" = "TRIP_NOT_EDITABLE" ] && [ "$PATCH12_CURRENT" = "FINALIZED" ]; then
  pass "PATCH a FINALIZED trip: 409 TRIP_NOT_EDITABLE, current_status=FINALIZED"
else
  fail "PATCH a FINALIZED trip: 409 TRIP_NOT_EDITABLE" "status '$PATCH12_STATUS', code '$PATCH12_CODE', current_status '$PATCH12_CURRENT'"
fi

# ─── Step 13: finalize an already-FINALIZED trip -> 409 ───
FIN13_STATUS=$(curl -s -o "$WORK_DIR/fin13.json" -w '%{http_code}' -X POST "$BASE_URL/trips/$TRIP_1/finalize" \
  -H "Authorization: Bearer $ACCT_A_TOKEN")
FIN13_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/fin13.json")
FIN13_CURRENT=$(jq -r '.error.details.current_status // empty' "$WORK_DIR/fin13.json")
FIN13_ALLOWED=$(jq -c '.error.details.allowed_transitions // []' "$WORK_DIR/fin13.json")

STEP13_REASONS=()
[ "$FIN13_STATUS" = "409" ] || STEP13_REASONS+=("expected status 409, got '$FIN13_STATUS'")
[ "$FIN13_CODE" = "INVALID_STATE_TRANSITION" ] || STEP13_REASONS+=("expected code INVALID_STATE_TRANSITION, got '$FIN13_CODE'")
[ "$FIN13_CURRENT" = "FINALIZED" ] || STEP13_REASONS+=("current_status mismatch")
echo "$FIN13_ALLOWED" | jq -e 'index("INVOICED") != null' > /dev/null || STEP13_REASONS+=("allowed_transitions missing INVOICED")
echo "$FIN13_ALLOWED" | jq -e 'index("CANCELLED") != null' > /dev/null || STEP13_REASONS+=("allowed_transitions missing CANCELLED")
echo "$FIN13_ALLOWED" | jq -e 'index("FINALIZED") == null' > /dev/null || STEP13_REASONS+=("allowed_transitions should NOT include FINALIZED itself")

if [ ${#STEP13_REASONS[@]} -eq 0 ]; then
  pass "Finalize an already-FINALIZED trip: 409 INVALID_STATE_TRANSITION, allowed_transitions=[INVOICED,CANCELLED]"
else
  fail "Finalize an already-FINALIZED trip" "$(IFS='; '; echo "${STEP13_REASONS[*]}")"
fi

# ─── Step 14: cancel FINALIZED without reason -> 400 ───
CANCEL14_STATUS=$(curl -s -o "$WORK_DIR/cancel14.json" -w '%{http_code}' -X POST "$BASE_URL/trips/$TRIP_1/cancel" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" -d '{}')
CANCEL14_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/cancel14.json")

if [ "$CANCEL14_STATUS" = "400" ] && [ "$CANCEL14_CODE" = "VALIDATION_ERROR" ]; then
  pass "Cancel FINALIZED without reason: 400 VALIDATION_ERROR"
else
  fail "Cancel FINALIZED without reason: 400 VALIDATION_ERROR" "status '$CANCEL14_STATUS', code '$CANCEL14_CODE'"
fi

# ─── Step 15: cancel FINALIZED with reason ───
CANCEL15=$(curl -s -X POST "$BASE_URL/trips/$TRIP_1/cancel" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"Customer disputed the invoice"}')

STEP15_REASONS=()
[ "$(echo "$CANCEL15" | jq -r '.trip.status')" = "CANCELLED" ] || STEP15_REASONS+=("status not CANCELLED")
[ "$(echo "$CANCEL15" | jq -r '.trip.cancelled_at')" != "null" ] || STEP15_REASONS+=("cancelled_at is null")
[ "$(echo "$CANCEL15" | jq -r '.trip.cancelled_by')" = "$OWNER_A_ID" ] || STEP15_REASONS+=("cancelled_by mismatch")
[ "$(echo "$CANCEL15" | jq -r '.trip.cancellation_reason')" = "Customer disputed the invoice" ] || STEP15_REASONS+=("cancellation_reason mismatch")
[ "$(echo "$CANCEL15" | jq -r '.trip.finalized_at')" != "null" ] || STEP15_REASONS+=("finalized_at should still be populated (audit trail preserved)")
[ "$(echo "$CANCEL15" | jq -r '.trip.finalized_by')" != "null" ] || STEP15_REASONS+=("finalized_by should still be populated")

if [ ${#STEP15_REASONS[@]} -eq 0 ]; then
  pass "Cancel FINALIZED with reason: 200, status CANCELLED, audit trail (finalized_at/by) preserved"
else
  fail "Cancel FINALIZED with reason" "$(IFS='; '; echo "${STEP15_REASONS[*]}")"
fi

# ─── Step 16: cancel a CANCELLED trip -> 409 ───
CANCEL16_STATUS=$(curl -s -o "$WORK_DIR/cancel16.json" -w '%{http_code}' -X POST "$BASE_URL/trips/$TRIP_1/cancel" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" -d '{"reason":"try again"}')
CANCEL16_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/cancel16.json")
CANCEL16_CURRENT=$(jq -r '.error.details.current_status // empty' "$WORK_DIR/cancel16.json")
CANCEL16_ALLOWED=$(jq -c '.error.details.allowed_transitions // ["x"]' "$WORK_DIR/cancel16.json")

if [ "$CANCEL16_STATUS" = "409" ] && [ "$CANCEL16_CODE" = "INVALID_STATE_TRANSITION" ] && [ "$CANCEL16_CURRENT" = "CANCELLED" ] && [ "$CANCEL16_ALLOWED" = "[]" ]; then
  pass "Cancel a CANCELLED trip: 409 INVALID_STATE_TRANSITION, allowed_transitions=[]"
else
  fail "Cancel a CANCELLED trip: 409 INVALID_STATE_TRANSITION, allowed_transitions=[]" "status '$CANCEL16_STATUS', code '$CANCEL16_CODE', current_status '$CANCEL16_CURRENT', allowed '$CANCEL16_ALLOWED'"
fi

# ─── Step 17: PATCH a CANCELLED trip -> 409 ───
PATCH17_STATUS=$(curl -s -o "$WORK_DIR/patch17.json" -w '%{http_code}' -X PATCH "$BASE_URL/trips/$TRIP_1" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" -d '{"total_km":100}')
PATCH17_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/patch17.json")
PATCH17_CURRENT=$(jq -r '.error.details.current_status // empty' "$WORK_DIR/patch17.json")

if [ "$PATCH17_STATUS" = "409" ] && [ "$PATCH17_CODE" = "TRIP_NOT_EDITABLE" ] && [ "$PATCH17_CURRENT" = "CANCELLED" ]; then
  pass "PATCH a CANCELLED trip: 409 TRIP_NOT_EDITABLE, current_status=CANCELLED"
else
  fail "PATCH a CANCELLED trip: 409 TRIP_NOT_EDITABLE" "status '$PATCH17_STATUS', code '$PATCH17_CODE', current_status '$PATCH17_CURRENT'"
fi

# ─── Step 18: finalize a CANCELLED trip -> 409 ───
FIN18_STATUS=$(curl -s -o "$WORK_DIR/fin18.json" -w '%{http_code}' -X POST "$BASE_URL/trips/$TRIP_1/finalize" \
  -H "Authorization: Bearer $ACCT_A_TOKEN")
FIN18_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/fin18.json")

if [ "$FIN18_STATUS" = "409" ] && [ "$FIN18_CODE" = "INVALID_STATE_TRANSITION" ]; then
  pass "Finalize a CANCELLED trip: 409 INVALID_STATE_TRANSITION"
else
  fail "Finalize a CANCELLED trip: 409 INVALID_STATE_TRANSITION" "status '$FIN18_STATUS', code '$FIN18_CODE'"
fi

# ─── Step 19: DRAFT can be cancelled directly ───
TRIP_2=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "$(create_trip_body "$DATE_T2")" | jq -r '.trip.id // empty')
[ -n "$TRIP_2" ] || TRIP_2="00000000-0000-4000-8000-000000000001"

CANCEL19=$(curl -s -X POST "$BASE_URL/trips/$TRIP_2/cancel" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"Wrong customer"}')

if [ "$(echo "$CANCEL19" | jq -r '.trip.status')" = "CANCELLED" ] && [ "$(echo "$CANCEL19" | jq -r '.trip.finalized_at')" = "null" ]; then
  pass "DRAFT trip cancelled directly: 200, status CANCELLED, finalized_at NULL (never finalized)"
else
  fail "DRAFT trip cancelled directly" "status $(echo "$CANCEL19" | jq -r '.trip.status'), finalized_at $(echo "$CANCEL19" | jq -r '.trip.finalized_at')"
fi

# ─── Step 20: cancel by accountant works ───
TRIP_3=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "$(create_trip_body "$DATE_T3")" | jq -r '.trip.id // empty')
[ -n "$TRIP_3" ] || TRIP_3="00000000-0000-4000-8000-000000000002"

CANCEL20_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/trips/$TRIP_3/cancel" \
  -H "Authorization: Bearer $ACCT_A_TOKEN" -H "Content-Type: application/json" -d '{"reason":"Test"}')

if [ "$CANCEL20_STATUS" = "200" ]; then
  pass "Cancel by accountant: 200"
else
  fail "Cancel by accountant: 200" "status '$CANCEL20_STATUS'"
fi

# ─── Step 21: cancel by staff -> 403 ───
TRIP_4=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "$(create_trip_body "$DATE_T4")" | jq -r '.trip.id // empty')
[ -n "$TRIP_4" ] || TRIP_4="00000000-0000-4000-8000-000000000003"

CANCEL21_STATUS=$(curl -s -o "$WORK_DIR/cancel21.json" -w '%{http_code}' -X POST "$BASE_URL/trips/$TRIP_4/cancel" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" -d '{"reason":"Test"}')
CANCEL21_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/cancel21.json")
CANCEL21_REQUIRED=$(jq -r '.error.details.required // empty' "$WORK_DIR/cancel21.json")

if [ "$CANCEL21_STATUS" = "403" ] && [ "$CANCEL21_CODE" = "FORBIDDEN" ] && [ "$CANCEL21_REQUIRED" = "trips:cancel" ]; then
  pass "Cancel by staff: 403 FORBIDDEN, details.required = trips:cancel"
else
  fail "Cancel by staff: 403 FORBIDDEN" "status '$CANCEL21_STATUS', code '$CANCEL21_CODE', required '$CANCEL21_REQUIRED'"
fi

# ─── Step 22-24: cross-tenant PATCH / finalize / cancel -> 404 ───
TRIP_5=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "$(create_trip_body "$DATE_T5")" | jq -r '.trip.id // empty')
[ -n "$TRIP_5" ] || TRIP_5="00000000-0000-4000-8000-000000000004"

PATCH22_STATUS=$(curl -s -o "$WORK_DIR/patch22.json" -w '%{http_code}' -X PATCH "$BASE_URL/trips/$TRIP_5" \
  -H "Authorization: Bearer $OWNER_B_TOKEN" -H "Content-Type: application/json" -d '{"total_km":500}')
PATCH22_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/patch22.json")
if [ "$PATCH22_STATUS" = "404" ] && [ "$PATCH22_CODE" = "TRIP_NOT_FOUND" ]; then
  pass "Cross-tenant PATCH: 404 TRIP_NOT_FOUND"
else
  fail "Cross-tenant PATCH: 404 TRIP_NOT_FOUND" "status '$PATCH22_STATUS', code '$PATCH22_CODE'"
fi

FIN23_STATUS=$(curl -s -o "$WORK_DIR/fin23.json" -w '%{http_code}' -X POST "$BASE_URL/trips/$TRIP_5/finalize" \
  -H "Authorization: Bearer $OWNER_B_TOKEN")
FIN23_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/fin23.json")
if [ "$FIN23_STATUS" = "404" ] && [ "$FIN23_CODE" = "TRIP_NOT_FOUND" ]; then
  pass "Cross-tenant finalize: 404 TRIP_NOT_FOUND"
else
  fail "Cross-tenant finalize: 404 TRIP_NOT_FOUND" "status '$FIN23_STATUS', code '$FIN23_CODE'"
fi

CANCEL24_STATUS=$(curl -s -o "$WORK_DIR/cancel24.json" -w '%{http_code}' -X POST "$BASE_URL/trips/$TRIP_5/cancel" \
  -H "Authorization: Bearer $OWNER_B_TOKEN" -H "Content-Type: application/json" -d '{"reason":"test"}')
CANCEL24_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/cancel24.json")
if [ "$CANCEL24_STATUS" = "404" ] && [ "$CANCEL24_CODE" = "TRIP_NOT_FOUND" ]; then
  pass "Cross-tenant cancel: 404 TRIP_NOT_FOUND"
else
  fail "Cross-tenant cancel: 404 TRIP_NOT_FOUND" "status '$CANCEL24_STATUS', code '$CANCEL24_CODE'"
fi

# ─── Step 25: concurrent finalize — exactly one wins ───
TRIP_6=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "$(create_trip_body "$DATE_T6")" | jq -r '.trip.id // empty')
[ -n "$TRIP_6" ] || TRIP_6="00000000-0000-4000-8000-000000000005"

# Backgrounded directly (NOT wrapped in a throwaway subshell) so `wait`
# actually tracks these jobs — see the Task 3.1 concurrency-test bug
# this pattern was written to avoid.
for i in $(seq 1 5); do
  curl -s -o "$WORK_DIR/f-$i.json" -w '%{http_code}' -X POST "$BASE_URL/trips/$TRIP_6/finalize" \
    -H "Authorization: Bearer $ACCT_A_TOKEN" > "$WORK_DIR/f-$i.status" &
done
wait

FIN25_200_COUNT=0
FIN25_409_COUNT=0
FIN25_OTHER_COUNT=0
for i in $(seq 1 5); do
  code=$(cat "$WORK_DIR/f-$i.status" 2>/dev/null)
  err=$(jq -r '.error.code // empty' "$WORK_DIR/f-$i.json" 2>/dev/null)
  if [ "$code" = "200" ]; then
    FIN25_200_COUNT=$((FIN25_200_COUNT + 1))
  elif [ "$code" = "409" ] && [ "$err" = "INVALID_STATE_TRANSITION" ]; then
    FIN25_409_COUNT=$((FIN25_409_COUNT + 1))
  else
    FIN25_OTHER_COUNT=$((FIN25_OTHER_COUNT + 1))
  fi
done

if [ "$FIN25_200_COUNT" = "1" ] && [ "$FIN25_409_COUNT" = "4" ] && [ "$FIN25_OTHER_COUNT" = "0" ]; then
  pass "Concurrent finalize (5 parallel requests): exactly 1×200, 4×409 INVALID_STATE_TRANSITION"
else
  fail "Concurrent finalize: exactly 1 winner" "200s=$FIN25_200_COUNT, 409s=$FIN25_409_COUNT, other=$FIN25_OTHER_COUNT"
fi

# ─── Step 26: concurrent PATCH + finalize race ───
TRIP_7=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "$(create_trip_body "$DATE_T7")" | jq -r '.trip.id // empty')
[ -n "$TRIP_7" ] || TRIP_7="00000000-0000-4000-8000-000000000006"

curl -s -o "$WORK_DIR/race-patch.json" -w '%{http_code}' -X PATCH "$BASE_URL/trips/$TRIP_7" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" -d '{"total_km":500}' > "$WORK_DIR/race-patch.status" &
curl -s -o "$WORK_DIR/race-finalize.json" -w '%{http_code}' -X POST "$BASE_URL/trips/$TRIP_7/finalize" \
  -H "Authorization: Bearer $ACCT_A_TOKEN" > "$WORK_DIR/race-finalize.status" &
wait

RACE_PATCH_STATUS=$(cat "$WORK_DIR/race-patch.status")
RACE_FINALIZE_STATUS=$(cat "$WORK_DIR/race-finalize.status")
RACE_FINAL=$(curl -s "$BASE_URL/trips/$TRIP_7" -H "Authorization: Bearer $OWNER_A_TOKEN")
RACE_FINAL_STATUS=$(echo "$RACE_FINAL" | jq -r '.trip.status')
RACE_FINAL_KM=$(echo "$RACE_FINAL" | jq -r '.trip.total_km')

STEP26_REASONS=()
# finalize can only ever succeed in this scenario — PATCH never
# advances status, so finalize is never blocked by a state it would
# reject.
[ "$RACE_FINALIZE_STATUS" = "200" ] || STEP26_REASONS+=("finalize expected 200, got '$RACE_FINALIZE_STATUS'")
if [ "$RACE_PATCH_STATUS" = "200" ]; then
  [ "$RACE_FINAL_KM" = "500" ] || STEP26_REASONS+=("PATCH won the race (200) but final total_km is '$RACE_FINAL_KM', expected 500")
elif [ "$RACE_PATCH_STATUS" = "409" ]; then
  [ "$RACE_FINAL_KM" = "217" ] || STEP26_REASONS+=("finalize won the race (PATCH 409) but final total_km is '$RACE_FINAL_KM', expected original 217")
else
  STEP26_REASONS+=("PATCH returned unexpected status '$RACE_PATCH_STATUS' (expected 200 or 409)")
fi
[ "$RACE_FINAL_STATUS" = "FINALIZED" ] || STEP26_REASONS+=("final trip status expected FINALIZED, got '$RACE_FINAL_STATUS'")

if [ ${#STEP26_REASONS[@]} -eq 0 ]; then
  pass "Concurrent PATCH + finalize race: no 500s, exactly one consistent outcome (PATCH=$RACE_PATCH_STATUS, finalize=$RACE_FINALIZE_STATUS, final total_km=$RACE_FINAL_KM)"
else
  fail "Concurrent PATCH + finalize race" "$(IFS='; '; echo "${STEP26_REASONS[*]}")"
fi

# ─── Step 27: DB-layer isolation still enforced ───
DB_COUNT_TRIPS=$(psql "${DATABASE_URL:-}" -tAc "SELECT COUNT(*) FROM trip_sheets;" 2>/dev/null | tr -d '[:space:]')

if [ "$DB_COUNT_TRIPS" = "0" ]; then
  pass "DB-layer isolation: direct psql with no tenant context set sees 0 rows in trip_sheets"
else
  fail "DB-layer isolation: 0 rows in trip_sheets with no tenant context" "trip_sheets='$DB_COUNT_TRIPS'"
fi

# ─── Step 28: markTripInvoiced service function guard ───
# Matches an actual invocation (`.markTripInvoiced(` or
# `markTripInvoiced(` as a declaration) — NOT a bare grep for the name,
# which would false-positive on trips.routes.js's own top-of-file
# comment explaining why no such route exists.
HAS_FUNCTION=$(grep -cE "function markTripInvoiced|markTripInvoiced\s*=" src/services/tripSheet.service.js 2>/dev/null || echo 0)
REFERENCED_IN_ROUTES=$(grep -rlE "\.markTripInvoiced\(" src/api/ 2>/dev/null | wc -l | tr -d '[:space:]')

if [ "$HAS_FUNCTION" -gt 0 ] && [ "$REFERENCED_IN_ROUTES" = "0" ]; then
  pass "markTripInvoiced exists as a service function but is called from no route file (not exposed as an API endpoint)"
else
  fail "markTripInvoiced guard" "function occurrences=$HAS_FUNCTION, route files calling it=$REFERENCED_IN_ROUTES"
fi

# ─── Step 29: regression — trip creation still works ───
CREATE29_STATUS=$(curl -s -o "$WORK_DIR/trip29.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $STAFF_A_TOKEN" -H "Content-Type: application/json" \
  -d "$(create_trip_body "$DATE_REGRESSION")")

if [ "$CREATE29_STATUS" = "201" ] && [ "$(jq -r '.trip.status' "$WORK_DIR/trip29.json")" = "DRAFT" ]; then
  pass "Regression: trip creation still works (201, DRAFT)"
else
  fail "Regression: trip creation still works" "status '$CREATE29_STATUS'"
fi

# ─── Step 30: regression — GET /trips/:id still works, full audit trail ───
GET30=$(curl -s "$BASE_URL/trips/$TRIP_1" -H "Authorization: Bearer $OWNER_A_TOKEN")

STEP30_REASONS=()
[ "$(echo "$GET30" | jq -r '.trip.status')" = "CANCELLED" ] || STEP30_REASONS+=("status expected CANCELLED")
[ "$(echo "$GET30" | jq -r '.trip.finalized_at')" != "null" ] || STEP30_REASONS+=("finalized_at should be present")
[ "$(echo "$GET30" | jq -r '.trip.cancelled_at')" != "null" ] || STEP30_REASONS+=("cancelled_at should be present")
[ "$(echo "$GET30" | jq -r '.trip.cancellation_reason')" = "Customer disputed the invoice" ] || STEP30_REASONS+=("cancellation_reason mismatch")

if [ ${#STEP30_REASONS[@]} -eq 0 ]; then
  pass "Regression: GET /trips/{id} still works, returns full audit trail for the CANCELLED trip"
else
  fail "Regression: GET /trips/{id}" "$(IFS='; '; echo "${STEP30_REASONS[*]}")"
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
  echo "Tenant A accountant: $ACCT_A_EMAIL"
  echo "Tenant A viewer: $VIEWER_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 1
else
  printf '%s✓ All %s checks passed. Trip lifecycle module (Task 3.3) is working correctly.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
  echo
  echo "Tenant A owner: $OWNER_A_EMAIL"
  echo "Tenant A staff: $STAFF_A_EMAIL"
  echo "Tenant A accountant: $ACCT_A_EMAIL"
  echo "Tenant A viewer: $VIEWER_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 0
fi
