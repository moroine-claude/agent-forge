#!/bin/bash
# Vérifie que README.md documente le nouveau comportement de provisioning.
# Lancer : bash tests/test-readme-docs.sh
set -e

FILE="$(cd "$(dirname "$0")/.." && pwd)/README.md"
PASS=0
FAIL=0

assert_contains() {
  if grep -qF -- "$1" "$FILE"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu présent): $1"
  fi
}

assert_contains 'idmap'
assert_contains 'Claude Code credentials'
assert_contains 'onboarding'
assert_contains 'permission mode'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
