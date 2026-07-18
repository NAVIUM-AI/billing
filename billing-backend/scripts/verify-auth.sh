#!/usr/bin/env bash
#
# End-to-end verification of the Task 1.3 auth flow: signup, login,
# /me (protected), refresh rotation, refresh-reuse detection, and the
# resulting DB state. Prints a PASS/FAIL summary and exits 1 if
# anything failed, so this can later plug into CI.
#
# Deliberately `set -u` but NOT `set -e`: we want every check to run
# even if an earlier one fails, so the summary reports everything that's
# broken in one pass instead of stopping at the first failure.
set -u

BASE_URL="http://localhost:8000/api/v1"
# example.com is IANA-reserved for documentation/testing and passes the
# app's own Joi email() validator. A ".local"/similar made-up TLD does
# NOT — Joi checks against a real public-suffix TLD list by default and
# rejects it, which would make this script fail at the signup step
# before ever reaching the checks it's meant to verify.
TEST_EMAIL="verify-$(date +%s)@example.com"
TEST_PASSWORD="Passw0rd123"

# All scratch files (cookie jars, response bodies) live here instead of
# the project root, and get removed on exit no matter how the script
# ends (success, failure, or an early `exit 1` in preflight).
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# ANSI-C quoting ($'...') for escape codes is a bash builtin feature
# (not an `echo -e` flag), so it behaves the same everywhere bash runs
# — including the old bash 3.2 that ships with macOS.
GREEN=$'\033[32m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
RESET=$'\033[0m'

PASS=0
FAIL=0
# Bash 3.2 (macOS default) throws "unbound variable" under `set -u` when
# expanding an EMPTY array with [@]/[*] — even one explicitly declared
# as `()`. `${#arr[@]}` (length) is safe either way. So everywhere below,
# we only ever expand FAILED_STEPS / *_REASONS with [@]/[*] behind a
# length check that already proved they're non-empty.
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

# Splits a raw `curl -i` response (headers + blank line + body) into two
# files. Written as a small helper because we need to inspect both the
# status/Set-Cookie headers AND the JSON body for several checks below.
split_raw() {
  local raw="$1" headers_out="$2" body_out="$3"
  awk -v hout="$headers_out" -v bout="$body_out" '
    BEGIN { in_body = 0 }
    {
      gsub(/\r$/, "")
      if (!in_body && $0 == "") { in_body = 1; next }
      if (in_body) print > bout
      else print > hout
    }
  ' "$raw"
  [ -f "$headers_out" ] || : > "$headers_out"
  [ -f "$body_out" ] || : > "$body_out"
}

echo "Preflight checks"
echo "----------------"

# a) Is the server up?
SERVER_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL")
if [ "$SERVER_STATUS" != "200" ]; then
  printf '%sServer not reachable at %s.\nRun '\''npm run dev'\'' first.%s\n' "$RED" "$BASE_URL" "$RESET"
  exit 1
fi
echo "  server reachable at $BASE_URL"

# b) Is Postgres reachable? Direct psql against $DATABASE_URL — no
# Docker container involved (this environment runs host Postgres) —
# mirrors the preflight in verify-vehicles.sh / verify-customers.sh /
# verify-trip-sheet-local.sh etc.
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
if ! command -v psql >/dev/null 2>&1; then
  printf '%spsql is required for this script.%s\n' "$RED" "$RESET"
  exit 1
fi
DB_IDENTITY=$(psql "${DATABASE_URL:-}" -tAc "SELECT current_database(), current_user;" 2>/dev/null)
if [ -z "$DB_IDENTITY" ]; then
  printf '%sCould not connect to Postgres via DATABASE_URL.\nCheck DATABASE_URL in .env.%s\n' "$RED" "$RESET"
  exit 1
fi
DB_NAME=$(echo "$DB_IDENTITY" | cut -d'|' -f1)
DB_ROLE=$(echo "$DB_IDENTITY" | cut -d'|' -f2)
echo "  connected to database '$DB_NAME' as role '$DB_ROLE'"

# c) Is jq installed?
if ! command -v jq >/dev/null 2>&1; then
  printf '%sjq is required for this script.\nInstall it with: brew install jq%s\n' "$YELLOW" "$RESET"
  exit 1
fi
echo "  jq is installed"
echo

# ─── STEP 0: signup a fresh test user ───
# Not one of the 6 scored checks — just setup so the run is self-
# contained and safe to repeat (unique email per run avoids
# EMAIL_ALREADY_EXISTS on a re-run).
SIGNUP_STATUS=$(curl -s -o "$WORK_DIR/signup.json" -w '%{http_code}' -X POST "$BASE_URL/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"businessName\":\"Verify Auth Co\",\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"fullName\":\"Verify Tester\"}")

if [ "$SIGNUP_STATUS" != "201" ]; then
  printf '%sSetup signup failed (status %s):%s\n' "$RED" "$SIGNUP_STATUS" "$RESET"
  cat "$WORK_DIR/signup.json"
  echo
  exit 1
fi
echo "Setup: signed up test user $TEST_EMAIL"
echo

echo "Checks"
echo "------"

# ─── STEP 1: login returns 200 + accessToken + Set-Cookie(HttpOnly), no password_hash ───
curl -s -i -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -c "$WORK_DIR/cookies.txt" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" \
  > "$WORK_DIR/login.raw"

split_raw "$WORK_DIR/login.raw" "$WORK_DIR/login-headers.txt" "$WORK_DIR/login-body.json"

LOGIN_STATUS=$(head -n1 "$WORK_DIR/login-headers.txt" | awk '{print $2}')
LOGIN_SETCOOKIE=$(grep -i '^set-cookie:' "$WORK_DIR/login-headers.txt" | grep -i 'refresh_token' || true)
ACCESS=$(jq -r '.accessToken // empty' "$WORK_DIR/login-body.json" 2>/dev/null)
LOGIN_HAS_PWHASH=$(jq -r '(.user | has("password_hash"))' "$WORK_DIR/login-body.json" 2>/dev/null)

STEP1_REASONS=()
[ "$LOGIN_STATUS" = "200" ] || STEP1_REASONS+=("expected status 200, got '$LOGIN_STATUS'")
if [ -z "$LOGIN_SETCOOKIE" ] || ! printf '%s' "$LOGIN_SETCOOKIE" | grep -qi 'httponly'; then
  STEP1_REASONS+=("missing Set-Cookie: refresh_token with HttpOnly")
fi
case "$ACCESS" in
  eyJ*) ;;
  *) STEP1_REASONS+=("accessToken missing or not a JWT") ;;
esac
[ "$LOGIN_HAS_PWHASH" = "false" ] || STEP1_REASONS+=("user object contains password_hash")

if [ ${#STEP1_REASONS[@]} -eq 0 ]; then
  pass "Login: 200 + accessToken + Set-Cookie(HttpOnly) refresh_token, no password_hash"
else
  fail "Login: 200 + accessToken + Set-Cookie(HttpOnly) refresh_token, no password_hash" "$(IFS='; '; echo "${STEP1_REASONS[*]}")"
fi

# ─── STEP 2: /me with valid token → 200 ───
ME_STATUS=$(curl -s -o "$WORK_DIR/me.json" -w '%{http_code}' "$BASE_URL/auth/me" \
  -H "Authorization: Bearer $ACCESS")
ME_EMAIL=$(jq -r '.user.email // empty' "$WORK_DIR/me.json" 2>/dev/null)
ME_PWHASH=$(jq -r '.user.password_hash // "null"' "$WORK_DIR/me.json" 2>/dev/null)

STEP2_REASONS=()
[ "$ME_STATUS" = "200" ] || STEP2_REASONS+=("expected status 200, got '$ME_STATUS'")
[ "$ME_EMAIL" = "$TEST_EMAIL" ] || STEP2_REASONS+=("user.email mismatch (got '$ME_EMAIL')")
[ "$ME_PWHASH" = "null" ] || STEP2_REASONS+=("user.password_hash present in response")

if [ ${#STEP2_REASONS[@]} -eq 0 ]; then
  pass "GET /me with valid token: 200 + correct user, no password_hash"
else
  fail "GET /me with valid token: 200 + correct user, no password_hash" "$(IFS='; '; echo "${STEP2_REASONS[*]}")"
fi

# ─── STEP 3: /me without token → 401 AUTH_REQUIRED ───
NOAUTH_STATUS=$(curl -s -o "$WORK_DIR/me-noauth.json" -w '%{http_code}' "$BASE_URL/auth/me")
NOAUTH_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/me-noauth.json" 2>/dev/null)

if [ "$NOAUTH_STATUS" = "401" ] && [ "$NOAUTH_CODE" = "AUTH_REQUIRED" ]; then
  pass "GET /me without token: 401 AUTH_REQUIRED"
else
  fail "GET /me without token: 401 AUTH_REQUIRED" "got status '$NOAUTH_STATUS', code '$NOAUTH_CODE'"
fi

# ─── STEP 4: refresh → 200 + rotated cookie ───
cp "$WORK_DIR/cookies.txt" "$WORK_DIR/cookies-old.txt"

curl -s -i -X POST "$BASE_URL/auth/refresh" \
  -b "$WORK_DIR/cookies.txt" \
  -c "$WORK_DIR/cookies.txt" \
  > "$WORK_DIR/refresh.raw"

split_raw "$WORK_DIR/refresh.raw" "$WORK_DIR/refresh-headers.txt" "$WORK_DIR/refresh-body.json"

REFRESH_STATUS=$(head -n1 "$WORK_DIR/refresh-headers.txt" | awk '{print $2}')
REFRESH_SETCOOKIE=$(grep -i '^set-cookie:' "$WORK_DIR/refresh-headers.txt" | grep -i 'refresh_token' || true)
NEW_ACCESS=$(jq -r '.accessToken // empty' "$WORK_DIR/refresh-body.json" 2>/dev/null)

STEP4_REASONS=()
[ "$REFRESH_STATUS" = "200" ] || STEP4_REASONS+=("expected status 200, got '$REFRESH_STATUS'")
[ -n "$REFRESH_SETCOOKIE" ] || STEP4_REASONS+=("missing Set-Cookie: refresh_token")
case "$NEW_ACCESS" in
  eyJ*) ;;
  *) STEP4_REASONS+=("new accessToken missing or not a JWT") ;;
esac
# NOT checking NEW_ACCESS != ACCESS here: a JWT is a deterministic
# function of its claims + secret, and if login and refresh land in the
# same wall-clock second, `iat` (second-resolution) is identical too —
# same claims in, byte-identical token out. That's correct JWT behavior,
# not a bug, so asserting inequality here would be flaky, not a real
# check. The refresh COOKIE is what's guaranteed unique per issuance
# (crypto.randomBytes), which is what the diff check below verifies.
if diff -q "$WORK_DIR/cookies.txt" "$WORK_DIR/cookies-old.txt" >/dev/null 2>&1; then
  STEP4_REASONS+=("cookie jar unchanged after refresh (rotation did not happen)")
fi

if [ ${#STEP4_REASONS[@]} -eq 0 ]; then
  pass "Refresh: 200 + rotated cookie + new accessToken"
else
  fail "Refresh: 200 + rotated cookie + new accessToken" "$(IFS='; '; echo "${STEP4_REASONS[*]}")"
fi

# ─── STEP 5: reused old refresh token → 401 REFRESH_TOKEN_REUSED, and
#             ALL tokens for the user (including the currently-valid
#             one) are revoked as a safety measure ───
REUSE_STATUS=$(curl -s -o "$WORK_DIR/reuse.json" -w '%{http_code}' \
  -X POST "$BASE_URL/auth/refresh" -b "$WORK_DIR/cookies-old.txt")
REUSE_CODE=$(jq -r '.error.code // empty' "$WORK_DIR/reuse.json" 2>/dev/null)

CURRENT_STATUS=$(curl -s -o "$WORK_DIR/current.json" -w '%{http_code}' \
  -X POST "$BASE_URL/auth/refresh" -b "$WORK_DIR/cookies.txt")

STEP5_REASONS=()
if [ "$REUSE_STATUS" != "401" ] || [ "$REUSE_CODE" != "REFRESH_TOKEN_REUSED" ]; then
  STEP5_REASONS+=("reusing old token: expected 401 REFRESH_TOKEN_REUSED, got status '$REUSE_STATUS' code '$REUSE_CODE'")
fi
[ "$CURRENT_STATUS" = "401" ] || STEP5_REASONS+=("previously-valid cookie should now also be revoked: expected 401, got '$CURRENT_STATUS'")

if [ ${#STEP5_REASONS[@]} -eq 0 ]; then
  pass "Refresh-reuse detection: old token → 401 REFRESH_TOKEN_REUSED, all tokens for user revoked"
else
  fail "Refresh-reuse detection: old token → 401 REFRESH_TOKEN_REUSED, all tokens for user revoked" "$(IFS='; '; echo "${STEP5_REASONS[*]}")"
fi

# ─── STEP 6: DB state matches expectation ───
# Direct psql against $DATABASE_URL (billing_app role), same as the
# preflight above — no Docker container involved. users/refresh_tokens
# predate the RLS migration (see enable_rls_and_ping.sql) and carry no
# RLS policy, so billing_app (which owns every table) reads them
# directly with no session var needed.
USER_ID=$(psql "${DATABASE_URL:-}" -tAc \
  "SELECT id FROM users WHERE email='$TEST_EMAIL'" 2>/dev/null | tr -d '[:space:]')

if [ -z "$USER_ID" ]; then
  fail "DB state: refresh_tokens rows for user are rotated + revoked as expected" "could not find user id for $TEST_EMAIL in the DB"
else
  ROWS=$(psql "${DATABASE_URL:-}" -tAc \
    "SELECT id::text || '|' || (revoked_at IS NOT NULL)::text || '|' || (replaced_by IS NOT NULL)::text || '|' || issued_at::text
     FROM refresh_tokens WHERE user_id='$USER_ID' ORDER BY issued_at" 2>/dev/null)

  printf '%sRefresh token rows for %s:%s\n' "$YELLOW" "$TEST_EMAIL" "$RESET"
  printf '  %-38s %-9s %-13s %s\n' "id" "revoked" "was_rotated" "issued_at"
  if [ -n "$ROWS" ]; then
    while IFS='|' read -r row_id row_revoked row_rotated row_issued; do
      [ -n "$row_id" ] || continue
      printf '  %-38s %-9s %-13s %s\n' "$row_id" "$row_revoked" "$row_rotated" "$row_issued"
    done <<< "$ROWS"
  fi
  echo

  TOTAL_ROWS=0
  REVOKED_COUNT=0
  ROTATED_COUNT=0
  if [ -n "$ROWS" ]; then
    while IFS='|' read -r row_id row_revoked row_rotated row_issued; do
      [ -n "$row_id" ] || continue
      TOTAL_ROWS=$((TOTAL_ROWS + 1))
      # Postgres's ::text cast of a boolean yields the literal string
      # "true"/"false" (not "t"/"f" — that's the separate input/output
      # literal format used elsewhere, e.g. in COPY).
      [ "$row_revoked" = "true" ] && REVOKED_COUNT=$((REVOKED_COUNT + 1))
      [ "$row_rotated" = "true" ] && ROTATED_COUNT=$((ROTATED_COUNT + 1))
    done <<< "$ROWS"
  fi

  STEP6_REASONS=()
  [ "$TOTAL_ROWS" -ge 2 ] || STEP6_REASONS+=("expected >= 2 refresh_token rows, found $TOTAL_ROWS")
  [ "$REVOKED_COUNT" -eq "$TOTAL_ROWS" ] || STEP6_REASONS+=("expected all $TOTAL_ROWS rows revoked, only $REVOKED_COUNT are")
  [ "$ROTATED_COUNT" -ge 1 ] || STEP6_REASONS+=("expected >= 1 rotated row (replaced_by set), found $ROTATED_COUNT")

  if [ ${#STEP6_REASONS[@]} -eq 0 ]; then
    pass "DB state: $TOTAL_ROWS refresh_token row(s), all revoked, $ROTATED_COUNT rotated"
  else
    fail "DB state: refresh_tokens rows for user are rotated + revoked as expected" "$(IFS='; '; echo "${STEP6_REASONS[*]}")"
  fi
fi

# ─── SUMMARY ───
echo
printf '%s══════════════════════════════════════════════%s\n' "$YELLOW" "$RESET"
echo "VERIFICATION SUMMARY"
printf '%s══════════════════════════════════════════════%s\n' "$YELLOW" "$RESET"
echo "Passed: $PASS/6"
echo "Failed: $FAIL/6"
echo

if [ "$FAIL" -gt 0 ]; then
  echo "Failed steps:"
  for step in "${FAILED_STEPS[@]}"; do
    printf '  %s✗ %s%s\n' "$RED" "$step" "$RESET"
  done
  echo
  echo "Test user created: $TEST_EMAIL"
  exit 1
else
  printf '%s✓ All 6 checks passed. Auth module is working correctly.%s\n' "$GREEN" "$RESET"
  echo
  echo "Test user created: $TEST_EMAIL"
  exit 0
fi
