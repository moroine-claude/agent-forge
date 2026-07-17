#!/bin/bash
# Tests structurels de scripts/forge (dispatch "image") et
# scripts/lib/forge-image.sh. Lancer : bash tests/test-forge-image.sh
set -e

FORGE="$(cd "$(dirname "$0")/.." && pwd)/scripts/forge"
LIB="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/forge-image.sh"
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

assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-image.sh"'
assert_contains "$FORGE" 'image)'
assert_contains "$FORGE" 'cmd_forge_image "$@"'

assert_contains "$LIB" 'build|update'
assert_contains "$LIB" 'agent-base-setup'
assert_contains "$LIB" 'next-task.sh'
assert_contains "$LIB" 'lxc publish'
assert_line_before "$LIB" 'Removing leftover' 'lxc launch ubuntu:24.04'
assert_contains "$LIB" 'docker-ce-rootless-extras'
assert_contains "$LIB" 'docker-compose-plugin'
assert_contains "$LIB" 'add-subuids'
assert_contains "$LIB" 'add-subgids'
assert_contains "$LIB" 'enable-linger aiuser'
assert_contains "$LIB" 'dockerd-rootless-setuptool.sh install'
assert_contains "$LIB" 'systemctl --user enable docker'
assert_contains "$LIB" 'DOCKER_HOST=unix:///run/user/1001/docker.sock'
assert_line_before "$LIB" 'useradd -m -s /bin/bash aiuser' 'add-subuids'
assert_line_before "$LIB" 'add-subuids' 'dockerd-rootless-setuptool.sh install'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
