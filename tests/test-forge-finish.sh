#!/bin/bash
# Tests structurels de scripts/lib/forge-finish.sh + wiring dans scripts/forge.
# Lancer : bash tests/test-forge-finish.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORGE="$ROOT/scripts/forge"
LIB="$ROOT/scripts/lib/forge-finish.sh"
PASS=0; FAIL=0
assert_contains() {
  if grep -qF -- "$2" "$1"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL (dans $1): $2"; fi
}

echo "bash -n syntax check..."
bash -n "$LIB"
bash -n "$FORGE"

assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-finish.sh"'
assert_contains "$FORGE" 'finish)'
assert_contains "$FORGE" 'cmd_forge_finish "$@"'

assert_contains "$LIB" 'Usage: forge finish <owner/repo> <task> [--force]'
assert_contains "$LIB" 'require_container_for_repo'
assert_contains "$LIB" '_forge_check_one_worktree'
assert_contains "$LIB" 'git -C /workspace worktree remove'
assert_contains "$LIB" 'tmux kill-session -t'
assert_contains "$LIB" '--force'

echo ""; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
