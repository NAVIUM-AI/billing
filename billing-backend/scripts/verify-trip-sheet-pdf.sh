#!/usr/bin/env bash
#
# End-to-end verification of Trip Sheet -> Proforma PDF generation
# (Module 5 / Task A, extended by Task B1 for multi-vehicle): a trip
# sheet can render its own Proforma PDF directly from its own frozen
# columns (no invoice involved), its customer is optional (a real
# customer_id, a free-text manual_customer_name, or neither), and as of
# Task B1 a sheet can carry 1-10 vehicles, each contributing its own row
# to the PDF, summed to one Net Payable. Mirrors scripts/verify-pdf.sh's
# pdftotext-based content-assertion style and
# scripts/verify-trip-sheet-manual.sh's tenant A/B setup conventions.
#
# Rule 13 note: this script is automation, not the acceptance gate —
# every PDF it generates was also visually opened and reviewed by hand
# (LOCAL+real customer, LOCAL+free-text name, LOCAL+no customer,
# OUTSTATION+no customer, LOCAL+multi-vehicle, OUTSTATION+multi-vehicle)
# before this task was declared done. A green run here does not by
# itself mean the layout is correct.
#
# Deliberately `set -u` but NOT `set -e`: every check runs even if an
# earlier one fails, so the summary reports everything broken in one
# pass instead of stopping at the first failure.
set -u

BASE_URL="http://localhost:8000/api/v1"

TEST_PASSWORD="Passw0rd123"
OWNER_A_EMAIL="verify-trips-pdf-owner-a-$(date +%s)@example.com"
OWNER_B_EMAIL="verify-trips-pdf-owner-b-$(date +%s)-2@example.com"
TODAY=$(date +%Y-%m-%d)

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
TOTAL_CHECKS=22
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

if ! command -v pdftotext >/dev/null 2>&1; then
  printf '%spdftotext is required for this script'\''s content assertions.\nInstall it with: brew install poppler%s\n' "$RED" "$RESET"
  exit 1
fi
echo "  pdftotext is installed"
echo

# ─── SETUP ───
SIGNUP_A=$(curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Trip PDF Co A\",\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner A\"}")
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
  -H "Content-Type: application/json" -d '{"state_code":"KA","trip_sheet_prefix":"TSP"}' > /dev/null

SIGNUP_B=$(curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Trip PDF Co B\",\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner B\"}")
if [ "$(echo "$SIGNUP_B" | jq -r '.tenant.id // empty')" = "" ]; then
  printf '%sSetup signup (tenant B) failed:%s\n' "$RED" "$RESET"
  exit 1
fi
OWNER_B_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')

CUST=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"Trip PDF Customer Ltd","gstin":"29ABCDE1234F1Z5","state_code":"KA","credit_days":15,"address":{"line1":"MG Road","city":"Bengaluru","state":"Karnataka","pincode":"560001","country":"India"}}' \
  | jq -r '.customer.id // empty')
if [ -z "$CUST" ]; then
  printf '%sSetup did not yield a customer. Aborting.%s\n' "$RED" "$RESET"
  exit 1
fi

echo "Setup: tenant A (state_code=KA, trip_sheet_prefix=TSP), tenant B, one B2B customer"
echo

echo "TRIP SHEET PDF"
echo "--------------"

create_local_trip() {
  # $1 = extra JSON fragment for customer fields (or empty)
  # Task B1: vehicle/rate/usage fields now live inside vehicles[] — one
  # vehicle here, same rate values as before the restructure, so the
  # 2,525 net-payable assertion below stays byte-for-byte comparable
  # (backfill/parity requirement, Part I of the Task B1 spec).
  curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
    -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"trip_date\":\"$TODAY\",\"booked_by\":\"Verify Script\",\"vehicles\":[{\"manual_vehicle_number\":\"KA51AK1031\",\"manual_vehicle_type\":\"SEDAN\",\"base_price_rupees\":2200,\"base_hours\":8,\"base_km\":80,\"extra_km_rate_rupees\":14,\"extra_hr_rate_rupees\":45,\"total_km\":100,\"total_hours\":9}]$1}"
}

# ─── Step 1: LOCAL trip WITH a real customer -> Proforma PDF ───
T_CUST_RESP=$(create_local_trip ",\"customer_id\":\"$CUST\"")
T_CUST=$(echo "$T_CUST_RESP" | jq -r '.trip.id // empty')
curl -s -X POST "$BASE_URL/trips/$T_CUST/finalize" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
GEN1=$(curl -s -X POST "$BASE_URL/trips/$T_CUST/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN")
GEN1_URL=$(echo "$GEN1" | jq -r '.pdf_url // empty')
curl -s "$BASE_URL/trips/$T_CUST/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" -o "$WORK_DIR/t_cust.pdf"
T_CUST_TEXT=$(pdftotext -layout "$WORK_DIR/t_cust.pdf" - 2>/dev/null)

if [ -n "$GEN1_URL" ] && echo "$T_CUST_TEXT" | grep -q "PROFORMA INVOICE" && echo "$T_CUST_TEXT" | grep -q "Trip PDF Customer Ltd"; then
  pass "LOCAL trip with real customer: Proforma PDF generated, heading + Bill To correct"
else
  fail "LOCAL trip with real customer" "pdf_url='$GEN1_URL', text_has_heading=$(echo "$T_CUST_TEXT" | grep -c 'PROFORMA INVOICE')"
fi

if ! echo "$T_CUST_TEXT" | grep -qE "CGST|SGST|IGST"; then
  pass "LOCAL trip with real customer: no CGST/SGST/IGST anywhere (Proforma, never TAX)"
else
  fail "LOCAL trip with real customer" "found GST text in a document that must never show it"
fi

if echo "$T_CUST_TEXT" | grep -q "Net Payable" && echo "$T_CUST_TEXT" | grep -q "2,525"; then
  pass "LOCAL trip with real customer: Net Payable amount correct (2,525.00)"
else
  fail "LOCAL trip with real customer" "expected net payable 2,525 not found"
fi

# ─── Step 2: LOCAL trip, FREE-TEXT customer name, no customer_id ───
T_FREETEXT_RESP=$(create_local_trip ",\"manual_customer_name\":\"Free Text Verify Co\"")
T_FREETEXT=$(echo "$T_FREETEXT_RESP" | jq -r '.trip.id // empty')
FREETEXT_CUSTOMER_ID=$(echo "$T_FREETEXT_RESP" | jq -r '.trip.customer_id')
curl -s -X POST "$BASE_URL/trips/$T_FREETEXT/finalize" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/trips/$T_FREETEXT/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s "$BASE_URL/trips/$T_FREETEXT/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" -o "$WORK_DIR/t_freetext.pdf"
FREETEXT_TEXT=$(pdftotext -layout "$WORK_DIR/t_freetext.pdf" - 2>/dev/null)
FREETEXT_BILLTO=$(echo "$FREETEXT_TEXT" | sed -n '/BILL TO/,/SERVICE DETAILS/p')

if [ "$FREETEXT_CUSTOMER_ID" = "null" ] && echo "$FREETEXT_TEXT" | grep -q "Free Text Verify Co"; then
  pass "LOCAL trip with free-text customer name: no customer_id, name appears in Bill To"
else
  fail "LOCAL trip with free-text customer name" "customer_id='$FREETEXT_CUSTOMER_ID', name_found=$(echo "$FREETEXT_TEXT" | grep -c 'Free Text Verify Co')"
fi

if ! echo "$FREETEXT_BILLTO" | grep -q "GSTIN"; then
  pass "LOCAL trip with free-text customer name: no GSTIN line (no real customer record)"
else
  fail "LOCAL trip with free-text customer name" "GSTIN line rendered for a free-text-only customer"
fi

# ─── Step 3: LOCAL trip with NO customer at all ───
T_NONE_RESP=$(create_local_trip "")
T_NONE=$(echo "$T_NONE_RESP" | jq -r '.trip.id // empty')
curl -s -X POST "$BASE_URL/trips/$T_NONE/finalize" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
GEN3_STATUS=$(curl -s -o "$WORK_DIR/gen3.json" -w '%{http_code}' -X POST "$BASE_URL/trips/$T_NONE/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN")
curl -s "$BASE_URL/trips/$T_NONE/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" -o "$WORK_DIR/t_none.pdf"
NONE_TEXT=$(pdftotext -layout "$WORK_DIR/t_none.pdf" - 2>/dev/null)

if [ "$GEN3_STATUS" = "200" ] && echo "$NONE_TEXT" | grep -q "No customer specified"; then
  pass "LOCAL trip with no customer at all: PDF still renders, clear placeholder shown"
else
  fail "LOCAL trip with no customer at all" "status='$GEN3_STATUS', placeholder_found=$(echo "$NONE_TEXT" | grep -c 'No customer specified')"
fi

# ─── Step 4: OUTSTATION trip -> Proforma PDF with outstation-shaped columns ───
T_OUT_RESP=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"trip_date\":\"$TODAY\",\"booked_by\":\"Verify Script\",\"vehicles\":[{\"manual_vehicle_number\":\"KA51AK2042\",\"manual_vehicle_type\":\"INNOVA\",\"slab_rate_rupees\":14,\"min_km_per_day\":250,\"driver_batta_per_day_rupees\":300,\"total_km\":300,\"total_hours\":10,\"toll_rupees\":100}]}")
T_OUT=$(echo "$T_OUT_RESP" | jq -r '.trip.id // empty')
curl -s -X POST "$BASE_URL/trips/$T_OUT/finalize" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/trips/$T_OUT/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s "$BASE_URL/trips/$T_OUT/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" -o "$WORK_DIR/t_out.pdf"
OUT_TEXT=$(pdftotext -layout "$WORK_DIR/t_out.pdf" - 2>/dev/null)

if echo "$OUT_TEXT" | grep -q "PROFORMA INVOICE" && echo "$OUT_TEXT" | grep -q "Running" && echo "$OUT_TEXT" | grep -q "Bata"; then
  pass "OUTSTATION trip: Proforma PDF with running-km/driver-bata columns"
else
  fail "OUTSTATION trip" "heading/columns not found as expected"
fi

if ! echo "$OUT_TEXT" | grep -qE "CGST|SGST|IGST"; then
  pass "OUTSTATION trip: no CGST/SGST/IGST anywhere"
else
  fail "OUTSTATION trip" "found GST text in a document that must never show it"
fi

if echo "$OUT_TEXT" | grep -q "4,600"; then
  pass "OUTSTATION trip: Net Payable amount correct (4,600.00 = 4200 slab + 300 batta + 100 toll)"
else
  fail "OUTSTATION trip" "expected net payable 4,600 not found"
fi

# ─── Step 5: DRAFT trip sheet -> PDF is gated with a clean 400 ───
T_DRAFT_RESP=$(create_local_trip "")
T_DRAFT=$(echo "$T_DRAFT_RESP" | jq -r '.trip.id // empty')
DRAFT_STATUS=$(curl -s -o "$WORK_DIR/draft.json" -w '%{http_code}' -X POST "$BASE_URL/trips/$T_DRAFT/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN")
DRAFT_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/draft.json")

if [ "$DRAFT_STATUS" = "400" ] && [ "$DRAFT_CODE" = "TRIP_NOT_FINALIZED" ]; then
  pass "DRAFT trip sheet: PDF generation rejected with 400 TRIP_NOT_FINALIZED"
else
  fail "DRAFT trip sheet PDF gate" "status='$DRAFT_STATUS', code='$DRAFT_CODE'"
fi

# ─── Step 6: GET before any generation -> 404 PDF_NOT_GENERATED ───
curl -s -X POST "$BASE_URL/trips/$T_DRAFT/finalize" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
NOTGEN_STATUS=$(curl -s -o "$WORK_DIR/notgen.json" -w '%{http_code}' "$BASE_URL/trips/$T_DRAFT/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN")
NOTGEN_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/notgen.json")

if [ "$NOTGEN_STATUS" = "404" ] && [ "$NOTGEN_CODE" = "PDF_NOT_GENERATED" ]; then
  pass "GET PDF before it's ever been generated: 404 PDF_NOT_GENERATED"
else
  fail "GET PDF before generation" "status='$NOTGEN_STATUS', code='$NOTGEN_CODE'"
fi

# ─── Step 7: regeneration is idempotent (same pdf_url both times) ───
REGEN1=$(curl -s -X POST "$BASE_URL/trips/$T_DRAFT/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pdf_url // empty')
REGEN2=$(curl -s -X POST "$BASE_URL/trips/$T_DRAFT/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.pdf_url // empty')

if [ -n "$REGEN1" ] && [ "$REGEN1" = "$REGEN2" ]; then
  pass "Regenerating an already-generated trip-sheet PDF is idempotent: same pdf_url"
else
  fail "Idempotent regeneration" "first='$REGEN1', second='$REGEN2'"
fi

# ─── Step 8: cross-tenant isolation — tenant B can't touch tenant A's trip PDF ───
CROSS_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/trips/$T_CUST/pdf" -H "Authorization: Bearer $OWNER_B_TOKEN")

if [ "$CROSS_STATUS" = "404" ]; then
  pass "Cross-tenant isolation: tenant B generating tenant A's trip PDF -> 404"
else
  fail "Cross-tenant isolation" "expected 404, got '$CROSS_STATUS'"
fi

# ─── Step 9: nonexistent trip id -> 404 TRIP_NOT_FOUND ───
FAKE_STATUS=$(curl -s -o "$WORK_DIR/fake.json" -w '%{http_code}' -X POST "$BASE_URL/trips/00000000-0000-4000-8000-000000000000/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN")
FAKE_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/fake.json")

if [ "$FAKE_STATUS" = "404" ] && [ "$FAKE_CODE" = "TRIP_NOT_FOUND" ]; then
  pass "Nonexistent trip id: 404 TRIP_NOT_FOUND"
else
  fail "Nonexistent trip id" "status='$FAKE_STATUS', code='$FAKE_CODE'"
fi

# ─── Step 10: LOCAL sheet with 3 vehicles -> 3 rows, footer = sum, no GST ───
T_MULTI3_RESP=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"trip_date\":\"$TODAY\",\"customer_id\":\"$CUST\",\"vehicles\":[{\"manual_vehicle_number\":\"KA51AA0001\",\"manual_vehicle_type\":\"SEDAN\",\"base_price_rupees\":2200,\"base_hours\":8,\"base_km\":80,\"extra_km_rate_rupees\":14,\"extra_hr_rate_rupees\":45,\"total_km\":100,\"total_hours\":9},{\"manual_vehicle_number\":\"KA51AA0002\",\"manual_vehicle_type\":\"SUV\",\"base_price_rupees\":3200,\"base_hours\":8,\"base_km\":80,\"extra_km_rate_rupees\":18,\"extra_hr_rate_rupees\":55,\"total_km\":100,\"total_hours\":9},{\"manual_vehicle_number\":\"KA51AA0003\",\"manual_vehicle_type\":\"HATCHBACK\",\"base_price_rupees\":1800,\"base_hours\":8,\"base_km\":80,\"extra_km_rate_rupees\":12,\"extra_hr_rate_rupees\":40,\"total_km\":100,\"total_hours\":9}]}")
T_MULTI3=$(echo "$T_MULTI3_RESP" | jq -r '.trip.id // empty')
MULTI3_TOTAL_PAISE=$(echo "$T_MULTI3_RESP" | jq -r '.trip.total_net_payable_paise // empty')
curl -s -X POST "$BASE_URL/trips/$T_MULTI3/finalize" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/trips/$T_MULTI3/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s "$BASE_URL/trips/$T_MULTI3/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" -o "$WORK_DIR/t_multi3.pdf"
MULTI3_TEXT=$(pdftotext -layout "$WORK_DIR/t_multi3.pdf" - 2>/dev/null)
MULTI3_EXPECTED_RUPEES=$(awk -v p="$MULTI3_TOTAL_PAISE" 'BEGIN { printf "%.2f", p/100 }')

if echo "$MULTI3_TEXT" | grep -q "KA51AA0001" && echo "$MULTI3_TEXT" | grep -q "KA51AA0002" && echo "$MULTI3_TEXT" | grep -q "KA51AA0003"; then
  pass "LOCAL sheet with 3 vehicles: all 3 rows present"
else
  fail "LOCAL sheet with 3 vehicles" "one or more vehicle rows missing"
fi

if echo "$MULTI3_TEXT" | tr -d ',' | grep -q "$MULTI3_EXPECTED_RUPEES" && ! echo "$MULTI3_TEXT" | grep -qE "CGST|SGST|IGST"; then
  pass "LOCAL sheet with 3 vehicles: footer sums to API's total_net_payable_paise ($MULTI3_EXPECTED_RUPEES), no GST"
else
  fail "LOCAL sheet with 3 vehicles" "expected footer '$MULTI3_EXPECTED_RUPEES' not found, or GST text present"
fi

# ─── Step 11: OUTSTATION sheet with 2 vehicles -> 2 rows, batta/toll per row, summed footer ───
T_MULTI2OUT_RESP=$(curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"OUTSTATION\",\"billing_mode\":\"GST\",\"trip_date\":\"$TODAY\",\"customer_id\":\"$CUST\",\"vehicles\":[{\"manual_vehicle_number\":\"KA51BB0001\",\"manual_vehicle_type\":\"SEDAN\",\"slab_rate_rupees\":14,\"min_km_per_day\":250,\"driver_batta_per_day_rupees\":300,\"total_km\":300,\"total_hours\":10,\"toll_rupees\":100},{\"manual_vehicle_number\":\"KA51BB0002\",\"manual_vehicle_type\":\"INNOVA\",\"slab_rate_rupees\":18,\"min_km_per_day\":250,\"driver_batta_per_day_rupees\":350,\"total_km\":280,\"total_hours\":9,\"toll_rupees\":80}]}")
T_MULTI2OUT=$(echo "$T_MULTI2OUT_RESP" | jq -r '.trip.id // empty')
MULTI2OUT_TOTAL_PAISE=$(echo "$T_MULTI2OUT_RESP" | jq -r '.trip.total_net_payable_paise // empty')
curl -s -X POST "$BASE_URL/trips/$T_MULTI2OUT/finalize" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/trips/$T_MULTI2OUT/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s "$BASE_URL/trips/$T_MULTI2OUT/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" -o "$WORK_DIR/t_multi2out.pdf"
MULTI2OUT_TEXT=$(pdftotext -layout "$WORK_DIR/t_multi2out.pdf" - 2>/dev/null)
MULTI2OUT_EXPECTED_RUPEES=$(awk -v p="$MULTI2OUT_TOTAL_PAISE" 'BEGIN { printf "%.2f", p/100 }')

if echo "$MULTI2OUT_TEXT" | grep -q "KA51BB0001" && echo "$MULTI2OUT_TEXT" | grep -q "KA51BB0002" && echo "$MULTI2OUT_TEXT" | grep -q "Bata"; then
  pass "OUTSTATION sheet with 2 vehicles: both rows present with batta column"
else
  fail "OUTSTATION sheet with 2 vehicles" "one or more vehicle rows / batta column missing"
fi

if echo "$MULTI2OUT_TEXT" | tr -d ',' | grep -q "$MULTI2OUT_EXPECTED_RUPEES"; then
  pass "OUTSTATION sheet with 2 vehicles: footer sums to API's total_net_payable_paise ($MULTI2OUT_EXPECTED_RUPEES)"
else
  fail "OUTSTATION sheet with 2 vehicles" "expected footer '$MULTI2OUT_EXPECTED_RUPEES' not found"
fi

# ─── Step 12: > 10 vehicles rejected with 400 ───
MANY_VEHICLES=$(for i in $(seq 1 11); do printf '{"manual_vehicle_number":"KA51CC%04d","manual_vehicle_type":"SEDAN","base_price_rupees":2000,"base_hours":8,"base_km":80,"extra_km_rate_rupees":12,"extra_hr_rate_rupees":40,"total_km":100,"total_hours":9}' "$i"; [ "$i" -lt 11 ] && printf ','; done)
TOO_MANY_STATUS=$(curl -s -o "$WORK_DIR/toomany.json" -w '%{http_code}' -X POST "$BASE_URL/trips" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"trip_date\":\"$TODAY\",\"vehicles\":[$MANY_VEHICLES]}")

if [ "$TOO_MANY_STATUS" = "400" ]; then
  pass ">10 vehicles rejected with 400"
else
  fail ">10 vehicles rejected" "expected 400, got '$TOO_MANY_STATUS'"
fi

# ─── Step 13: 0 vehicles rejected with 400 ───
ZERO_STATUS=$(curl -s -o "$WORK_DIR/zero.json" -w '%{http_code}' -X POST "$BASE_URL/trips" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"service_type\":\"LOCAL\",\"billing_mode\":\"GST\",\"trip_date\":\"$TODAY\",\"vehicles\":[]}")

if [ "$ZERO_STATUS" = "400" ]; then
  pass "0 vehicles rejected with 400"
else
  fail "0 vehicles rejected" "expected 400, got '$ZERO_STATUS'"
fi

# ─── Step 14: multi-vehicle trip does NOT appear in invoiceable-trips ───
curl -s -X PATCH "$BASE_URL/settings/business" -H "Authorization: Bearer $OWNER_A_TOKEN" \
  -H "Content-Type: application/json" -d '{"gst_rate":5}' > /dev/null
INVOICEABLE=$(curl -s "$BASE_URL/customers/$CUST/invoiceable-trips" -H "Authorization: Bearer $OWNER_A_TOKEN")
MULTI3_IN_PICKER=$(echo "$INVOICEABLE" | jq --arg id "$T_MULTI3" '[.groups.LOCAL.trips[] | select(.id == $id)] | length')

if [ "$MULTI3_IN_PICKER" = "0" ]; then
  pass "Multi-vehicle trip excluded from GET /customers/:id/invoiceable-trips"
else
  fail "Multi-vehicle trip exclusion" "found in invoiceable-trips picker (count=$MULTI3_IN_PICKER)"
fi

# ─── Step 15: single-vehicle trip still invoices end-to-end (GST unaffected) ───
INV_CREATE_STATUS=$(curl -s -o "$WORK_DIR/inv.json" -w '%{http_code}' -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST\",\"invoice_date\":\"$TODAY\",\"trip_sheet_ids\":[\"$T_CUST\"]}")
INV_LINE_COUNT=$(jq -r '.invoice.lines | length // 0' "$WORK_DIR/inv.json")

if [ "$INV_CREATE_STATUS" = "201" ] && [ "$INV_LINE_COUNT" = "1" ]; then
  pass "Single-vehicle trip still invoices end-to-end via GST wizard"
else
  fail "Single-vehicle GST invoicing" "status='$INV_CREATE_STATUS', line_count='$INV_LINE_COUNT'"
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
  printf '%s✓ All %s checks passed. Trip sheet -> Proforma PDF is working correctly.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
  echo
  echo "Tenant A owner: $OWNER_A_EMAIL"
  echo "Tenant B owner: $OWNER_B_EMAIL"
  exit 0
fi
