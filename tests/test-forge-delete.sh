#!/bin/bash
# Tests structurels de scripts/forge (dispatch "delete") et
# scripts/lib/forge-delete.sh. Lancer : bash tests/test-forge-delete.sh
set -e

FORGE="$(cd "$(dirname "$0")/.." && pwd)/scripts/forge"
LIB="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/forge-delete.sh"
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

assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-delete.sh"'
assert_contains "$FORGE" 'delete)'
assert_contains "$FORGE" 'cmd_forge_delete "$@"'

assert_contains "$LIB" 'require_container_for_repo'
assert_contains "$LIB" '--force'
assert_contains "$LIB" 'forge_check_wip "$container"'
assert_contains "$LIB" 'lxc delete "$container" --force'

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

# Sans argument : le repo est demandé.
fake_lxc_reset_calls
fake_lxc_run_tty $'1\n' delete
assert_out '1) moroine/agent-forge'
assert_out 'Repo> '
assert_call 'delete agent-moroine-agent-forge --force'

# --force en première position doit rester un flag, pas un nom de repo.
fake_lxc_reset_calls
fake_lxc_run_tty $'2\n' delete --force
assert_call 'delete agent-acme-widgets --force'
refute_call 'git status --porcelain'

# Hors TTY : erreur d'usage, pas de blocage.
if OUT=$(PATH="$FAKE_LXC_BIN:$PATH" bash "$FORGE" delete < /dev/null 2>&1); then
  FAIL=$((FAIL + 1)); echo "FAIL: delete sans argument hors TTY devrait échouer"
else
  if grep -qF 'Usage: forge delete' <<< "$OUT"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: usage attendu, obtenu: $OUT"; fi
fi

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
