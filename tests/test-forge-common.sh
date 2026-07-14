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

# --- discovery / collision helpers: structural (they call lxc) ---
assert_contains 'user.forge.repo'
assert_contains 'user.forge.mode'
assert_contains 'startswith("agent-")'
assert_contains 'container_for_repo'
assert_contains 'check_container_name_collision'
assert_contains 'require_container_for_repo'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
