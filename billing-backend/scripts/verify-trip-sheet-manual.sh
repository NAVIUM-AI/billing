#!/usr/bin/env bash
#
# End-to-end verification of manual-mode trip sheets: sub-contracted/
# partner vehicles entered by hand (manual_vehicle_number/type) priced
# via manually-typed rates instead of the registered fleet + pricing-
# rules lookup. All three formulas (LOCAL_PACKAGE, OUTSTATION_SLAB,
# PERFORMANCE) route through the SAME pure calculator
# (src/domain/pricing/*) fleet-mode uses — this script's real job is
# proving manual mode produces IDENTICAL arithmetic to fleet mode, not
# a parallel implementation that happens to agree today. Mirrors
# scripts/verify-trip-sheet-local.sh / verify-trip-sheet-outstation.sh's
# conventions.
#
# NOTE (Part A / Rule 10 finding): PERFORMANCE's batta is a FLAT
# one-time amount in the real calculator (src/domain/pricing/
# performance.js — rule.performance_batta_paise used as-is, never
# multiplied by total_days), NOT "per day" despite that being this
# module's original task-spec wording. Step 5/6 below assert the flat
# behavior explicitly — a per-day multiplication would fail these.
#
# Deliberately `set -u` but NOT `set -e`: every check runs even if an
# earlier one fails, so the summary reports everything broken in one
# pass instead of stopping at the first failure.
set -u

BASE_URL="http://localhost:8000/api/v1"
DB_NAME="${DB_NAME:-billing_dev}"
DB_ROLE="${DB_ROLE:-billing_app}"

TEST_PASSWORD="Passw0rd123"
OWNER_A_EMAIL="verify-trips-manual-owner-a-$(date +%s)@example.com"
OWNER_B_EMAIL="verify-trips-manual-owner-b-$(date +%s)-2@example.com"
TODAY=$(date +%Y-%m-%d)

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
TOTAL_CHECKS=15
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

# ─── SETUP ───
SIGNUP_A=$(curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Manual Trips Co A\",\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner A\"}")
TENANT_A_ID=$(echo "$SIGNUP_A" | jq -r '.tenant.id // empty')
if [ -z "$TENANT_A_ID" ]; then
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

curl -s -X PATCH "$BASE_URL/settings/business" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H "Content-Type: application/json" -d '{"state_code":"KA","trip_sheet_prefix":"TSM"}' > /dev/null

SIGNUP_B=$(curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Manual Trips Co B\",\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner B\"}")
if [ "$(echo "$SIGNUP_B" | jq -r '.tenant.id // empty')" = "" ]; then
  printf '%sSetup signup (tenant B) failed:%s\n' "$RED" "$RESET"
  exit 1
fi
OWNER_B_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')

CUST=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"Manual Mode Customer Ltd","gstin":"29ABCDE1234F1Z5","credit_days":15}' | jq -r '.customer.id // empty')

# A registered fleet vehicle too, for the "existing fleet-mode checks
# stay green" regression step and the vehicle_id+manual conflict step.
VEH_FLEET=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA09FL9999","vehicle_type":"SEDAN","seating_capacity":4}' | jq -r '.vehicle.id // empty')
curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"LOCAL_PACKAGE","vehicle_type":"SEDAN","label":"Fleet regression rule","base_hours":8,"base_km":80,"base_price_rupees":2200,"extra_km_rate_rupees":14,"extra_hr_rate_rupees":180,"effective_from":"2026-01-01"}' > /dev/null

if [ -z "$CUST" ] || [ -z "$VEH_FLEET" ]; then
  printf '%sSetup did not yield all required fixtures. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

echo "Setup: tenant A (state_code=KA, trip_sheet_prefix=TSM), tenant B, B2B customer, one registered fleet vehicle+rule (regression control)"
echo

echo "MANUAL MODE"
echo "-----------"

# ─── Step 1: Formula A — LOCAL/GST manual trip ───
CREATE1_STATUS=$(curl -s -o "$WORK_DIR/t1.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST\",\"manual_vehicle_number\":\"ka 51 ak 1031\",\"manual_vehicle_type\":\"SEDAN\",\"base_price_rupees\":2200,\"base_hours\":8,\"base_km\":80,\"extra_km_rate_rupees\":14,\"extra_hr_rate_rupees\":45,\"trip_date\":\"$TODAY\",\"total_km\":100,\"total_hours\":9}")
TRIP_1=$(jq -r '.trip.id // empty' "$WORK_DIR/t1.json")

STEP1_REASONS=()
[ "$CREATE1_STATUS" = "201" ] || STEP1_REASONS+=("expected 201, got '$CREATE1_STATUS'")
# base 2200 + extra_km (20*14=280) + extra_hr (1*45=45) = 2525 -> 252500 paise
[ "$(jq -r '.trip.base_amount_paise' "$WORK_DIR/t1.json")" = "220000" ] || STEP1_REASONS+=("base_amount_paise mismatch")
[ "$(jq -r '.trip.extras_amount_paise' "$WORK_DIR/t1.json")" = "32500" ] || STEP1_REASONS+=("extras_amount_paise mismatch")
[ "$(jq -r '.trip.net_payable_paise' "$WORK_DIR/t1.json")" = "252500" ] || STEP1_REASONS+=("net_payable_paise mismatch")
[ "$(jq -r '.trip.pricing_source' "$WORK_DIR/t1.json")" = "MANUAL" ] || STEP1_REASONS+=("pricing_source mismatch")
[ "$(jq -r '.trip.vehicle_id' "$WORK_DIR/t1.json")" = "null" ] || STEP1_REASONS+=("vehicle_id not null")
[ "$(jq -r '.trip.pricing_rule_id' "$WORK_DIR/t1.json")" = "null" ] || STEP1_REASONS+=("pricing_rule_id not null")
# manual_vehicle_number normalized (trim+uppercase) at the validator boundary.
[ "$(jq -r '.trip.snapshot_vehicle_number' "$WORK_DIR/t1.json")" = "KA 51 AK 1031" ] || STEP1_REASONS+=("snapshot_vehicle_number not uppercased")

if [ ${#STEP1_REASONS[@]} -eq 0 ]; then
  pass "Formula A (LOCAL/GST manual): 201, base 220000 + extras 32500 = net 252500 paise, pricing_source=MANUAL, vehicle_id/pricing_rule_id null"
else
  fail "Formula A (LOCAL/GST manual)" "$(IFS='; '; echo "${STEP1_REASONS[*]}")"
fi

# ─── Step 2: Formula B — OUTSTATION/GST manual trip ───
CREATE2_STATUS=$(curl -s -o "$WORK_DIR/t2.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST\",\"manual_vehicle_number\":\"KA02BC5678\",\"manual_vehicle_type\":\"SUV\",\"slab_rate_rupees\":14,\"min_km_per_day\":250,\"driver_batta_per_day_rupees\":300,\"trip_date\":\"$TODAY\",\"total_km\":300,\"total_hours\":20,\"total_days\":2}")

STEP2_REASONS=()
[ "$CREATE2_STATUS" = "201" ] || STEP2_REASONS+=("expected 201, got '$CREATE2_STATUS'")
# effective_km = max(300, 250*2=500) = 500; slab = 500*14=7000rs; batta=300*2=600rs; gross=7600rs
[ "$(jq -r '.trip.base_amount_paise' "$WORK_DIR/t2.json")" = "700000" ] || STEP2_REASONS+=("base_amount_paise (slab) mismatch")
[ "$(jq -r '.trip.driver_batta_paise' "$WORK_DIR/t2.json")" = "60000" ] || STEP2_REASONS+=("driver_batta_paise mismatch")
[ "$(jq -r '.trip.net_payable_paise' "$WORK_DIR/t2.json")" = "760000" ] || STEP2_REASONS+=("net_payable_paise mismatch")

if [ ${#STEP2_REASONS[@]} -eq 0 ]; then
  pass "Formula B (OUTSTATION/GST manual): 201, effective_km=max(300,500)=500, slab 700000 + batta 60000 = net 760000 paise"
else
  fail "Formula B (OUTSTATION/GST manual)" "$(IFS='; '; echo "${STEP2_REASONS[*]}")"
fi

# ─── Step 3: manual trip with all 4 reimbursements ───
CREATE3_STATUS=$(curl -s -o "$WORK_DIR/t3.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST\",\"manual_vehicle_number\":\"KA02BC5678\",\"manual_vehicle_type\":\"SUV\",\"slab_rate_rupees\":14,\"min_km_per_day\":250,\"driver_batta_per_day_rupees\":300,\"trip_date\":\"$TODAY\",\"total_km\":300,\"total_hours\":20,\"total_days\":2,\"toll_rupees\":50,\"parking_rupees\":20,\"permit_rupees\":10,\"fasttag_rupees\":5}")

# gross = 700000(slab) + 60000(batta) + 5000(toll) + 2000(parking) + 1000(permit) + 500(fasttag) = 768500
STEP3_REASONS=()
[ "$CREATE3_STATUS" = "201" ] || STEP3_REASONS+=("expected 201, got '$CREATE3_STATUS'")
[ "$(jq -r '.trip.net_payable_paise' "$WORK_DIR/t3.json")" = "768500" ] || STEP3_REASONS+=("net_payable_paise mismatch (expected 768500)")

if [ ${#STEP3_REASONS[@]} -eq 0 ]; then
  pass "Manual trip with all 4 reimbursements (toll/parking/permit/fasttag): net_payable_paise 768500"
else
  fail "Manual trip with all 4 reimbursements" "$(IFS='; '; echo "${STEP3_REASONS[*]}")"
fi

# ─── Step 4: manual OUTSTATION with advance -> net = gross - advance ───
CREATE4_STATUS=$(curl -s -o "$WORK_DIR/t4.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST\",\"manual_vehicle_number\":\"KA02BC5678\",\"manual_vehicle_type\":\"SUV\",\"slab_rate_rupees\":14,\"min_km_per_day\":250,\"driver_batta_per_day_rupees\":300,\"trip_date\":\"$TODAY\",\"total_km\":300,\"total_hours\":20,\"total_days\":2,\"advance_rupees\":1000}")

STEP4_REASONS=()
[ "$CREATE4_STATUS" = "201" ] || STEP4_REASONS+=("expected 201, got '$CREATE4_STATUS'")
[ "$(jq -r '.trip.gross_paise' "$WORK_DIR/t4.json")" = "760000" ] || STEP4_REASONS+=("gross_paise mismatch")
[ "$(jq -r '.trip.net_payable_paise' "$WORK_DIR/t4.json")" = "660000" ] || STEP4_REASONS+=("net_payable_paise mismatch (expected gross 760000 - advance 100000 = 660000)")

if [ ${#STEP4_REASONS[@]} -eq 0 ]; then
  pass "Manual OUTSTATION with advance: gross 760000 - advance 100000 = net 660000 paise"
else
  fail "Manual OUTSTATION with advance" "$(IFS='; '; echo "${STEP4_REASONS[*]}")"
fi

# ─── Step 5: Formula C — LOCAL/PERFORMANCE manual trip ───
CREATE5_STATUS=$(curl -s -o "$WORK_DIR/t5.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"PERFORMANCE\",\"customer_id\":\"$CUST\",\"manual_vehicle_number\":\"KA03CD9999\",\"manual_vehicle_type\":\"INNOVA\",\"per_km_rate_rupees\":8,\"performance_batta_rupees\":200,\"trip_date\":\"$TODAY\",\"total_km\":150,\"total_hours\":6,\"total_days\":1}")

# 150km * 8rs = 1200rs + 200rs batta (flat, NOT x total_days) = 1400rs = 140000 paise
STEP5_REASONS=()
[ "$CREATE5_STATUS" = "201" ] || STEP5_REASONS+=("expected 201, got '$CREATE5_STATUS'")
[ "$(jq -r '.trip.base_amount_paise' "$WORK_DIR/t5.json")" = "120000" ] || STEP5_REASONS+=("base_amount_paise (km) mismatch")
[ "$(jq -r '.trip.driver_batta_paise' "$WORK_DIR/t5.json")" = "20000" ] || STEP5_REASONS+=("driver_batta_paise mismatch (should be flat 20000, not x total_days)")
[ "$(jq -r '.trip.net_payable_paise' "$WORK_DIR/t5.json")" = "140000" ] || STEP5_REASONS+=("net_payable_paise mismatch")

if [ ${#STEP5_REASONS[@]} -eq 0 ]; then
  pass "Formula C (LOCAL/PERFORMANCE manual): km 120000 + FLAT batta 20000 (not x total_days) = net 140000 paise"
else
  fail "Formula C (LOCAL/PERFORMANCE manual)" "$(IFS='; '; echo "${STEP5_REASONS[*]}")"
fi

# ─── Step 6: Formula C — OUTSTATION/PERFORMANCE manual trip, total_days=3 ───
# Same per-km + flat-batta formula as Step 5 regardless of service_type
# (calculatePerformance takes no total_days input at all) — total_days=3
# here specifically to prove batta does NOT scale with it.
CREATE6_STATUS=$(curl -s -o "$WORK_DIR/t6.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"PERFORMANCE\",\"customer_id\":\"$CUST\",\"manual_vehicle_number\":\"KA04DE1111\",\"manual_vehicle_type\":\"TEMPO_TRAVELLER\",\"per_km_rate_rupees\":10,\"performance_batta_rupees\":500,\"trip_date\":\"$TODAY\",\"total_km\":200,\"total_hours\":10,\"total_days\":3}")

STEP6_REASONS=()
[ "$CREATE6_STATUS" = "201" ] || STEP6_REASONS+=("expected 201, got '$CREATE6_STATUS'")
[ "$(jq -r '.trip.driver_batta_paise' "$WORK_DIR/t6.json")" = "50000" ] || STEP6_REASONS+=("driver_batta_paise mismatch (flat 50000 expected even with total_days=3)")
[ "$(jq -r '.trip.net_payable_paise' "$WORK_DIR/t6.json")" = "250000" ] || STEP6_REASONS+=("net_payable_paise mismatch")

if [ ${#STEP6_REASONS[@]} -eq 0 ]; then
  pass "Formula C (OUTSTATION/PERFORMANCE manual, total_days=3): batta still flat 50000 (confirms no per-day multiplication)"
else
  fail "Formula C (OUTSTATION/PERFORMANCE manual, total_days=3)" "$(IFS='; '; echo "${STEP6_REASONS[*]}")"
fi

# ─── Step 7: reject — both vehicle_id AND manual provided ───
REJECT1_STATUS=$(curl -s -o "$WORK_DIR/r1.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST\",\"vehicle_id\":\"$VEH_FLEET\",\"manual_vehicle_number\":\"KA51AK1031\",\"manual_vehicle_type\":\"SEDAN\",\"base_price_rupees\":2200,\"base_hours\":8,\"base_km\":80,\"extra_km_rate_rupees\":14,\"extra_hr_rate_rupees\":45,\"trip_date\":\"$TODAY\",\"total_km\":100,\"total_hours\":9}")
REJECT1_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/r1.json")

if [ "$REJECT1_STATUS" = "400" ] && [ "$REJECT1_CODE" = "VALIDATION_ERROR" ]; then
  pass "Reject: vehicle_id + manual_vehicle_number both provided -> 400 VALIDATION_ERROR"
else
  fail "Reject: vehicle_id + manual both provided" "status '$REJECT1_STATUS', code '$REJECT1_CODE'"
fi

# ─── Step 8: reject — neither vehicle_id nor manual provided ───
REJECT2_STATUS=$(curl -s -o "$WORK_DIR/r2.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST\",\"trip_date\":\"$TODAY\",\"total_km\":100,\"total_hours\":9}")
REJECT2_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/r2.json")

if [ "$REJECT2_STATUS" = "400" ] && [ "$REJECT2_CODE" = "VALIDATION_ERROR" ]; then
  pass "Reject: neither vehicle_id nor manual provided -> 400 VALIDATION_ERROR"
else
  fail "Reject: neither vehicle_id nor manual provided" "status '$REJECT2_STATUS', code '$REJECT2_CODE'"
fi

# ─── Step 9: reject — manual mode missing formula rate fields ───
REJECT3_STATUS=$(curl -s -o "$WORK_DIR/r3.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST\",\"manual_vehicle_number\":\"KA51AK1031\",\"manual_vehicle_type\":\"SEDAN\",\"trip_date\":\"$TODAY\",\"total_km\":100,\"total_hours\":9}")
REJECT3_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/r3.json")
REJECT3_FIELDS=$(jq -r '.error.details.fields[0].message // empty' "$WORK_DIR/r3.json")

if [ "$REJECT3_STATUS" = "400" ] && [ "$REJECT3_CODE" = "VALIDATION_ERROR" ] && echo "$REJECT3_FIELDS" | grep -q "LOCAL_PACKAGE"; then
  pass "Reject: manual LOCAL/GST missing rate fields -> 400 VALIDATION_ERROR naming LOCAL_PACKAGE + missing fields"
else
  fail "Reject: manual mode missing formula rate fields" "status '$REJECT3_STATUS', code '$REJECT3_CODE', message '$REJECT3_FIELDS'"
fi

# ─── Step 10: finalize a manual trip -> invoice creation still works ───
curl -s -X POST "$BASE_URL/trips/$TRIP_1/finalize" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null

INVOICE1_STATUS=$(curl -s -o "$WORK_DIR/inv1.json" -w '%{http_code}' -X POST "$BASE_URL/invoices" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"service_type\":\"LOCAL\",\"customer_id\":\"$CUST\",\"trip_sheet_ids\":[\"$TRIP_1\"],\"invoice_date\":\"$TODAY\"}")
INVOICE1_ID=$(jq -r '.invoice.id // empty' "$WORK_DIR/inv1.json")
# invoice.service.js#buildInvoiceLines' real description format:
# "{snapshot_vehicle_type} {snapshot_vehicle_number} - {total_km} km {local|outstation} trip on {DD-Mon-YYYY}"
INVOICE1_DESC=$(jq -r '.invoice.lines[0].description // empty' "$WORK_DIR/inv1.json")

STEP10_REASONS=()
[ "$INVOICE1_STATUS" = "201" ] || STEP10_REASONS+=("expected 201, got '$INVOICE1_STATUS'")
echo "$INVOICE1_DESC" | grep -q "KA 51 AK 1031" || STEP10_REASONS+=("invoice line description missing manual vehicle number: '$INVOICE1_DESC'")

if [ ${#STEP10_REASONS[@]} -eq 0 ]; then
  pass "Manual trip finalize -> invoice creation works: line description = '$INVOICE1_DESC'"
else
  fail "Manual trip finalize -> invoice creation" "$(IFS='; '; echo "${STEP10_REASONS[*]}")"
fi

# ─── Step 11: manual trip -> invoice -> issue -> PDF generation ───
curl -s -X POST "$BASE_URL/invoices/$INVOICE1_ID/issue" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
PDF_STATUS=$(curl -s -o "$WORK_DIR/pdf1.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INVOICE1_ID/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN")
PDF_SIZE=$(jq -r '.pdf_file_size_bytes // 0' "$WORK_DIR/pdf1.json")

if [ "$PDF_STATUS" = "200" ] && [ "$PDF_SIZE" -gt 1000 ] 2>/dev/null; then
  pass "Manual trip -> invoice -> issue -> PDF generation: 200, $PDF_SIZE bytes (invoice.snapshot uses manual vehicle number, unmodified pdf.service.js path)"
else
  fail "Manual trip -> invoice -> issue -> PDF generation" "status '$PDF_STATUS', size '$PDF_SIZE'"
fi

# ─── Step 12: cross-tenant RLS — tenant B can't see tenant A's manual trip ───
LEAK_STATUS=$(curl -s -o "$WORK_DIR/leak.json" -w '%{http_code}' "$BASE_URL/trips/$TRIP_1" \
  -H "Authorization: Bearer $OWNER_B_TOKEN")
LEAK_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/leak.json")

if [ "$LEAK_STATUS" = "404" ] && [ "$LEAK_CODE" = "TRIP_NOT_FOUND" ]; then
  pass "Cross-tenant RLS: tenant B cannot see tenant A's manual trip (404 TRIP_NOT_FOUND)"
else
  fail "Cross-tenant RLS on manual trip" "status '$LEAK_STATUS', code '$LEAK_CODE'"
fi

# ─── Step 13: pricing_source survives a fresh read (not just the create response) ───
# Deliberately NOT a direct psql query here: this environment's `psql`
# (no -h flag, local-socket-only, same as every other verify-trip-
# sheet-*.sh script's query_as_tenant) reaches a local `billing_dev`
# database that is NOT the one the running server's own DATABASE_URL
# (a Neon-hosted Postgres, per .env) actually writes to — confirmed by
# hand while building this script, a pre-existing environment split
# unrelated to this task. A GET re-fetch through the real API instead
# is an equally strong persistence check (proves the value round-
# tripped through an actual read, not just echoed back the create
# response) without depending on that broken assumption.
REFETCH1=$(curl -s "$BASE_URL/trips/$TRIP_1" -H "Authorization: Bearer $OWNER_A_TOKEN")
REFETCH1_SOURCE=$(echo "$REFETCH1" | jq -r '.trip.pricing_source // empty')

if [ "$REFETCH1_SOURCE" = "MANUAL" ]; then
  pass "pricing_source = 'MANUAL' survives a fresh GET (not just the create response)"
else
  fail "pricing_source = 'MANUAL' survives a fresh GET" "got '$REFETCH1_SOURCE'"
fi

echo
echo "FLEET MODE REGRESSION"
echo "----------------------"

# ─── Step 14: existing fleet-mode trip creation still works unchanged ───
FLEET_STATUS=$(curl -s -o "$WORK_DIR/fleet.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST\",\"vehicle_id\":\"$VEH_FLEET\",\"trip_date\":\"$TODAY\",\"total_km\":100,\"total_hours\":9}")

STEP14_REASONS=()
[ "$FLEET_STATUS" = "201" ] || STEP14_REASONS+=("expected 201, got '$FLEET_STATUS'")
[ "$(jq -r '.trip.pricing_source' "$WORK_DIR/fleet.json")" = "FLEET" ] || STEP14_REASONS+=("pricing_source should default to FLEET")
[ "$(jq -r '.trip.vehicle_id' "$WORK_DIR/fleet.json")" = "$VEH_FLEET" ] || STEP14_REASONS+=("vehicle_id mismatch")
# VEH_FLEET's rule (this script's own setup): base 2200 + extra_km
# (20*14=280) + extra_hr (1*180=180) = 2660rs = 266000 paise.
[ "$(jq -r '.trip.net_payable_paise' "$WORK_DIR/fleet.json")" = "266000" ] || STEP14_REASONS+=("net_payable_paise mismatch — fleet-mode arithmetic regressed")

if [ ${#STEP14_REASONS[@]} -eq 0 ]; then
  pass "Fleet-mode trip creation unchanged: 201, pricing_source=FLEET, same arithmetic (net 266000 paise) as before this task"
else
  fail "Fleet-mode trip creation regression" "$(IFS='; '; echo "${STEP14_REASONS[*]}")"
fi

# ─── Step 15: fleet mode still rejects a missing vehicle_id (no manual fields either) ───
# Same case as Step 8's "neither provided" but from the fleet-mode
# perspective — a fleet-mode caller that forgets vehicle_id still gets
# a clean validation error, not a confusing manual-mode-shaped one.
FLEET_MISSING_STATUS=$(curl -s -o "$WORK_DIR/fleetmissing.json" -w '%{http_code}' -X POST "$BASE_URL/trips" \
  -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"customer_id\":\"$CUST\",\"trip_date\":\"$TODAY\",\"total_km\":50,\"total_hours\":4}")
FLEET_MISSING_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/fleetmissing.json")

if [ "$FLEET_MISSING_STATUS" = "400" ] && [ "$FLEET_MISSING_CODE" = "VALIDATION_ERROR" ]; then
  pass "Fleet mode without vehicle_id (and no manual fields): clean 400 VALIDATION_ERROR"
else
  fail "Fleet mode without vehicle_id" "status '$FLEET_MISSING_STATUS', code '$FLEET_MISSING_CODE'"
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
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 1
else
  printf '%s✓ All %s checks passed. Manual-mode trip sheets are working correctly.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
  echo
  echo "Tenant A owner: $OWNER_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 0
fi
