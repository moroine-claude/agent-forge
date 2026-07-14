#!/bin/bash
# Tests structurels de config/next-task.sh, et vérifie que
# templates/CLAUDE.md documente son existence.
# Lancer : bash tests/test-next-task.sh
set -e

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/config/next-task.sh"
TEMPLATE="$(cd "$(dirname "$0")/.." && pwd)/templates/CLAUDE.md"
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
bash -n "$SCRIPT"

assert_contains "$SCRIPT" 'git status --porcelain'
assert_contains "$SCRIPT" 'git log --oneline'
assert_contains "$SCRIPT" 'git rev-parse --verify "origin/$CURRENT_BRANCH"'
assert_contains "$SCRIPT" 'git fetch origin'
assert_contains "$SCRIPT" 'git checkout -b "agent/$SHORT_NAME" origin/main'

assert_contains "$TEMPLATE" 'next-task'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
