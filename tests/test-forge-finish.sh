#!/bin/bash
# Tests structurels de scripts/lib/forge-finish.sh + wiring dans scripts/forge.
# Lancer : bash tests/test-forge-finish.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORGE="$ROOT/scripts/forge"
LIB="$ROOT/scripts/lib/forge-finish.sh"
PASS=0; FAIL=0
assert_contains() {
  if grep -qF -- "$2" "$1"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL (dans $1): $2"; fi
}

echo "bash -n syntax check..."
bash -n "$LIB"
bash -n "$FORGE"

assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-finish.sh"'
assert_contains "$FORGE" 'finish)'
assert_contains "$FORGE" 'cmd_forge_finish "$@"'

assert_contains "$LIB" 'Usage: forge finish <owner/repo> <task> [--force]'
assert_contains "$LIB" 'require_container_for_repo'
assert_contains "$LIB" '_forge_check_one_worktree'
assert_contains "$LIB" 'git -C /workspace worktree remove'
assert_contains "$LIB" 'tmux kill-session -t'
assert_contains "$LIB" '--force'


# --- fonctionnel : pickers quand les arguments manquent ---
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/tests/lib/fake-lxc.sh"
fake_lxc_init "$FORGE"
trap fake_lxc_cleanup EXIT

assert_out() {
  if grep -qF -- "$1" <<< "$FORGE_TTY_OUT"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1)); echo "FAIL (sortie): attendu '$1' dans:"; sed 's/^/    /' <<< "$FORGE_TTY_OUT"
  fi
}
assert_call() {
  if grep -qF -- "$1" <<< "$(fake_lxc_calls)"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1)); echo "FAIL (appels lxc): attendu '$1' dans:"; fake_lxc_calls | sed 's/^/    /'
  fi
}
refute_call() {
  if grep -qF -- "$1" <<< "$(fake_lxc_calls)"; then
    FAIL=$((FAIL + 1)); echo "FAIL (appels lxc): '$1' ne devrait pas être appelé"
  else
    PASS=$((PASS + 1))
  fi
}

fake_lxc_image_commit "aaaa1111"
fake_lxc_container agent-moroine-agent-forge Running moroine/agent-forge autonomous "aaaa1111"
fake_lxc_container agent-acme-widgets Running acme/widgets supervised "aaaa1111"
fake_lxc_exec_rule 'git worktree list' 0 'worktree /workspace
worktree /workspace/.trees/cli
worktree /workspace/.trees/docs'
fake_lxc_exec_rule 'rev-parse --abbrev-ref HEAD' 0 'agent/cli'

# Sans argument : repo puis tâche.
fake_lxc_reset_calls
fake_lxc_run_tty $'1\n2\n' finish
assert_out '1) moroine/agent-forge'
assert_out 'Repo> '
assert_out '2) docs'
assert_out 'Task> '
assert_call 'worktree remove .trees/docs'

# --force est un flag, où qu'il soit : la tâche reste demandée.
fake_lxc_reset_calls
fake_lxc_run_tty $'1\n' finish moroine/agent-forge --force
assert_out '1) cli'
assert_call 'worktree remove --force .trees/cli'
refute_call 'git status --porcelain'

# Hors TTY : erreur d'usage, pas de blocage.
if OUT=$(PATH="$FAKE_LXC_BIN:$PATH" bash "$FORGE" finish < /dev/null 2>&1); then
  FAIL=$((FAIL + 1)); echo "FAIL: finish sans argument hors TTY devrait échouer"
else
  if grep -qF 'Usage: forge finish' <<< "$OUT"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: usage attendu, obtenu: $OUT"; fi
fi

echo ""; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
