#!/bin/bash
# Tests structurels de scripts/forge (dispatch "delete") et
# scripts/lib/forge-delete.sh. Lancer : bash tests/test-forge-delete.sh
set -e

FORGE="$(cd "$(dirname "$0")/.." && pwd)/scripts/forge"
LIB="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/forge-delete.sh"
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

assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-delete.sh"'
assert_contains "$FORGE" 'delete)'
assert_contains "$FORGE" 'cmd_forge_delete "$@"'

assert_contains "$LIB" 'require_container_for_repo'
assert_contains "$LIB" '--force'
assert_contains "$LIB" 'git status --porcelain'
assert_contains "$LIB" '_forge_check_wip_before_delete'
assert_contains "$LIB" 'lxc delete "$container" --force'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
