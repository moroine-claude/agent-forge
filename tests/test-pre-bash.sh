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

MODE_FILE=$(mktemp)
trap 'rm -f "$MODE_FILE"' EXIT

run_hook_as() {
  local mode="$1" cmd="$2"
  printf '%s' "$mode" > "$MODE_FILE"
  FORGE_MODE_FILE="$MODE_FILE" run_hook "$cmd"
}

expect_allow_as() {
  local mode="$1" cmd="$2" rc=0
  run_hook_as "$mode" "$cmd" || rc=$?
  if [ "$rc" -eq 0 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu ALLOW mode=$mode, rc=$rc): $cmd"
  fi
}

expect_block_as() {
  local mode="$1" cmd="$2" rc=0
  run_hook_as "$mode" "$cmd" || rc=$?
  if [ "$rc" -eq 2 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu BLOCK mode=$mode, rc=$rc): $cmd"
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
# Un push autorisé ne doit pas masquer un push interdit dans la même commande
expect_block 'git push origin agent/test-project && git push origin main'
expect_block 'git push origin main && git push origin agent/test-project'
expect_block 'git push origin agent/test-project; git push origin main'
expect_block "$(printf 'git push origin agent/foo\ngit push origin main')"
# Les options globales de git ne doivent pas contourner la politique
expect_block 'git -C /workspace push origin main'
expect_block 'git -C /workspace push --force origin agent/test-project'
expect_block 'git --git-dir=/workspace/.git push origin main'
expect_block 'git -c user.email=x@y push origin main'
expect_block 'git -C /workspace push origin agent/test-project'
# Fail-closed assumé : redirection en fin de push autorisé (tr coupe sur &)
expect_block 'git push origin agent/test-project 2>&1'
# Séparateur collé au mot-clé : ne doit pas esquiver le déclencheur
expect_block 'git push;true'
# Pas de faux positif sur un message de commit contenant "push"
expect_allow 'git commit -m "docs: explain push policy"'

# --- gh : créer/mettre à jour des PRs oui, merger/API brute/repo non ---
expect_allow 'gh pr create --base main --title "feat: x" --body "..."'
expect_allow 'gh pr view 42'
expect_allow 'gh pr list'
expect_allow 'gh auth status'

expect_block 'gh pr merge 42'
expect_block 'gh pr merge --auto --squash'
expect_block 'gh api user'
expect_block 'gh api /repos/foo/bar'
expect_block 'gh repo view'
expect_block 'gh repo delete foo/bar'
expect_block 'cd /workspace && gh pr merge 42'
# Le flag --repo intercalé ne doit pas contourner le blocage du merge
expect_block 'gh pr --repo=owner/repo merge 42'
expect_block 'gh pr --repo owner/repo merge 42'
# Pas d'alias/extension pour renommer des commandes bloquées, pas de lecture du token
expect_block 'gh alias set pm "pr merge"'
expect_block 'gh extension install owner/gh-ext'
expect_block 'gh auth token'
expect_block 'gh auth token|cat'
# Pas de faux positif sur un titre de PR contenant "merge"
expect_allow 'gh pr create --title "fix: merge conflict" --body "x"'

# --- commandes ordinaires : toujours autorisées ---
expect_allow 'git status'
expect_allow 'git commit -m "feat: x"'
expect_allow 'ls -la /workspace'

# --- git merge : seule forme autorisée = "git merge [--no-edit] origin/main" ---
expect_allow 'git merge origin/main'
expect_allow 'git merge --no-edit origin/main'
expect_block 'git merge main'
expect_block 'git merge feature-x'
expect_block 'git merge origin/agent-forge'
expect_block 'git merge -X theirs origin/main'
expect_block 'git merge origin/main && git push origin main'
expect_block 'git merge origin/main; git checkout main'

# --- régression : blocages existants toujours actifs ---
expect_block 'git checkout main'
expect_block 'git rebase main'
expect_block 'sudo apt install foo'
expect_block 'rm -rf /workspace'

# --- supervised mode: no credential exists, so every push and every gh
# subcommand is blocked, including forms autonomous mode explicitly allows ---
expect_block_as supervised 'git push origin agent/test-project'
expect_block_as supervised 'git push -u origin agent/test-project'
expect_block_as supervised 'git push origin main'
expect_block_as supervised 'gh pr create --base main --title "x" --body "y"'
expect_block_as supervised 'gh pr view 42'
expect_block_as supervised 'gh auth status'

# --- autonomous mode, explicit: unchanged from the default behavior above ---
expect_allow_as autonomous 'git push origin agent/test-project'
expect_block_as autonomous 'git push origin main'
expect_allow_as autonomous 'gh pr create --base main --title "x" --body "y"'
expect_block_as autonomous 'gh pr merge 42'

# --- ordinary commands stay allowed in supervised mode too ---
expect_allow_as supervised 'git status'
expect_allow_as supervised 'git commit -m "feat: x"'

# --- missing marker file defaults to autonomous (existing containers,
# provisioned before this feature, keep working unmodified) ---
rc=0
FORGE_MODE_FILE="$MODE_FILE.does-not-exist" run_hook 'git push origin agent/test-project' || rc=$?
if [ "$rc" -eq 0 ]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL (attendu ALLOW, missing marker file should default to autonomous, rc=$rc)"
fi

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
