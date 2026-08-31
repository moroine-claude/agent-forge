#!/bin/bash
# Tests structurels de scripts/lib/forge-resume.sh + wiring dans scripts/forge.
# Lancer : bash tests/test-forge-resume.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORGE="$ROOT/scripts/forge"
LIB="$ROOT/scripts/lib/forge-resume.sh"
PASS=0; FAIL=0
assert_contains() {
  if grep -qF -- "$2" "$1"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL (dans $1): $2"; fi
}

echo "bash -n syntax check..."
bash -n "$LIB"
bash -n "$FORGE"

# dispatcher wiring
assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-resume.sh"'
assert_contains "$FORGE" 'resume)'
assert_contains "$FORGE" 'cmd_forge_resume "$@"'

# behavior
assert_contains "$LIB" 'Usage: forge resume <owner/repo> <task>'
assert_contains "$LIB" 'validate_task_name "$task_name"'
assert_contains "$LIB" 'require_container_for_repo'
assert_contains "$LIB" 'test -e /workspace/.trees/$task_name'
assert_contains "$LIB" '_forge_attach_task "$container" "$task_name"'
# resume must NOT rebranch or worktree-add
if grep -qF -- 'worktree add' "$LIB"; then FAIL=$((FAIL + 1)); echo "FAIL: resume must not create a worktree"; else PASS=$((PASS + 1)); fi

# --- fonctionnel : pickers quand les arguments manquent ---
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

fake_lxc_image_commit "aaaa1111"
fake_lxc_container agent-moroine-agent-forge Running moroine/agent-forge autonomous "aaaa1111"
fake_lxc_container agent-acme-widgets Running acme/widgets supervised "aaaa1111"
fake_lxc_exec_rule 'git worktree list' 0 'worktree /workspace
worktree /workspace/.trees/cli
worktree /workspace/.trees/docs'

# Sans aucun argument : on demande le repo, puis la tâche parmi les worktrees.
fake_lxc_reset_calls
fake_lxc_run_tty $'1\n2\n' resume
assert_out '1) moroine/agent-forge'
assert_out '2) acme/widgets'
assert_out 'Repo> '
assert_out '2) docs'
assert_out 'Task> '
assert_call 'tmux new-session -A -s docs'
if [ "$FORGE_TTY_RC" = "0" ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: resume interactif a rendu $FORGE_TTY_RC"; fi

# Repo donné, tâche manquante : seule la tâche est demandée.
fake_lxc_reset_calls
fake_lxc_run_tty $'1\n' resume moroine/agent-forge
assert_out '1) cli'
assert_call 'tmux new-session -A -s cli'
if grep -qF 'Repo> ' <<< "$FORGE_TTY_OUT"; then
  FAIL=$((FAIL + 1)); echo "FAIL: repo redemandé alors qu'il était fourni"
else
  PASS=$((PASS + 1))
fi

# Hors TTY, les arguments manquants restent une erreur d'usage, pas un blocage.
if OUT=$(PATH="$FAKE_LXC_BIN:$PATH" bash "$FORGE" resume < /dev/null 2>&1); then
  FAIL=$((FAIL + 1)); echo "FAIL: resume sans argument hors TTY devrait échouer"
else
  if grep -qF 'Usage: forge resume' <<< "$OUT"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: usage attendu hors TTY, obtenu: $OUT"; fi
fi

echo ""; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
