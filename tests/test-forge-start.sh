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
assert_contains "$LIB" 'lxc config set "$container" user.forge.mode "autonomous"'
assert_contains "$LIB" 'task_name="${2:-main}"'
assert_contains "$LIB" 'validate_task_name "$task_name"'
assert_contains "$LIB" 'agent/$task_name'
assert_contains "$LIB" 'already exists; task-name'
assert_contains "$LIB" '--permission-mode auto'
assert_contains "$LIB" 'tmux new-session'
assert_line_before "$LIB" 'validate_task_name "$task_name"' 'lxc exec "$container" -- su - aiuser -c "git clone'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
