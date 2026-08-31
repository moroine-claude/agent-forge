#!/bin/bash
# Tests structurels de scripts/forge (dispatch "start") et
# scripts/lib/forge-start.sh. Pas de lxc disponible ici : grep + bash -n,
# pas d'exécution réelle (voir Task 10).
# Lancer : bash tests/test-forge-start.sh
set -e

FORGE="$(cd "$(dirname "$0")/.." && pwd)/scripts/forge"
LIB="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/forge-start.sh"
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

assert_not_contains() {
  local file="$1" pattern="$2"
  if grep -qF -- "$pattern" "$file"; then
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu absent dans $file): $pattern"
  else
    PASS=$((PASS + 1))
  fi
}

assert_body_contains() {
  local body="$1" pattern="$2"
  if grep -qF -- "$pattern" <<< "$body"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu présent dans _forge_attach_task): $pattern"
  fi
}

assert_body_not_contains() {
  local body="$1" pattern="$2"
  if grep -qF -- "$pattern" <<< "$body"; then
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu absent de _forge_attach_task): $pattern"
  else
    PASS=$((PASS + 1))
  fi
}

assert_line_before() {
  local file="$1" p1="$2" p2="$3" l1 l2
  l1=$(grep -nF -- "$p1" "$file" | head -1 | cut -d: -f1)
  l2=$(grep -nF -- "$p2" "$file" | head -1 | cut -d: -f1)
  if [ -n "$l1" ] && [ -n "$l2" ] && [ "$l1" -lt "$l2" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu '$p1' avant '$p2' dans $file): l1=${l1:-?} l2=${l2:-?}"
  fi
}

echo "bash -n syntax check..."
bash -n "$FORGE"
bash -n "$LIB"

# --- dispatcher wiring ---
assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-common.sh"'
assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-start.sh"'
assert_contains "$FORGE" 'start)'
assert_contains "$FORGE" 'cmd_forge_start "$@"'

# --- forge-start.sh: provisioning carried over from new-agent-container.sh ---
assert_contains "$LIB" 'sanitize_container_name'
assert_contains "$LIB" 'check_container_name_collision'
assert_contains "$LIB" 'raw.idmap'
assert_not_contains "$LIB" 'shift=true'
assert_not_contains "$LIB" '1001001'
assert_contains "$LIB" '.credentials.json'
assert_contains "$LIB" 'claude-onboarding-state.json'
assert_line_before "$LIB" '.credentials.json' 'Installing Claude plugins'
assert_line_before "$LIB" 'claude-onboarding-state.json' 'Installing Claude plugins'
assert_contains "$LIB" 'gh auth login'

# --- new in this task: metadata + reuse + task-name default ---
assert_contains "$LIB" 'lxc config set "$container" user.forge.repo'
assert_contains "$LIB" 'lxc config set "$container" user.forge.mode "$mode"'
assert_contains "$LIB" 'validate_task_name "$task_name"'
# The old "container already exists -> warn, ignore task-name" branch is
# retired in Task 5: an existing container now just skips provisioning and
# proceeds to _forge_add_worktree (see the 'already exists' guard below).
assert_contains "$LIB" '--permission-mode auto'
assert_contains "$LIB" 'tmux new-session'

# --- new in this task: mode prompt, supervised host-side clone, mode
# marker file, retrieval reminder ---
assert_contains "$LIB" 'Mode for this container?'
assert_contains "$LIB" 'read -r -p "Choice [a/s]: " MODE_CHOICE'
assert_contains "$LIB" 's|S) mode="supervised" ;;'
assert_contains "$LIB" 'echo '"'"'$mode'"'"' > /home/aiuser/.claude/forge-mode'
assert_contains "$LIB" 'git clone "git@github.com:$owner_repo.git" "$workspace_dir"'
assert_contains "$LIB" 'git remote add $container ssh://moroine@'
assert_line_before "$LIB" 'Mode for this container?' 'lxc launch agent-base'
assert_line_before "$LIB" "echo '\$mode' > /home/aiuser/.claude/forge-mode" 'git clone "git@github.com:$owner_repo.git"'
assert_line_before "$LIB" 'git clone "git@github.com:$owner_repo.git" "$workspace_dir"' 'lxc config set "$container" user.forge.repo'

# --- new in this task: provisioning stays on main, LFS + .trees exclude, image stamp ---
assert_contains "$LIB" 'git lfs install'
assert_contains "$LIB" '.trees/'
assert_contains "$LIB" 'info/exclude'
assert_contains "$LIB" 'lxc config set "$container" user.forge.image_commit'
assert_not_contains "$LIB" 'git checkout -b "agent/$task_name"'

# --- task-name optionnelle : demandée si absente, jamais defaultée ---
assert_contains "$LIB" 'Usage: forge start <owner/repo> [<task>]'
assert_not_contains "$LIB" 'task_name="${2:-init}"'

# --- worktree add inside the container, from origin/main, on agent/<task> ---
assert_contains "$LIB" 'git -C /workspace worktree add'
assert_contains "$LIB" '-b agent/$task_name origin/main'
# Un worktree déjà là n'est plus une erreur renvoyant vers `forge resume` :
# c'est justement la tâche qu'on veut attaquer, on s'y rattache.
assert_not_contains "$LIB" "Use 'forge resume"
# Reprise d'une branche existante, locale ou seulement sur origin.
assert_contains "$LIB" 'refs/heads/agent/$task_name'
assert_contains "$LIB" 'refs/remotes/origin/agent/$task_name'

# --- fetch + ff main (autonomous), skipped for supervised ---
assert_contains "$LIB" 'git -C /workspace fetch origin'
assert_contains "$LIB" 'merge --ff-only origin/main'

# --- per-task attach: session named after the task, worktree as cwd ---
assert_contains "$LIB" 'tmux new-session -A -s'
assert_contains "$LIB" '--remote-control ${container}-${task_name}'

# --- attach must keep tmux the DIRECT target of `lxc exec` ---
# An intermediate `su - aiuser -c "..."` shell swallows SIGWINCH: the tmux
# client never learns the new size on host-terminal resize and keeps drawing
# into a stale grid (garbled display). These assertions are scoped to the
# body of _forge_attach_task so unrelated `su - aiuser -c` calls elsewhere in
# the file (provisioning) can't satisfy them by accident.
ATTACH_BODY=$(sed -n '/^_forge_attach_task() {/,/^}/p' "$LIB")
assert_body_contains "$ATTACH_BODY" '-- tmux new-session -A -s "$task_name"'
assert_body_contains "$ATTACH_BODY" '--user 1001 --group 1001'
assert_body_contains "$ATTACH_BODY" '--cwd "/workspace/.trees/$task_name"'
assert_body_contains "$ATTACH_BODY" '--env "TERM=${TERM:-xterm-256color}"'
assert_body_not_contains "$ATTACH_BODY" 'su - aiuser'
assert_body_not_contains "$ATTACH_BODY" 'cd /workspace/.trees/'

# `lxc exec` sources no rc file, but DOCKER_HOST is exported from .bashrc
# (forge-image.sh). Without a login shell under tmux, rootless Docker breaks
# silently — so the wrapper is load-bearing, not cosmetic.
assert_body_contains "$ATTACH_BODY" 'exec bash -lc'

# --- fonctionnel : résolution de branche et menu de tâches ---
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

# Les règles sont matchées dans l'ordre : la plus spécifique d'abord, puis un
# fourre-tout qui répond "n'existe pas".
setup_rules() {
  fake_lxc_reset_rules
  fake_lxc_exec_rule 'git worktree list' 0 'worktree /workspace
worktree /workspace/.trees/cli'
  fake_lxc_exec_rule 'test -e /workspace/.trees/cli' 0
  fake_lxc_exec_rule 'test -e /workspace/.trees/' 1
  local rule
  for rule in "$@"; do
    fake_lxc_exec_rule "${rule%%|*}" "${rule##*|}"
  done
  fake_lxc_exec_rule 'show-ref' 1
}

# 1. Worktree déjà présent : on s'y rattache au lieu d'échouer.
setup_rules
fake_lxc_reset_calls
fake_lxc_run_tty '' start moroine/agent-forge cli
assert_call 'tmux new-session -A -s cli'
refute_call 'worktree add'

# 2. Branche locale existante (cas post-`forge finish`) : worktree dessus.
setup_rules 'show-ref --verify --quiet refs/heads/agent/docs|0'
fake_lxc_reset_calls
fake_lxc_run_tty '' start moroine/agent-forge docs
assert_call 'git -C /workspace worktree add .trees/docs agent/docs'

# 3. Branche seulement sur origin (PR ouverte ailleurs) : on la reprend.
setup_rules 'show-ref --verify --quiet refs/remotes/origin/agent/api|0'
fake_lxc_reset_calls
fake_lxc_run_tty '' start moroine/agent-forge api
assert_call 'worktree add .trees/api -b agent/api origin/agent/api'

# 4. Rien n'existe : nouvelle branche depuis origin/main, comme avant.
setup_rules
fake_lxc_reset_calls
fake_lxc_run_tty '' start moroine/agent-forge neuf
assert_call 'worktree add .trees/neuf -b agent/neuf origin/main'

# 5. Tâche absente : menu mélangeant worktrees, branches locales et branches
#    d'origin, plus "nouvelle tâche" et "autre branche".
setup_rules
fake_lxc_exec_rule 'for-each-ref' 0 ''
fake_lxc_reset_rules
fake_lxc_exec_rule 'git worktree list' 0 'worktree /workspace
worktree /workspace/.trees/cli'
fake_lxc_exec_rule "for-each-ref --format='%(refname:short)' refs/heads/agent" 0 'agent/docs'
fake_lxc_exec_rule "for-each-ref --format='%(refname:short)' refs/remotes/origin/agent" 0 'origin/agent/api'
fake_lxc_exec_rule 'test -e /workspace/.trees/' 1
fake_lxc_exec_rule 'show-ref --verify --quiet refs/remotes/origin/agent/api' 0
fake_lxc_exec_rule 'show-ref' 1
fake_lxc_reset_calls
fake_lxc_run_tty $'4\n' start moroine/agent-forge
assert_out 'nouvelle tâche'
assert_out 'cli (worktree existant'
assert_out 'docs (branche locale)'
assert_out 'api (branche sur origin)'
assert_out 'autre branche'
assert_call 'worktree add .trees/api -b agent/api origin/agent/api'

# 6. "autre branche…" : on demande la ref puis le nom de tâche, et la branche
#    de travail reste agent/<task> (le hook pre-bash n'autorise que ça au push).
fake_lxc_reset_calls
fake_lxc_run_tty $'5\norigin/feature/truc\ntruc\n' start moroine/agent-forge
assert_out 'Ref> '
assert_call 'worktree add .trees/truc -b agent/truc origin/feature/truc'

# Hors TTY, une tâche absente reste une erreur d'usage.
if OUT=$(PATH="$FAKE_LXC_BIN:$PATH" bash "$FORGE" start moroine/agent-forge < /dev/null 2>&1); then
  FAIL=$((FAIL + 1)); echo "FAIL: start sans tâche hors TTY devrait échouer"
else
  if grep -qF 'Usage: forge start' <<< "$OUT"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: usage attendu, obtenu: $OUT"; fi
fi

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
