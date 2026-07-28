#!/usr/bin/env bash
#
# End-to-end verification of Task 4.5 PDF rendering: Yellow (LOCAL tax),
# Blue (OUTSTATION tax), Performance, and credit-note PDFs. Mirrors
# scripts/verify-invoice-lifecycle.sh's structure/conventions.
#
# Rule 11: we assert that a PDF WAS GENERATED (200 response, pdf_url
# set, file exists on disk with nonzero size, GET returns
# application/pdf bytes whose length matches pdf_file_size_bytes) — we
# do NOT assert specific byte content, since that's a Chromium-version
# concern, not application logic.
#
# Task 4.7 adds the Proforma split (Performance -> Proforma Local /
# Proforma Outstation) and the B2C GSTIN-hiding conditional. Those DO
# assert specific text content via pdftotext, deliberately narrower
# than Rule 11's byte-content exemption above — the whole point of
# these checks is that a specific string (a column header, a
# disclaimer, a GSTIN row) is present or absent, which byte-length
# alone can never catch. Automation here is necessary, not sufficient:
# per Rule 13, the actual acceptance gate is the visual review against
# fixtures/reference-pdfs/PTT-150/151/152.pdf, not these checks alone.
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
OWNER_A_EMAIL="verify-pdf-owner-a-$(date +%s)@example.com"
OWNER_B_EMAIL="verify-pdf-owner-b-$(date +%s)-2@example.com"

# Rule 8: all trip dates computed as offsets BACK from today.
days_ago() { date -v-"$1"d +%Y-%m-%d; }
DAYS_AGO_3=$(days_ago 3)
DAYS_AGO_5=$(days_ago 5)
DAYS_AGO_8=$(days_ago 8)

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

GREEN=$'\033[32m'
RED=$'\033[31m'
RESET=$'\033[0m'

PASS=0
FAIL=0
TOTAL_CHECKS=34
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
  printf '%spdftotext is required for Task 4.7'\''s content assertions.\nInstall it with: brew install poppler%s\n' "$RED" "$RESET"
  exit 1
fi
echo "  pdftotext is installed"
echo

# ─── SETUP ───
SIGNUP_A=$(curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Pravasi Tours\",\"email\":\"$OWNER_A_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner A\"}")
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

# Task 4.8 added tagline/phone/jurisdiction to tenants and pan to
# bank_details — previously PATCH /settings/business had no columns to
# accept them at all (same gap verify-invoice-lifecycle.sh flagged).
# Set here so the Step-31/32/33 PDFs below have real content to render
# and visually review (Rule 14).
curl -s -X PATCH "$BASE_URL/settings/business" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"state_code":"KA","gstin":"29ABCDE1234F1Z5","pan":"ABCDE1234F","tagline":"Car Rental & Outstation Cab Services","phone":"+91-80-1234-5678","jurisdiction":"Bangalore","bank_details":{"account_name":"Pravasi Tours","account_number":"12345678","ifsc":"HDFC0000123","bank_name":"HDFC Bank","branch":"MG Road","pan":"BQSPR7829H"}}' > /dev/null

SIGNUP_B=$(curl -s -X POST "$BASE_URL/auth/signup" -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify PDF Co B\",\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Owner B\"}")
if [ "$(echo "$SIGNUP_B" | jq -r '.tenant.id // empty')" = "" ]; then
  printf '%sSetup signup (tenant B) failed:%s\n' "$RED" "$RESET"
  exit 1
fi
OWNER_B_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_B_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" | jq -r '.accessToken // empty')

VEH_SEDAN=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA01PF1111","vehicle_type":"SEDAN","make_model":"Honda City"}' | jq -r '.vehicle.id // empty')
VEH_KIA=$(curl -s -X POST "$BASE_URL/vehicles" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicle_number":"KA01PF2222","vehicle_type":"KIA_CARNIVAL","make_model":"KIA Carnival","seating_capacity":7}' | jq -r '.vehicle.id // empty')

CUST_LOCAL=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"Acme Logistics","gstin":"29XXXXX1234A1Z6","credit_days":15,"phone":"9876500001","email":"ap@acme.com","address":{"line1":"12 MG Road","city":"Bengaluru","state":"Karnataka","pincode":"560001"}}' \
  | jq -r '.customer.id // empty')
CUST_OUTSTATION=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2B","company_name":"Mumbai Freight Co","gstin":"27XXXXX5678B1Z7","credit_days":30,"address":{"line1":"5 Marine Drive","city":"Mumbai","state":"Maharashtra","pincode":"400001"}}' \
  | jq -r '.customer.id // empty')
# Task 4.7: B2C customer — no gstin, no company_name, no state. Used to
# prove the Bill-To GSTIN/State row is hidden (bill-to.hbs switches on
# customer.gstin presence, not customer_type — ADR-014).
CUST_B2C=$(curl -s -X POST "$BASE_URL/customers" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"customer_type":"B2C","name":"Ravi Kumar","phone":"9876500099"}' \
  | jq -r '.customer.id // empty')

RULE_LOCAL_SEDAN=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"LOCAL_PACKAGE","vehicle_type":"SEDAN","label":"SEDAN 8H/80KM","base_hours":8,"base_km":80,"base_price_rupees":2200,"extra_km_rate_rupees":14,"extra_hr_rate_rupees":180,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')
RULE_OUTSTATION_KIA=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"OUTSTATION_SLAB","vehicle_type":"KIA_CARNIVAL","label":"KIA Cauvery Slab","slab_rate_rupees":50,"min_km_per_day":250,"driver_batta_per_day_rupees":960,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')
RULE_PERF_SEDAN=$(curl -s -X POST "$BASE_URL/pricing/rules" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"rule_type":"PERFORMANCE","vehicle_type":"SEDAN","label":"SEDAN Perf","per_km_rate_rupees":14,"performance_batta_rupees":300,"effective_from":"2026-01-01"}' | jq -r '.rule.id // empty')

if [ -z "$VEH_SEDAN" ] || [ -z "$VEH_KIA" ] || [ -z "$CUST_LOCAL" ] || [ -z "$CUST_OUTSTATION" ] || [ -z "$CUST_B2C" ] || \
   [ -z "$RULE_LOCAL_SEDAN" ] || [ -z "$RULE_OUTSTATION_KIA" ] || [ -z "$RULE_PERF_SEDAN" ]; then
  printf '%sSetup did not yield all required fixtures. Aborting.%s\n' "$RED" "$RESET"
  echo "VEH_SEDAN=$VEH_SEDAN VEH_KIA=$VEH_KIA CUST_LOCAL=$CUST_LOCAL CUST_OUTSTATION=$CUST_OUTSTATION CUST_B2C=$CUST_B2C"
  exit 1
fi

new_trip() {
  # $1=service_type $2=billing_mode $3=customer $4=vehicle $5=date $6=km $7=hours $8=extra_json(optional)
  local extra="${8:-}"
  curl -s -X POST "$BASE_URL/trips" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
    -d "{\"service_type\":\"$1\",\"billing_mode\":\"$2\",\"customer_id\":\"$3\",\"vehicle_id\":\"$4\",\"trip_date\":\"$5\",\"total_km\":$6,\"total_hours\":$7${extra}}" \
    | jq -r '.trip.id // empty'
}
finalize_trip() { curl -s -X POST "$BASE_URL/trips/$1/finalize" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null; }

T_LOCAL=$(new_trip LOCAL GST "$CUST_LOCAL" "$VEH_SEDAN" "$DAYS_AGO_5" 217 12)
T_OUTSTATION=$(new_trip OUTSTATION GST "$CUST_OUTSTATION" "$VEH_KIA" "$DAYS_AGO_8" 1200 0 ',"total_days":4,"fasttag_rupees":540')
T_PERF=$(new_trip LOCAL PERFORMANCE "$CUST_LOCAL" "$VEH_SEDAN" "$DAYS_AGO_3" 300 8)
# Two extra, otherwise-unused trips: one stays on a DRAFT invoice
# (Step 7), one backs an ISSUED invoice that never gets a PDF
# generated (Step 8) — createInvoiceSchema requires trip_sheet_ids to
# have at least one entry, so neither test can use an empty array.
T_DRAFT_ONLY=$(new_trip LOCAL GST "$CUST_LOCAL" "$VEH_SEDAN" "$DAYS_AGO_5" 90 8)
T_UNGENERATED=$(new_trip LOCAL GST "$CUST_LOCAL" "$VEH_SEDAN" "$DAYS_AGO_5" 95 8)

# Task 4.7 fixtures — B2C tax invoices (GSTIN-hiding check) and the new
# Proforma templates. GST billing_mode (not PERFORMANCE) on purpose: a
# Proforma invoice is a preview of what would become a real TAX
# invoice, so it needs the same LOCAL_PACKAGE/OUTSTATION_SLAB pricing
# data (base package + extra KM/Hrs, or slab + batta) that PTT-152's
# layout expects — a genuinely flat-rate PERFORMANCE-billing_mode trip
# has no "package" to break down (see known-issues.md).
T_LOCAL_B2C=$(new_trip LOCAL GST "$CUST_B2C" "$VEH_SEDAN" "$DAYS_AGO_5" 217 12)
T_OUTSTATION_B2C=$(new_trip OUTSTATION GST "$CUST_B2C" "$VEH_KIA" "$DAYS_AGO_8" 1200 0 ',"total_days":4')
T_PROFORMA_LOCAL_B2B=$(new_trip LOCAL GST "$CUST_LOCAL" "$VEH_SEDAN" "$DAYS_AGO_5" 217 12)
T_PROFORMA_LOCAL_B2C=$(new_trip LOCAL GST "$CUST_B2C" "$VEH_SEDAN" "$DAYS_AGO_5" 217 12)
T_PROFORMA_OUT_B2B=$(new_trip OUTSTATION GST "$CUST_OUTSTATION" "$VEH_KIA" "$DAYS_AGO_8" 1200 0 ',"total_days":4')
T_PROFORMA_OUT_B2C=$(new_trip OUTSTATION GST "$CUST_B2C" "$VEH_KIA" "$DAYS_AGO_8" 1200 0 ',"total_days":4')

# Task 4.8 fixtures — reverse_charge=true/false/omitted on TAX invoices,
# and reverse_charge=true on a Proforma (to confirm hideTenantTaxInfo
# still hides it there, same gate as Place of Supply).
T_RC_TRUE=$(new_trip LOCAL GST "$CUST_LOCAL" "$VEH_SEDAN" "$DAYS_AGO_5" 90 8)
T_RC_FALSE=$(new_trip LOCAL GST "$CUST_LOCAL" "$VEH_SEDAN" "$DAYS_AGO_5" 90 8)
T_RC_NULL=$(new_trip LOCAL GST "$CUST_LOCAL" "$VEH_SEDAN" "$DAYS_AGO_5" 90 8)
T_RC_PROFORMA=$(new_trip LOCAL GST "$CUST_LOCAL" "$VEH_SEDAN" "$DAYS_AGO_5" 217 12)

if [ -z "$T_LOCAL" ] || [ -z "$T_OUTSTATION" ] || [ -z "$T_PERF" ] || [ -z "$T_DRAFT_ONLY" ] || [ -z "$T_UNGENERATED" ] || \
   [ -z "$T_LOCAL_B2C" ] || [ -z "$T_OUTSTATION_B2C" ] || [ -z "$T_PROFORMA_LOCAL_B2B" ] || [ -z "$T_PROFORMA_LOCAL_B2C" ] || \
   [ -z "$T_PROFORMA_OUT_B2B" ] || [ -z "$T_PROFORMA_OUT_B2C" ] || \
   [ -z "$T_RC_TRUE" ] || [ -z "$T_RC_FALSE" ] || [ -z "$T_RC_NULL" ] || [ -z "$T_RC_PROFORMA" ]; then
  printf '%sSetup did not create all core trips. Aborting.%s\n' "$RED" "$RESET"
  echo "T_LOCAL=$T_LOCAL T_OUTSTATION=$T_OUTSTATION T_PERF=$T_PERF T_DRAFT_ONLY=$T_DRAFT_ONLY T_UNGENERATED=$T_UNGENERATED"
  echo "T_LOCAL_B2C=$T_LOCAL_B2C T_OUTSTATION_B2C=$T_OUTSTATION_B2C T_PROFORMA_LOCAL_B2B=$T_PROFORMA_LOCAL_B2B T_PROFORMA_LOCAL_B2C=$T_PROFORMA_LOCAL_B2C T_PROFORMA_OUT_B2B=$T_PROFORMA_OUT_B2B T_PROFORMA_OUT_B2C=$T_PROFORMA_OUT_B2C"
  echo "T_RC_TRUE=$T_RC_TRUE T_RC_FALSE=$T_RC_FALSE T_RC_NULL=$T_RC_NULL T_RC_PROFORMA=$T_RC_PROFORMA"
  exit 1
fi
finalize_trip "$T_LOCAL"
finalize_trip "$T_OUTSTATION"
finalize_trip "$T_PERF"
finalize_trip "$T_DRAFT_ONLY"
finalize_trip "$T_UNGENERATED"
finalize_trip "$T_LOCAL_B2C"
finalize_trip "$T_OUTSTATION_B2C"
finalize_trip "$T_PROFORMA_LOCAL_B2B"
finalize_trip "$T_PROFORMA_LOCAL_B2C"
finalize_trip "$T_PROFORMA_OUT_B2B"
finalize_trip "$T_PROFORMA_OUT_B2C"
finalize_trip "$T_RC_TRUE"
finalize_trip "$T_RC_FALSE"
finalize_trip "$T_RC_NULL"
finalize_trip "$T_RC_PROFORMA"

echo "Setup: tenant A (Pravasi Tours, business profile set), tenant B, SEDAN+KIA vehicles, 2 customers, 3 pricing rules, 3 FINALIZED trips"
echo

echo "Checks"
echo "------"

# ─── Step 1: create + issue LOCAL tax invoice (Yellow) ───
INV_LOCAL_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_LOCAL\",\"trip_sheet_ids\":[\"$T_LOCAL\"]}")
INV_LOCAL=$(echo "$INV_LOCAL_RESP" | jq -r '.invoice.id // empty')
curl -s -X POST "$BASE_URL/invoices/$INV_LOCAL/issue" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null

if [ -n "$INV_LOCAL" ]; then
  pass "Setup: LOCAL tax invoice created + issued"
else
  fail "Create+issue LOCAL invoice" "no invoice id returned"
fi

# ─── Step 2: generate PDF for LOCAL invoice (Yellow template) ───
GEN_LOCAL=$(curl -s -o "$WORK_DIR/gen_local.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_LOCAL/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN")
GEN_LOCAL_URL=$(jq -r '.pdf_url // empty' "$WORK_DIR/gen_local.json")
GEN_LOCAL_SIZE=$(jq -r '.pdf_file_size_bytes // 0' "$WORK_DIR/gen_local.json")
GEN_LOCAL_VERSION=$(jq -r '.pdf_template_version // empty' "$WORK_DIR/gen_local.json")

if [ "$GEN_LOCAL" = "200" ] && [ -n "$GEN_LOCAL_URL" ] && [ "$GEN_LOCAL_SIZE" -gt "0" ] && [ -n "$GEN_LOCAL_VERSION" ]; then
  pass "POST /invoices/:id/pdf generates Yellow (LOCAL tax) PDF: 200, pdf_url + nonzero size + template version set"
else
  fail "Generate LOCAL invoice PDF (Step 2)" "status=$GEN_LOCAL url=$GEN_LOCAL_URL size=$GEN_LOCAL_SIZE version=$GEN_LOCAL_VERSION"
fi

# ─── Step 3: file actually exists on disk with matching size ───
LOCAL_FILE_PATH="pdf-storage/${GEN_LOCAL_URL#/pdf-storage/}"
if [ -f "$LOCAL_FILE_PATH" ]; then
  ACTUAL_SIZE=$(wc -c < "$LOCAL_FILE_PATH" | tr -d ' ')
  if [ "$ACTUAL_SIZE" = "$GEN_LOCAL_SIZE" ]; then
    pass "PDF file exists on disk at $LOCAL_FILE_PATH, size matches pdf_file_size_bytes ($ACTUAL_SIZE bytes)"
  else
    fail "LOCAL PDF file size on disk" "disk=$ACTUAL_SIZE db=$GEN_LOCAL_SIZE"
  fi
else
  fail "LOCAL PDF file exists on disk" "not found at $LOCAL_FILE_PATH"
fi

# ─── Step 4: GET the PDF back — correct content-type + byte length ───
GET_LOCAL_STATUS=$(curl -s -o "$WORK_DIR/local.pdf" -D "$WORK_DIR/local_headers.txt" -w '%{http_code}' \
  "$BASE_URL/invoices/$INV_LOCAL/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN")
GET_LOCAL_CONTENT_TYPE=$(grep -i '^content-type:' "$WORK_DIR/local_headers.txt" | tr -d '\r' | cut -d' ' -f2-)
GET_LOCAL_SIZE=$(wc -c < "$WORK_DIR/local.pdf" | tr -d ' ')
GET_LOCAL_MAGIC=$(head -c4 "$WORK_DIR/local.pdf")

if [ "$GET_LOCAL_STATUS" = "200" ] && [ "$GET_LOCAL_CONTENT_TYPE" = "application/pdf" ] && \
   [ "$GET_LOCAL_SIZE" = "$GEN_LOCAL_SIZE" ] && [ "$GET_LOCAL_MAGIC" = "%PDF" ]; then
  pass "GET /invoices/:id/pdf streams a real PDF: application/pdf, %PDF magic bytes, length matches"
else
  fail "GET LOCAL invoice PDF (Step 4)" "status=$GET_LOCAL_STATUS type=$GET_LOCAL_CONTENT_TYPE size=$GET_LOCAL_SIZE magic=$GET_LOCAL_MAGIC"
fi

# ─── Step 5: create + issue OUTSTATION tax invoice (Blue) ───
INV_OUTSTATION_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_OUTSTATION\",\"trip_sheet_ids\":[\"$T_OUTSTATION\"]}")
INV_OUTSTATION=$(echo "$INV_OUTSTATION_RESP" | jq -r '.invoice.id // empty')
curl -s -X POST "$BASE_URL/invoices/$INV_OUTSTATION/issue" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null

GEN_OUT=$(curl -s -o "$WORK_DIR/gen_out.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_OUTSTATION/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN")
GEN_OUT_SIZE=$(jq -r '.pdf_file_size_bytes // 0' "$WORK_DIR/gen_out.json")

if [ -n "$INV_OUTSTATION" ] && [ "$GEN_OUT" = "200" ] && [ "$GEN_OUT_SIZE" -gt "0" ]; then
  pass "POST /invoices/:id/pdf generates Blue (OUTSTATION tax) PDF: 200, nonzero size"
else
  fail "Generate OUTSTATION invoice PDF (Step 5)" "invoice=$INV_OUTSTATION status=$GEN_OUT size=$GEN_OUT_SIZE"
fi

# ─── Step 6: create + issue PERFORMANCE invoice ───
INV_PERF_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"PERFORMANCE\",\"customer_id\":\"$CUST_LOCAL\",\"trip_sheet_ids\":[\"$T_PERF\"]}")
INV_PERF=$(echo "$INV_PERF_RESP" | jq -r '.invoice.id // empty')
curl -s -X POST "$BASE_URL/invoices/$INV_PERF/issue" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null

GEN_PERF=$(curl -s -o "$WORK_DIR/gen_perf.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_PERF/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN")
GEN_PERF_SIZE=$(jq -r '.pdf_file_size_bytes // 0' "$WORK_DIR/gen_perf.json")

if [ -n "$INV_PERF" ] && [ "$GEN_PERF" = "200" ] && [ "$GEN_PERF_SIZE" -gt "0" ]; then
  pass "POST /invoices/:id/pdf generates Performance invoice PDF: 200, nonzero size"
else
  fail "Generate PERFORMANCE invoice PDF (Step 6)" "invoice=$INV_PERF status=$GEN_PERF size=$GEN_PERF_SIZE"
fi

# ─── Step 7: PDF cannot be generated for a DRAFT invoice ───
DRAFT_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_LOCAL\",\"trip_sheet_ids\":[\"$T_DRAFT_ONLY\"]}")
INV_DRAFT=$(echo "$DRAFT_RESP" | jq -r '.invoice.id // empty')
STEP7_STATUS=$(curl -s -o "$WORK_DIR/step7.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_DRAFT/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP7_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step7.json")

if [ "$STEP7_STATUS" = "400" ] && [ "$STEP7_CODE" = "INVOICE_NOT_ISSUED" ]; then
  pass "PDF generation rejected for a DRAFT invoice: 400 INVOICE_NOT_ISSUED"
else
  fail "DRAFT invoice PDF rejection (Step 7)" "status=$STEP7_STATUS code=$STEP7_CODE"
fi

# ─── Step 8: GET pdf before generation -> 404 PDF_NOT_GENERATED ───
UNGEN_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_LOCAL\",\"trip_sheet_ids\":[\"$T_UNGENERATED\"]}")
INV_UNGEN=$(echo "$UNGEN_RESP" | jq -r '.invoice.id // empty')
curl -s -X POST "$BASE_URL/invoices/$INV_UNGEN/issue" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
STEP8_STATUS=$(curl -s -o "$WORK_DIR/step8.json" -w '%{http_code}' "$BASE_URL/invoices/$INV_UNGEN/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN")
STEP8_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/step8.json")

if [ "$STEP8_STATUS" = "404" ] && [ "$STEP8_CODE" = "PDF_NOT_GENERATED" ]; then
  pass "GET pdf before generation: 404 PDF_NOT_GENERATED"
else
  fail "GET ungenerated PDF (Step 8)" "status=$STEP8_STATUS code=$STEP8_CODE"
fi

# ─── Step 9: regenerating overwrites the same file (idempotent) ───
GEN_LOCAL_2=$(curl -s -o "$WORK_DIR/gen_local_2.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_LOCAL/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN")
GEN_LOCAL_2_URL=$(jq -r '.pdf_url // empty' "$WORK_DIR/gen_local_2.json")

if [ "$GEN_LOCAL_2" = "200" ] && [ "$GEN_LOCAL_2_URL" = "$GEN_LOCAL_URL" ]; then
  pass "Regenerating an already-generated PDF is idempotent: 200, same pdf_url"
else
  fail "Regenerate PDF idempotency (Step 9)" "status=$GEN_LOCAL_2 url=$GEN_LOCAL_2_URL expected=$GEN_LOCAL_URL"
fi

# ─── Step 10: cross-tenant isolation — tenant B cannot generate/read tenant A's invoice PDF ───
STEP10A_STATUS=$(curl -s -o "$WORK_DIR/step10a.json" -w '%{http_code}' -X POST "$BASE_URL/invoices/$INV_LOCAL/pdf" -H "Authorization: Bearer $OWNER_B_TOKEN")
STEP10B_STATUS=$(curl -s -o "$WORK_DIR/step10b.json" -w '%{http_code}' "$BASE_URL/invoices/$INV_LOCAL/pdf" -H "Authorization: Bearer $OWNER_B_TOKEN")

if [ "$STEP10A_STATUS" = "404" ] && [ "$STEP10B_STATUS" = "404" ]; then
  pass "Cross-tenant isolation: tenant B gets 404 generating/reading tenant A's invoice PDF"
else
  fail "Cross-tenant PDF isolation (Step 10)" "generate=$STEP10A_STATUS read=$STEP10B_STATUS"
fi

# ─── Step 11: unauthenticated request is rejected ───
STEP11_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/invoices/$INV_LOCAL/pdf")
if [ "$STEP11_STATUS" = "401" ]; then
  pass "Unauthenticated PDF request rejected: 401"
else
  fail "Unauthenticated PDF request (Step 11)" "status=$STEP11_STATUS"
fi

# ─── Step 12: cancel the OUTSTATION invoice -> credit note -> generate its PDF ───
CANCEL_RESP=$(curl -s -X POST "$BASE_URL/invoices/$INV_OUTSTATION/cancel" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"Customer requested cancellation for Task 4.5 PDF verification"}')
CREDIT_NOTE_ID=$(echo "$CANCEL_RESP" | jq -r '.credit_note.id // empty')

if [ -n "$CREDIT_NOTE_ID" ]; then
  pass "Cancelling the issued OUTSTATION invoice creates a credit note"
else
  fail "Cancel invoice -> credit note (Step 12)" "response=$CANCEL_RESP"
fi

GEN_CN=$(curl -s -o "$WORK_DIR/gen_cn.json" -w '%{http_code}' -X POST "$BASE_URL/credit-notes/$CREDIT_NOTE_ID/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN")
GEN_CN_URL=$(jq -r '.pdf_url // empty' "$WORK_DIR/gen_cn.json")
GEN_CN_SIZE=$(jq -r '.pdf_file_size_bytes // 0' "$WORK_DIR/gen_cn.json")

if [ "$GEN_CN" = "200" ] && [ -n "$GEN_CN_URL" ] && [ "$GEN_CN_SIZE" -gt "0" ]; then
  pass "POST /credit-notes/:id/pdf generates a credit-note PDF: 200, nonzero size"
else
  fail "Generate credit-note PDF (Step 13)" "status=$GEN_CN url=$GEN_CN_URL size=$GEN_CN_SIZE"
fi

CN_FILE_PATH="pdf-storage/${GEN_CN_URL#/pdf-storage/}"
if [ -f "$CN_FILE_PATH" ]; then
  CN_ACTUAL_SIZE=$(wc -c < "$CN_FILE_PATH" | tr -d ' ')
  if [ "$CN_ACTUAL_SIZE" = "$GEN_CN_SIZE" ]; then
    pass "Credit-note PDF file exists on disk, size matches pdf_file_size_bytes ($CN_ACTUAL_SIZE bytes)"
  else
    fail "Credit-note PDF file size on disk" "disk=$CN_ACTUAL_SIZE db=$GEN_CN_SIZE"
  fi
else
  fail "Credit-note PDF file exists on disk" "not found at $CN_FILE_PATH"
fi

GET_CN_STATUS=$(curl -s -o "$WORK_DIR/cn.pdf" -D "$WORK_DIR/cn_headers.txt" -w '%{http_code}' \
  "$BASE_URL/credit-notes/$CREDIT_NOTE_ID/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN")
GET_CN_CONTENT_TYPE=$(grep -i '^content-type:' "$WORK_DIR/cn_headers.txt" | tr -d '\r' | cut -d' ' -f2-)
GET_CN_MAGIC=$(head -c4 "$WORK_DIR/cn.pdf")

if [ "$GET_CN_STATUS" = "200" ] && [ "$GET_CN_CONTENT_TYPE" = "application/pdf" ] && [ "$GET_CN_MAGIC" = "%PDF" ]; then
  pass "GET /credit-notes/:id/pdf streams a real PDF: application/pdf, %PDF magic bytes"
else
  fail "GET credit-note PDF" "status=$GET_CN_STATUS type=$GET_CN_CONTENT_TYPE magic=$GET_CN_MAGIC"
fi

# ─── Step 14: nonexistent credit note -> 404 ───
# A syntactically valid v4 UUID (correct version/variant nibbles) that
# just doesn't exist — an all-zeros UUID would fail Joi's uuidv4 format
# check itself (400), which isn't what this step is testing.
STEP14_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/credit-notes/123e4567-e89b-42d3-a456-426614174000/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN")
if [ "$STEP14_STATUS" = "404" ]; then
  pass "Generating a PDF for a nonexistent credit note: 404"
else
  fail "Nonexistent credit note PDF (Step 14)" "status=$STEP14_STATUS"
fi

# ─── Step 15: pdf_generated_at is populated and updates on regeneration ───
GEN1_AT=$(jq -r '.pdf_generated_at // empty' "$WORK_DIR/gen_local.json")
GEN2_AT=$(jq -r '.pdf_generated_at // empty' "$WORK_DIR/gen_local_2.json")
if [ -n "$GEN1_AT" ] && [ -n "$GEN2_AT" ]; then
  pass "pdf_generated_at populated on every generation ($GEN1_AT, $GEN2_AT)"
else
  fail "pdf_generated_at populated (Step 15)" "first=$GEN1_AT second=$GEN2_AT"
fi

# ─── Step 16: invoice_number appears in the downloaded filename ───
LOCAL_INVOICE_NUMBER=$(curl -s "$BASE_URL/invoices/$INV_LOCAL" -H "Authorization: Bearer $OWNER_A_TOKEN" | jq -r '.invoice.invoice_number')
CONTENT_DISPOSITION=$(grep -i '^content-disposition:' "$WORK_DIR/local_headers.txt" | tr -d '\r')
EXPECTED_FRAGMENT=$(echo "$LOCAL_INVOICE_NUMBER" | tr '/' '-')

if echo "$CONTENT_DISPOSITION" | grep -q "$EXPECTED_FRAGMENT"; then
  pass "Downloaded filename derives from invoice_number ($LOCAL_INVOICE_NUMBER -> $EXPECTED_FRAGMENT)"
else
  fail "Filename derivation (Step 16)" "disposition='$CONTENT_DISPOSITION' expected fragment='$EXPECTED_FRAGMENT'"
fi

# ─── Task 4.7: Proforma split + B2C conditional + visual parity ───

# Isolates the "Bill To" block's own text so a GSTIN assertion can't
# be confused by the TENANT's own GSTIN line in the header — a TAX
# invoice always shows the issuer's GSTIN regardless of B2B/B2C (GST
# law requires it); only the RECIPIENT's GSTIN row is conditional.
bill_to_text() {
  pdftotext -layout "$1" - | sed -n '/BILL TO/,/SERVICE DETAILS/p'
}

# ─── Step 17: TAX LOCAL invoice for a B2C customer hides recipient GSTIN ───
INV_LOCAL_B2C_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_B2C\",\"trip_sheet_ids\":[\"$T_LOCAL_B2C\"]}")
INV_LOCAL_B2C=$(echo "$INV_LOCAL_B2C_RESP" | jq -r '.invoice.id // empty')
curl -s -X POST "$BASE_URL/invoices/$INV_LOCAL_B2C/issue" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/invoices/$INV_LOCAL_B2C/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s "$BASE_URL/invoices/$INV_LOCAL_B2C/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" -o "$WORK_DIR/tax_local_b2c.pdf"

if [ -n "$INV_LOCAL_B2C" ] && ! bill_to_text "$WORK_DIR/tax_local_b2c.pdf" | grep -q "GSTIN:"; then
  pass "TAX LOCAL invoice (B2C customer) hides the recipient GSTIN/State row"
else
  fail "TAX LOCAL B2C GSTIN hiding (Step 17)" "invoice=$INV_LOCAL_B2C bill-to text: $(bill_to_text "$WORK_DIR/tax_local_b2c.pdf" | tr '\n' ' ')"
fi

# ─── Step 18: TAX OUTSTATION invoice for a B2C customer hides recipient GSTIN ───
INV_OUT_B2C_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_B2C\",\"trip_sheet_ids\":[\"$T_OUTSTATION_B2C\"]}")
INV_OUT_B2C=$(echo "$INV_OUT_B2C_RESP" | jq -r '.invoice.id // empty')
curl -s -X POST "$BASE_URL/invoices/$INV_OUT_B2C/issue" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/invoices/$INV_OUT_B2C/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s "$BASE_URL/invoices/$INV_OUT_B2C/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" -o "$WORK_DIR/tax_out_b2c.pdf"

if [ -n "$INV_OUT_B2C" ] && ! bill_to_text "$WORK_DIR/tax_out_b2c.pdf" | grep -q "GSTIN:"; then
  pass "TAX OUTSTATION invoice (B2C customer) hides the recipient GSTIN/State row"
else
  fail "TAX OUTSTATION B2C GSTIN hiding (Step 18)" "invoice=$INV_OUT_B2C bill-to text: $(bill_to_text "$WORK_DIR/tax_out_b2c.pdf" | tr '\n' ' ')"
fi

# ─── Step 19: Proforma LOCAL invoice (B2B) — PTT-152 layout ───
INV_PROFORMA_LOCAL_B2B_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"PERFORMANCE\",\"customer_id\":\"$CUST_LOCAL\",\"trip_sheet_ids\":[\"$T_PROFORMA_LOCAL_B2B\"]}")
INV_PROFORMA_LOCAL_B2B=$(echo "$INV_PROFORMA_LOCAL_B2B_RESP" | jq -r '.invoice.id // empty')
curl -s -X POST "$BASE_URL/invoices/$INV_PROFORMA_LOCAL_B2B/issue" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/invoices/$INV_PROFORMA_LOCAL_B2B/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s "$BASE_URL/invoices/$INV_PROFORMA_LOCAL_B2B/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" -o "$WORK_DIR/proforma_local_b2b.pdf"
PROFORMA_LOCAL_B2B_TEXT=$(pdftotext -layout "$WORK_DIR/proforma_local_b2b.pdf" - 2>/dev/null)

if [ -n "$INV_PROFORMA_LOCAL_B2B" ] && echo "$PROFORMA_LOCAL_B2B_TEXT" | grep -q "PROFORMA INVOICE"; then
  pass "Proforma LOCAL invoice renders with a PROFORMA INVOICE header"
else
  fail "Proforma LOCAL header (Step 19a)" "invoice=$INV_PROFORMA_LOCAL_B2B"
fi

if echo "$PROFORMA_LOCAL_B2B_TEXT" | grep -q "8Hrs/80Km"; then
  pass "Proforma LOCAL invoice shows the 8Hrs/80Km package column (PTT-152 layout)"
else
  fail "Proforma LOCAL 8Hrs/80Km column (Step 19b)" "text did not contain '8Hrs/80Km'"
fi

if ! echo "$PROFORMA_LOCAL_B2B_TEXT" | grep -qE "CGST|SGST|Taxable Value"; then
  pass "Proforma LOCAL invoice omits CGST/SGST/Taxable Value (not a tax document)"
else
  fail "Proforma LOCAL GST-free (Step 19c)" "text unexpectedly contained CGST/SGST/Taxable Value"
fi

if echo "$PROFORMA_LOCAL_B2B_TEXT" | grep -q "This is a Proforma Invoice and not a demand for payment"; then
  pass "Proforma LOCAL invoice shows the Proforma disclaimer footer"
else
  fail "Proforma LOCAL disclaimer (Step 19d)" "disclaimer text not found"
fi

# ─── Step 20: Proforma OUTSTATION invoice (B2B) ───
INV_PROFORMA_OUT_B2B_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"PERFORMANCE\",\"customer_id\":\"$CUST_OUTSTATION\",\"trip_sheet_ids\":[\"$T_PROFORMA_OUT_B2B\"]}")
INV_PROFORMA_OUT_B2B=$(echo "$INV_PROFORMA_OUT_B2B_RESP" | jq -r '.invoice.id // empty')
curl -s -X POST "$BASE_URL/invoices/$INV_PROFORMA_OUT_B2B/issue" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/invoices/$INV_PROFORMA_OUT_B2B/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s "$BASE_URL/invoices/$INV_PROFORMA_OUT_B2B/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" -o "$WORK_DIR/proforma_out_b2b.pdf"
PROFORMA_OUT_B2B_TEXT=$(pdftotext -layout "$WORK_DIR/proforma_out_b2b.pdf" - 2>/dev/null)

if [ -n "$INV_PROFORMA_OUT_B2B" ] && echo "$PROFORMA_OUT_B2B_TEXT" | grep -q "PROFORMA INVOICE"; then
  pass "Proforma OUTSTATION invoice renders with a PROFORMA INVOICE header"
else
  fail "Proforma OUTSTATION header (Step 20a)" "invoice=$INV_PROFORMA_OUT_B2B"
fi

if echo "$PROFORMA_OUT_B2B_TEXT" | grep -q "Running" && echo "$PROFORMA_OUT_B2B_TEXT" | grep -q "Driver" && echo "$PROFORMA_OUT_B2B_TEXT" | grep -q "Bata"; then
  pass "Proforma OUTSTATION invoice shows Running Cost and Driver Bata columns (tax-outstation column parity)"
else
  fail "Proforma OUTSTATION column parity (Step 20b)" "Running/Driver/Bata not all found in text"
fi

if ! echo "$PROFORMA_OUT_B2B_TEXT" | grep -qE "CGST|SGST"; then
  pass "Proforma OUTSTATION invoice omits CGST/SGST (not a tax document)"
else
  fail "Proforma OUTSTATION GST-free (Step 20c)" "text unexpectedly contained CGST/SGST"
fi

# ─── Step 21/22: Proforma invoices (B2C) hide GSTIN entirely — tenant's
# own GSTIN is ALSO hidden on Proforma docs (hideTenantTaxInfo, Part B),
# so unlike the TAX checks above this can assert over the WHOLE document. ───
INV_PROFORMA_LOCAL_B2C_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"PERFORMANCE\",\"customer_id\":\"$CUST_B2C\",\"trip_sheet_ids\":[\"$T_PROFORMA_LOCAL_B2C\"]}")
INV_PROFORMA_LOCAL_B2C=$(echo "$INV_PROFORMA_LOCAL_B2C_RESP" | jq -r '.invoice.id // empty')
curl -s -X POST "$BASE_URL/invoices/$INV_PROFORMA_LOCAL_B2C/issue" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/invoices/$INV_PROFORMA_LOCAL_B2C/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s "$BASE_URL/invoices/$INV_PROFORMA_LOCAL_B2C/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" -o "$WORK_DIR/proforma_local_b2c.pdf"

if [ -n "$INV_PROFORMA_LOCAL_B2C" ] && ! pdftotext -layout "$WORK_DIR/proforma_local_b2c.pdf" - 2>/dev/null | grep -q "GSTIN:"; then
  pass "Proforma LOCAL invoice (B2C customer) contains no GSTIN anywhere (tenant's own is also hidden on Proforma docs)"
else
  fail "Proforma LOCAL B2C GSTIN-free (Step 21)" "invoice=$INV_PROFORMA_LOCAL_B2C"
fi

INV_PROFORMA_OUT_B2C_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"PERFORMANCE\",\"customer_id\":\"$CUST_B2C\",\"trip_sheet_ids\":[\"$T_PROFORMA_OUT_B2C\"]}")
INV_PROFORMA_OUT_B2C=$(echo "$INV_PROFORMA_OUT_B2C_RESP" | jq -r '.invoice.id // empty')
curl -s -X POST "$BASE_URL/invoices/$INV_PROFORMA_OUT_B2C/issue" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/invoices/$INV_PROFORMA_OUT_B2C/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s "$BASE_URL/invoices/$INV_PROFORMA_OUT_B2C/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" -o "$WORK_DIR/proforma_out_b2c.pdf"

if [ -n "$INV_PROFORMA_OUT_B2C" ] && ! pdftotext -layout "$WORK_DIR/proforma_out_b2c.pdf" - 2>/dev/null | grep -q "GSTIN:"; then
  pass "Proforma OUTSTATION invoice (B2C customer) contains no GSTIN anywhere"
else
  fail "Proforma OUTSTATION B2C GSTIN-free (Step 22)" "invoice=$INV_PROFORMA_OUT_B2C"
fi

# ─── Task 4.8: tagline/phone/jurisdiction/bank-PAN + reverse_charge ───

# Step 23: the Yellow (LOCAL tax) PDF generated back in Step 2 already
# carries the tenant's tagline/phone/jurisdiction/bank_details.pan set
# in this script's own SETUP block — assert all four actually render.
LOCAL_FULL_TEXT=$(pdftotext -layout "$WORK_DIR/local.pdf" - 2>/dev/null)
STEP23_REASONS=()
echo "$LOCAL_FULL_TEXT" | grep -q "Car Rental & Outstation Cab Services" || STEP23_REASONS+=("tagline missing")
echo "$LOCAL_FULL_TEXT" | grep -q "80-1234-5678" || STEP23_REASONS+=("phone missing")
echo "$LOCAL_FULL_TEXT" | grep -q "Subject to Bangalore jurisdiction" || STEP23_REASONS+=("jurisdiction sentence missing")
echo "$LOCAL_FULL_TEXT" | grep -q "BQSPR7829H" || STEP23_REASONS+=("bank_details.pan missing")

if [ ${#STEP23_REASONS[@]} -eq 0 ]; then
  pass "TAX LOCAL invoice PDF (Task 4.8): tagline, phone, jurisdiction sentence, and bank PAN all render"
else
  fail "Tenant tagline/phone/jurisdiction/bank-PAN rendering (Step 23)" "$(IFS='; '; echo "${STEP23_REASONS[*]}")"
fi

# Step 24: reverse_charge=true -> "Reverse Charge: Yes" on a TAX invoice.
INV_RC_TRUE_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_LOCAL\",\"trip_sheet_ids\":[\"$T_RC_TRUE\"],\"reverse_charge\":true}")
INV_RC_TRUE=$(echo "$INV_RC_TRUE_RESP" | jq -r '.invoice.id // empty')
curl -s -X POST "$BASE_URL/invoices/$INV_RC_TRUE/issue" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/invoices/$INV_RC_TRUE/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s "$BASE_URL/invoices/$INV_RC_TRUE/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" -o "$WORK_DIR/rc_true.pdf"

if [ -n "$INV_RC_TRUE" ] && pdftotext -layout "$WORK_DIR/rc_true.pdf" - 2>/dev/null | grep -q "Reverse Charge:.*Yes"; then
  pass "TAX invoice with reverse_charge=true (Task 4.8): PDF renders 'Reverse Charge: Yes'"
else
  fail "reverse_charge=true PDF rendering (Step 24)" "invoice=$INV_RC_TRUE"
fi

# Step 25: reverse_charge=false -> "Reverse Charge: No".
INV_RC_FALSE_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_LOCAL\",\"trip_sheet_ids\":[\"$T_RC_FALSE\"],\"reverse_charge\":false}")
INV_RC_FALSE=$(echo "$INV_RC_FALSE_RESP" | jq -r '.invoice.id // empty')
curl -s -X POST "$BASE_URL/invoices/$INV_RC_FALSE/issue" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/invoices/$INV_RC_FALSE/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s "$BASE_URL/invoices/$INV_RC_FALSE/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" -o "$WORK_DIR/rc_false.pdf"

if [ -n "$INV_RC_FALSE" ] && pdftotext -layout "$WORK_DIR/rc_false.pdf" - 2>/dev/null | grep -q "Reverse Charge:.*No"; then
  pass "TAX invoice with reverse_charge=false (Task 4.8): PDF renders 'Reverse Charge: No'"
else
  fail "reverse_charge=false PDF rendering (Step 25)" "invoice=$INV_RC_FALSE"
fi

# Step 26: reverse_charge omitted (NULL) -> the row is absent entirely,
# not rendered as a blank/guessed value (see invoice.validator.js's
# comment on this field — a wrong declaration is a compliance risk).
INV_RC_NULL_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"TAX\",\"customer_id\":\"$CUST_LOCAL\",\"trip_sheet_ids\":[\"$T_RC_NULL\"]}")
INV_RC_NULL=$(echo "$INV_RC_NULL_RESP" | jq -r '.invoice.id // empty')
curl -s -X POST "$BASE_URL/invoices/$INV_RC_NULL/issue" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/invoices/$INV_RC_NULL/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s "$BASE_URL/invoices/$INV_RC_NULL/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" -o "$WORK_DIR/rc_null.pdf"

if [ -n "$INV_RC_NULL" ] && ! pdftotext -layout "$WORK_DIR/rc_null.pdf" - 2>/dev/null | grep -q "Reverse Charge:"; then
  pass "TAX invoice without reverse_charge (Task 4.8): PDF omits the Reverse Charge row entirely (never guessed)"
else
  fail "reverse_charge=null PDF omission (Step 26)" "invoice=$INV_RC_NULL"
fi

# Step 27: reverse_charge=true on a Proforma invoice — still hidden,
# same hideTenantTaxInfo gate as Place of Supply (Proforma isn't a tax
# document).
INV_RC_PROFORMA_RESP=$(curl -s -X POST "$BASE_URL/invoices" -H "Authorization: Bearer $OWNER_A_TOKEN" -H "Content-Type: application/json" \
  -d "{\"invoice_type\":\"PERFORMANCE\",\"customer_id\":\"$CUST_LOCAL\",\"trip_sheet_ids\":[\"$T_RC_PROFORMA\"],\"reverse_charge\":true}")
INV_RC_PROFORMA=$(echo "$INV_RC_PROFORMA_RESP" | jq -r '.invoice.id // empty')
curl -s -X POST "$BASE_URL/invoices/$INV_RC_PROFORMA/issue" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s -X POST "$BASE_URL/invoices/$INV_RC_PROFORMA/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" > /dev/null
curl -s "$BASE_URL/invoices/$INV_RC_PROFORMA/pdf" -H "Authorization: Bearer $OWNER_A_TOKEN" -o "$WORK_DIR/rc_proforma.pdf"

if [ -n "$INV_RC_PROFORMA" ] && ! pdftotext -layout "$WORK_DIR/rc_proforma.pdf" - 2>/dev/null | grep -q "Reverse Charge:"; then
  pass "Proforma invoice with reverse_charge=true (Task 4.8): still hidden — not a tax document (hideTenantTaxInfo gate)"
else
  fail "reverse_charge hidden on Proforma (Step 27)" "invoice=$INV_RC_PROFORMA"
fi

echo
echo "Summary"
echo "-------"
echo "Passed: $PASS / $TOTAL_CHECKS"
if [ "$FAIL" -gt 0 ]; then
  printf '%sFailed: %s%s\n' "$RED" "$FAIL" "$RESET"
  for step in "${FAILED_STEPS[@]}"; do
    printf '  %s✗ %s%s\n' "$RED" "$step" "$RESET"
  done
  exit 1
else
  printf '%sAll checks passed.%s\n' "$GREEN" "$RESET"
fi
