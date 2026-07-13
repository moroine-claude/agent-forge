#!/bin/bash
# Tests structurels de start-agent.sh.
# Lancer : bash tests/test-start-agent.sh
set -e

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/start-agent.sh"
PASS=0
FAIL=0

assert_contains() {
  if grep -qF -- "$1" "$SCRIPT"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu présent): $1"
  fi
}

assert_not_contains() {
  if grep -qF -- "$1" "$SCRIPT"; then
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu absent): $1"
  else
    PASS=$((PASS + 1))
  fi
}

echo "bash -n syntax check..."
bash -n "$SCRIPT"

assert_contains '--permission-mode auto'
assert_not_contains '--dangerously-skip-permissions'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
