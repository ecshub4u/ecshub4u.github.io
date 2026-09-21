#!/usr/bin/env bash
# Post-deploy smoke test for ECS Drive's backend.
#
# Usage:
#   BASE_URL="https://ecs-drive-api.<your-subdomain>.workers.dev" ./scripts/smoke-test.sh
#
# Exits non-zero on the first failed check. Cleans up the test folder it
# creates, even on failure, so re-running doesn't pile up junk folders.

set -euo pipefail

BASE_URL="${BASE_URL:?Set BASE_URL to your deployed backend URL, e.g. https://ecs-drive-api.<subdomain>.workers.dev}"
FOLDER_NAME="smoke-test-$(date +%s)"
MANAGEMENT_TOKEN=""
FOLDER_ID=""

cleanup() {
  if [ -n "$FOLDER_ID" ] && [ -n "$MANAGEMENT_TOKEN" ]; then
    echo "Cleaning up test folder..."
    curl -s -X DELETE "$BASE_URL/api/folders/$FOLDER_ID" \
      -H "Authorization: Bearer $MANAGEMENT_TOKEN" >/dev/null || true
  fi
}
trap cleanup EXIT

pass() { echo "  OK: $1"; }
fail() { echo "  FAIL: $1"; exit 1; }

echo "== 1. Health check =="
HEALTH=$(curl -sf "$BASE_URL/api/health")
echo "$HEALTH" | grep -q '"status":"ok"' && pass "status ok" || fail "status not ok: $HEALTH"
echo "$HEALTH" | grep -q '"db":"connected"' && pass "DB connected" || fail "DB not connected: $HEALTH"

echo "== 2. Create a folder =="
CREATE_RESPONSE=$(curl -sf -X POST "$BASE_URL/api/folders" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$FOLDER_NAME\"}")
FOLDER_ID=$(echo "$CREATE_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
MANAGEMENT_TOKEN=$(echo "$CREATE_RESPONSE" | grep -o '"managementToken":"[^"]*"' | cut -d'"' -f4)
[ -n "$FOLDER_ID" ] && pass "folder created (id=$FOLDER_ID)" || fail "no folder id in response: $CREATE_RESPONSE"
[ -n "$MANAGEMENT_TOKEN" ] && pass "management token issued" || fail "no management token in response"

echo "== 3. List folders (should include the new one) =="
LIST_RESPONSE=$(curl -sf "$BASE_URL/api/folders")
echo "$LIST_RESPONSE" | grep -q "$FOLDER_ID" && pass "new folder appears in listing" || fail "new folder missing from listing"

echo "== 4. Rename requires the management token =="
NO_AUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE_URL/api/folders/$FOLDER_ID" \
  -H "Content-Type: application/json" -d '{"name":"should-fail"}')
[ "$NO_AUTH_STATUS" = "401" ] && pass "rename without token correctly rejected (401)" || fail "expected 401, got $NO_AUTH_STATUS"

WITH_AUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE_URL/api/folders/$FOLDER_ID" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $MANAGEMENT_TOKEN" \
  -d "{\"name\":\"$FOLDER_NAME-renamed\"}")
[ "$WITH_AUTH_STATUS" = "200" ] && pass "rename with correct token succeeded" || fail "expected 200, got $WITH_AUTH_STATUS"

echo "== 5. Security headers present =="
HEADERS=$(curl -sI "$BASE_URL/api/health")
echo "$HEADERS" | grep -qi "x-frame-options: DENY" && pass "X-Frame-Options set" || fail "X-Frame-Options missing"

echo ""
echo "All smoke tests passed."
