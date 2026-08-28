#!/bin/bash
# Tests structurels de scripts/forge (dispatch "list") et
# scripts/lib/forge-list.sh. Lancer : bash tests/test-forge-list.sh
set -e

FORGE="$(cd "$(dirname "$0")/.." && pwd)/scripts/forge"
LIB="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/forge-list.sh"
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

assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-list.sh"'
assert_contains "$FORGE" 'list)'
assert_contains "$FORGE" 'cmd_forge_list "$@"'

assert_contains "$LIB" 'list_forge_containers'
assert_contains "$LIB" 'forge_container_repo'
assert_contains "$LIB" 'forge_container_mode'

# header keeps CONTAINER then REPO as the first two columns (completion parses $2)
assert_contains "$LIB" 'CONTAINER'
assert_contains "$LIB" 'REPO'
assert_contains "$LIB" 'BUILD'
# per-task rows + session probe by task name
assert_contains "$LIB" '_forge_worktree_dirs'
assert_contains "$LIB" 'tmux has-session -t'
# build flag
assert_contains "$LIB" 'build_status'
assert_contains "$LIB" 'container_image_commit'
assert_contains "$LIB" 'current_image_commit'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
