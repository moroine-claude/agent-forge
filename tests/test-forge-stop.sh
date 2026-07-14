#!/bin/bash
# Tests structurels de scripts/forge (dispatch "stop") et
# scripts/lib/forge-stop.sh. Lancer : bash tests/test-forge-stop.sh
set -e

FORGE="$(cd "$(dirname "$0")/.." && pwd)/scripts/forge"
LIB="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/forge-stop.sh"
PASS=0
FAIL=0

assert_contains() {
  local file="$1" pattern="$2"
  if grep -qF -- "$pattern" "$file"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu présent dans $file): $pattern"
  fi
}

echo "bash -n syntax check..."
bash -n "$FORGE"
bash -n "$LIB"

assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-stop.sh"'
assert_contains "$FORGE" 'stop)'
assert_contains "$FORGE" 'cmd_forge_stop "$@"'

assert_contains "$LIB" 'require_container_for_repo'
assert_contains "$LIB" 'lxc stop'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
