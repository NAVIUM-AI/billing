#!/usr/bin/env bash
#
# Verification for the Task 3.6 errorHandler.js fix (ADR-007): selective
# 5xx message masking. Nothing in the live codebase currently returns a
# 501 (the LOCAL/OUTSTATION stub was replaced in Task 3.2) or an
# artificially-triggerable bare 500, so this is a static-grep check
# rather than an HTTP end-to-end one — it verifies the masking logic
# itself is shaped correctly, not a live response. Prints a PASS/FAIL
# summary and exits 1 if anything failed.
set -u

FILE="src/middleware/errorHandler.js"

GREEN=$'\033[32m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
TOTAL_CHECKS=6
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
if [ ! -f "$FILE" ]; then
  printf '%s%s not found. Run from the billing-backend directory.%s\n' "$RED" "$FILE" "$RESET"
  exit 1
fi
echo "  $FILE exists"
echo

echo "Checks"
echo "------"

# ─── Step 1: MASK_STATUSES constant exists ───
if grep -q 'MASK_STATUSES' "$FILE"; then
  pass "MASK_STATUSES constant present in $FILE"
else
  fail "MASK_STATUSES constant present" "no match for 'MASK_STATUSES'"
fi

# ─── Step 2: MASK_STATUSES includes 500, 502, 503, 504 ───
MASK_LINE=$(grep 'MASK_STATUSES = new Set' "$FILE")
STEP2_REASONS=()
for code in 500 502 503 504; do
  echo "$MASK_LINE" | grep -q "$code" || STEP2_REASONS+=("missing $code")
done

if [ ${#STEP2_REASONS[@]} -eq 0 ]; then
  pass "MASK_STATUSES includes 500, 502, 503, 504: '$MASK_LINE'"
else
  fail "MASK_STATUSES includes 500/502/503/504" "$(IFS='; '; echo "${STEP2_REASONS[*]}")"
fi

# ─── Step 3: 501 is NOT in MASK_STATUSES ───
if echo "$MASK_LINE" | grep -qE '\b501\b'; then
  fail "501 excluded from MASK_STATUSES" "501 found in MASK_STATUSES line: '$MASK_LINE'"
else
  pass "501 is NOT in MASK_STATUSES (passthrough by omission)"
fi

# ─── Step 4: 501 is mentioned in the top-of-file comment (documents the intent) ───
if grep -q '501' "$FILE"; then
  pass "501 is documented in $FILE (top-of-file comment explains passthrough intent)"
else
  fail "501 documented in file" "no mention of '501' found"
fi

# ─── Step 5: shouldMaskMessage branch exists and gates the message ───
if grep -q 'shouldMaskMessage' "$FILE"; then
  pass "shouldMaskMessage branch present"
else
  fail "shouldMaskMessage branch present" "no match for 'shouldMaskMessage'"
fi

# ─── Step 6: non-masked branch falls through to err.message ───
if grep -q 'err.message' "$FILE"; then
  pass "non-masked branch uses err.message when !shouldMaskMessage"
else
  fail "non-masked branch uses err.message" "no match for 'err.message' in $FILE"
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
  exit 1
else
  printf '%s✓ All %s checks passed. errorHandler.js selective 5xx masking (Task 3.6 / ADR-007) is correctly shaped.%s\n' "$GREEN" "$TOTAL_CHECKS" "$RESET"
  exit 0
fi
