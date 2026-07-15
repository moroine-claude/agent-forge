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

assert_line_before() {
  local file="$1" p1="$2" p2="$3" l1 l2
  l1=$(grep -nF -- "$p1" "$file" | head -1 | cut -d: -f1)
  l2=$(grep -nF -- "$p2" "$file" | head -1 | cut -d: -f1)
  if [ -n "$l1" ] && [ -n "$l2" ] && [ "$l1" -lt "$l2" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu '$p1' avant '$p2' dans $file): l1=${l1:-?} l2=${l2:-?}"
  fi
}

echo "bash -n syntax check..."
bash -n "$SCRIPT"

assert_contains "$SCRIPT" 'git status --porcelain'
assert_contains "$SCRIPT" 'git log --oneline'
assert_contains "$SCRIPT" 'git rev-parse --verify "origin/$CURRENT_BRANCH"'
assert_contains "$SCRIPT" 'git fetch origin'
assert_contains "$SCRIPT" 'git checkout -b "agent/$SHORT_NAME" origin/main'

# --- regression: reviewer-flagged gaps (unvalidated short-name, no check
# that next-task runs from an actual agent/* branch) ---
assert_contains "$SCRIPT" '[[ ! "$SHORT_NAME" =~ ^[A-Za-z0-9._-]+$ ]]'
assert_contains "$SCRIPT" '[[ ! "$CURRENT_BRANCH" =~ ^agent/ ]]'
assert_line_before "$SCRIPT" '[[ ! "$SHORT_NAME" =~' 'git checkout -b "agent/$SHORT_NAME"'
assert_line_before "$SCRIPT" '[[ ! "$CURRENT_BRANCH" =~ ^agent/ ]]' 'git checkout -b "agent/$SHORT_NAME"'

assert_contains "$TEMPLATE" 'next-task'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
