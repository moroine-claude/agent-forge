#!/bin/bash
# Tests de scripts/forge (dispatch "list") et scripts/lib/forge-list.sh.
# Structurels (grep) + fonctionnels via le faux lxc de tests/lib/fake-lxc.sh.
# Lancer : bash tests/test-forge-list.sh
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORGE="$ROOT/scripts/forge"
LIB="$ROOT/scripts/lib/forge-list.sh"
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

assert_out_contains() {
  local out="$1" pattern="$2" label="$3"
  if grep -qE -- "$pattern" <<< "$out"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL ($label): motif '$pattern' absent de la sortie:"
    printf '%s\n' "$out" | sed 's/^/    /'
  fi
}

ok() { PASS=$((PASS + 1)); }
ko() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

echo "bash -n syntax check..."
bash -n "$FORGE"
bash -n "$LIB"
bash -n "$ROOT/tests/lib/fake-lxc.sh"

# --- structurel : câblage du dispatcher ---
assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-list.sh"'
assert_contains "$FORGE" 'list)'
assert_contains "$FORGE" 'cmd_forge_list "$@"'

assert_contains "$LIB" 'list_forge_containers'
assert_contains "$LIB" 'forge_container_repo'
assert_contains "$LIB" 'forge_container_mode'
assert_contains "$LIB" 'build_status'
assert_contains "$LIB" 'container_image_commit'
assert_contains "$LIB" 'current_image_commit'
assert_contains "$LIB" '_forge_worktree_dirs'

# `tmux has-session` ne dit que "la session existe", donc une session que
# personne n'a ouverte était rapportée "attached". Le probe doit lire
# #{session_attached}.
assert_not_contains "$LIB" 'tmux has-session'
assert_contains "$LIB" 'session_attached'

# La colonne CONTAINER est redondante (toujours agent-<repo assaini>) et la
# colonne BRANCH aussi (toujours agent/<task>) : supprimées.
assert_not_contains "$LIB" 'CONTAINER'
assert_not_contains "$LIB" 'BRANCH'

# --- fonctionnel ---
fake_lxc_init
trap fake_lxc_cleanup EXIT

fake_lxc_image_commit "bbbbbbbbbbbb222222222222"
fake_lxc_container agent-moroine-agent-forge Running moroine/agent-forge autonomous "aaaaaaaaaaaa111111111111"
fake_lxc_container agent-acme-super-long-repository-name Stopped acme/super-long-repository-name supervised "bbbbbbbbbbbb222222222222"
fake_lxc_exec_rule 'git worktree list' 0 'worktree /workspace
worktree /workspace/.trees/cli
worktree /workspace/.trees/docs
worktree /workspace/.trees/api'
fake_lxc_exec_rule 'session_attached' 0 'cli 1
docs 0'

OUT=$(PATH="$FAKE_LXC_BIN:$PATH" bash "$FORGE" list)

# Le repo est la clé que prennent toutes les autres commandes : première colonne.
assert_out_contains "$OUT" '^REPO +MODE +STATE +BUILD$' 'en-tête'
assert_out_contains "$OUT" '^moroine/agent-forge +autonomous +Running +behind$' 'ligne container behind'
assert_out_contains "$OUT" '^acme/super-long-repository-name +supervised +Stopped +ok$' 'ligne container ok'

# Sessions : les trois états doivent être distingués.
assert_out_contains "$OUT" '^  cli +attached$'    'session attachée'
assert_out_contains "$OUT" '^  docs +detached$'   'session détachée'
assert_out_contains "$OUT" '^  api +no session$'  'worktree sans session'

# Un container arrêté ne peut pas être inspecté : pas de lignes de tâches.
if [ "$(grep -c '^  ' <<< "$OUT")" -eq 3 ]; then ok; else ko "des lignes de tâches sont sorties pour le container arrêté"; fi

# Alignement : les colonnes des lignes container doivent démarrer exactement
# aux positions de l'en-tête, quelle que soit la longueur des noms.
HEADER=$(head -1 <<< "$OUT")
for col in MODE STATE BUILD; do
  pos=$(awk -v h="$HEADER" -v c="$col" 'BEGIN{print index(h, c)}')
  bad=$(awk -v pos="$pos" 'NR>1 && !/^ / { if (substr($0, pos, 1) == " " || substr($0, pos-1, 1) != " ") print NR }' <<< "$OUT")
  if [ -z "$bad" ]; then ok; else ko "colonne $col désalignée (lignes: $bad)"; fi
done

# Pas de wrap : la sortie doit tenir dans un terminal 80 colonnes.
LONGEST=$(awk '{ if (length($0) > m) m = length($0) } END { print m }' <<< "$OUT")
if [ "$LONGEST" -le 80 ]; then ok; else ko "ligne de $LONGEST colonnes (> 80), la sortie wrappe"; fi

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
