#!/bin/bash
# Tests structurels de new-agent-container.sh.
# Pas de lxc disponible ici : on vérifie le contenu et l'ordre des étapes
# du script par grep, pas son exécution réelle (voir Task 6 pour ça).
# Lancer : bash tests/test-new-agent-container.sh
set -e

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/new-agent-container.sh"
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

assert_line_before() {
  local l1 l2
  l1=$(grep -nF -- "$1" "$SCRIPT" | head -1 | cut -d: -f1)
  l2=$(grep -nF -- "$2" "$SCRIPT" | head -1 | cut -d: -f1)
  if [ -n "$l1" ] && [ -n "$l2" ] && [ "$l1" -lt "$l2" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu '$1' avant '$2'): l1=${l1:-?} l2=${l2:-?}"
  fi
}

echo "bash -n syntax check..."
bash -n "$SCRIPT"

# --- Task 1: workspace mount without elevated host privileges ---
assert_contains 'shift=true'
assert_not_contains '1001001'

# --- Task 2: Claude credential + onboarding reuse, before plugin install ---
assert_contains '.credentials.json'
assert_contains 'claude-onboarding-state.json'
assert_line_before '.credentials.json' 'Installing Claude plugins'
assert_line_before 'claude-onboarding-state.json' 'Installing Claude plugins'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
