#!/bin/bash
# Tests structurels de scripts/lib/forge-resume.sh + wiring dans scripts/forge.
# Lancer : bash tests/test-forge-resume.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORGE="$ROOT/scripts/forge"
LIB="$ROOT/scripts/lib/forge-resume.sh"
PASS=0; FAIL=0
assert_contains() {
  if grep -qF -- "$2" "$1"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL (dans $1): $2"; fi
}

echo "bash -n syntax check..."
bash -n "$LIB"
bash -n "$FORGE"

# dispatcher wiring
assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-resume.sh"'
assert_contains "$FORGE" 'resume)'
assert_contains "$FORGE" 'cmd_forge_resume "$@"'

# behavior
assert_contains "$LIB" 'Usage: forge resume <owner/repo> <task>'
assert_contains "$LIB" 'validate_task_name "$task_name"'
assert_contains "$LIB" 'require_container_for_repo'
assert_contains "$LIB" 'test -e /workspace/.trees/$task_name'
assert_contains "$LIB" '_forge_attach_task "$container" "$task_name"'
# resume must NOT rebranch or worktree-add
if grep -qF -- 'worktree add' "$LIB"; then FAIL=$((FAIL + 1)); echo "FAIL: resume must not create a worktree"; else PASS=$((PASS + 1)); fi

echo ""; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
