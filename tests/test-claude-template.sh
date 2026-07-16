#!/bin/bash
# Tests structurels de templates/CLAUDE.md : le fichier reste unique pour
# les deux modes — sa section Git renvoie au marqueur forge-mode plutôt que
# de dupliquer le template (voir
# docs/superpowers/specs/2026-07-15-supervised-git-mode-design.md).
# Lancer : bash tests/test-claude-template.sh
set -e

TEMPLATE="$(cd "$(dirname "$0")/.." && pwd)/templates/CLAUDE.md"
PASS=0
FAIL=0

assert_contains() {
  if grep -qF -- "$1" "$TEMPLATE"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu présent): $1"
  fi
}

assert_line_before() {
  local p1="$1" p2="$2" l1 l2
  l1=$(grep -nF -- "$p1" "$TEMPLATE" | head -1 | cut -d: -f1)
  l2=$(grep -nF -- "$p2" "$TEMPLATE" | head -1 | cut -d: -f1)
  if [ -n "$l1" ] && [ -n "$l2" ] && [ "$l1" -lt "$l2" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu '$p1' avant '$p2'): l1=${l1:-?} l2=${l2:-?}"
  fi
}

assert_contains '/home/aiuser/.claude/forge-mode'
assert_contains '`autonomous`'
assert_contains '`supervised`'
assert_contains 'git push -u origin agent/<task-name>'
assert_contains 'gh pr create --base main'
assert_contains "aucune** credential GitHub"
assert_contains 'arrête-toi là'
assert_line_before '/home/aiuser/.claude/forge-mode' '`autonomous`'
assert_line_before '`autonomous`' '`supervised`'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
