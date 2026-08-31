#!/bin/bash
# Tests de scripts/forge (dispatch "completion") et
# scripts/lib/forge-completion.sh. Structurels (grep) + fonctionnels via le
# faux lxc de tests/lib/fake-lxc.sh.
# Lancer : bash tests/test-forge-completion.sh
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORGE="$ROOT/scripts/forge"
LIB="$ROOT/scripts/lib/forge-completion.sh"
PASS=0
FAIL=0

source "$ROOT/tests/lib/fake-lxc.sh"

assert_contains() {
  local file="$1" pattern="$2"
  if grep -qF -- "$pattern" "$file"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu présent dans $file): $pattern"
  fi
}

assert_not_contains() {
  local file="$1" pattern="$2"
  if grep -qF -- "$pattern" "$file"; then
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu absent de $file): $pattern"
  else
    PASS=$((PASS + 1))
  fi
}

assert_eq() {
  local got="$1" want="$2" label="$3"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL ($label): attendu [$want], obtenu [$got]"
  fi
}

ok() { PASS=$((PASS + 1)); }
ko() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

echo "bash -n syntax check..."
bash -n "$FORGE"
bash -n "$LIB"

# --- structurel ---
assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-completion.sh"'
assert_contains "$FORGE" 'completion)'
assert_contains "$FORGE" 'cmd_forge_completion_bash'
assert_contains "$LIB" 'complete -F _forge_completions forge'

# La complétion parsait la sortie humaine de `forge list` (awk '{print $2}'),
# donc toute correction d'affichage la cassait. Elle lit maintenant des
# sous-commandes à sortie machine.
assert_not_contains "$LIB" "awk '/^agent-/{print \$2}'"
assert_contains "$LIB" 'forge completion repos'
assert_contains "$LIB" 'forge completion tasks'

# --- fonctionnel ---
fake_lxc_init
trap fake_lxc_cleanup EXIT

# `forge` doit être sur le PATH pour que la fonction de complétion l'appelle.
cat > "$FAKE_LXC_BIN/forge" <<SHIM
#!/bin/bash
exec bash "$FORGE" "\$@"
SHIM
chmod +x "$FAKE_LXC_BIN/forge"
export PATH="$FAKE_LXC_BIN:$PATH"

fake_lxc_image_commit "aaaa1111"
fake_lxc_container agent-moroine-agent-forge Running moroine/agent-forge autonomous "aaaa1111"
fake_lxc_container agent-acme-widgets Stopped acme/widgets supervised "aaaa1111"
fake_lxc_exec_rule 'git worktree list' 0 'worktree /workspace
worktree /workspace/.trees/cli
worktree /workspace/.trees/docs'

assert_eq "$(forge completion repos)" "moroine/agent-forge
acme/widgets" "forge completion repos"

# La liste des repos ne doit lire que des clés de config : un `lxc exec` par
# container rendrait chaque TAB lent.
fake_lxc_reset_calls
forge completion repos > /dev/null
if grep -q '^exec ' <<< "$(fake_lxc_calls)"; then ko "completion repos fait un lxc exec"; else ok; fi

assert_eq "$(forge completion tasks moroine/agent-forge)" "cli
docs" "forge completion tasks"

# Container arrêté : pas de tâches listables, mais pas d'erreur non plus.
assert_eq "$(forge completion tasks acme/widgets)" "" "tasks sur container arrêté"

# Repo inconnu : sortie vide et code non nul (la complétion avale stderr).
if out=$(forge completion tasks nobody/nothing 2>/dev/null); then
  ko "completion tasks devrait échouer sur un repo inconnu"
else
  assert_eq "$out" "" "sortie vide sur repo inconnu"
fi

# --- la fonction de complétion elle-même ---
eval "$(forge completion bash)"

complete_for() {
  COMP_WORDS=("$@")
  COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 ))
  COMPREPLY=()
  _forge_completions
  printf '%s\n' "${COMPREPLY[@]}"
}

assert_eq "$(complete_for forge resume moroine/agent-forge '')" "cli
docs" "complétion des tâches sur resume"

assert_eq "$(complete_for forge start moroine/agent-forge '')" "cli
docs" "complétion des tâches sur start"

assert_eq "$(complete_for forge stop '')" "moroine/agent-forge
acme/widgets" "complétion des repos sur stop"

assert_eq "$(complete_for forge stop moroine/agent-forge '')" "--force" \
  "complétion de --force sur stop"

assert_eq "$(complete_for forge finish moroine/agent-forge cli '')" "--force" \
  "complétion de --force sur finish"

assert_eq "$(complete_for forge completion '')" "bash
repos
tasks" "complétion des sous-commandes de completion"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
