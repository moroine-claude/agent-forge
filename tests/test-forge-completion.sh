#!/bin/bash
# Tests structurels de scripts/forge (dispatch "completion") et
# scripts/lib/forge-completion.sh. Lancer : bash tests/test-forge-completion.sh
set -e

FORGE="$(cd "$(dirname "$0")/.." && pwd)/scripts/forge"
LIB="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/forge-completion.sh"
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

assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-completion.sh"'
assert_contains "$FORGE" 'completion)'
assert_contains "$FORGE" 'cmd_forge_completion_bash'

assert_contains "$LIB" 'complete -F _forge_completions forge'
assert_contains "$LIB" 'forge list'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
