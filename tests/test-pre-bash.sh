#!/bin/bash
# Tests du hook pre-bash.sh.
# Simule Claude Code : envoie {"tool_input":{"command":...}} sur stdin
# et vérifie allow (exit 0) vs block (exit 2).
# Prérequis : jq. Lancer : bash tests/test-pre-bash.sh
# (le hook n'utilise que grep -E POSIX : fonctionne avec BSD grep comme GNU grep)
set -e

HOOK="$(cd "$(dirname "$0")/.." && pwd)/.claude/hooks/pre-bash.sh"
PASS=0
FAIL=0

run_hook() {
  printf '{"tool_input":{"command":%s}}' "$(jq -Rn --arg c "$1" '$c')" \
    | bash "$HOOK" > /dev/null 2>&1
}

expect_allow() {
  local rc=0
  run_hook "$1" || rc=$?
  if [ "$rc" -eq 0 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu ALLOW, rc=$rc): $1"
  fi
}

expect_block() {
  local rc=0
  run_hook "$1" || rc=$?
  if [ "$rc" -eq 2 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu BLOCK, rc=$rc): $1"
  fi
}

# --- git push : seule forme autorisée = git push [-u] origin agent/* ---
expect_allow 'git push origin agent/test-project'
expect_allow 'git push -u origin agent/test-project'
expect_allow 'cd /workspace && git push -u origin agent/foo'

expect_block 'git push'
expect_block 'git push origin main'
expect_block 'git push upstream agent/test-project'
expect_block 'git push -f origin agent/test-project'
expect_block 'git push --force origin agent/test-project'
expect_block 'git push --force-with-lease origin agent/test-project'
expect_block 'git push origin agent/test-project --force'
expect_block 'git push origin --delete agent/test-project'
expect_block 'git push -d origin agent/test-project'
expect_block 'git push origin :agent/test-project'
expect_block 'git push origin main:agent/test-project'
expect_block 'git push origin agent/test-project main'

# --- commandes ordinaires : toujours autorisées ---
expect_allow 'git status'
expect_allow 'git commit -m "feat: x"'
expect_allow 'ls -la /workspace'

# --- régression : blocages existants toujours actifs ---
expect_block 'git checkout main'
expect_block 'git merge feature-x'
expect_block 'git rebase main'
expect_block 'sudo apt install foo'
expect_block 'rm -rf /workspace'

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
