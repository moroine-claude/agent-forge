#!/bin/bash
# Vérifie que toutes les sous-commandes sont bien câblées dans scripts/forge
# (chaque forge-*.sh sourcé, chaque case branchée), et que --help/absence
# d'argument n'explosent pas. Lancer : bash tests/test-forge-dispatcher.sh
set -e

FORGE="$(cd "$(dirname "$0")/.." && pwd)/scripts/forge"
PASS=0
FAIL=0

assert_contains() {
  if grep -qF -- "$1" "$FORGE"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu présent): $1"
  fi
}

echo "bash -n syntax check..."
bash -n "$FORGE"

for lib in forge-common forge-start forge-resume forge-stop forge-delete forge-list forge-image forge-completion; do
  assert_contains "source \"\$FORGE_LIB_DIR/$lib.sh\""
done

for cmd in 'start)' 'resume)' 'stop)' 'delete)' 'list)' 'image)' 'completion)'; do
  assert_contains "$cmd"
done

echo "forge --help runs without error..."
if "$FORGE" --help > /dev/null 2>&1; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL: forge --help exited non-zero"
fi

echo "forge with no args runs without error..."
if "$FORGE" > /dev/null 2>&1; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL: forge with no args exited non-zero"
fi

echo "forge with unknown command exits non-zero..."
if "$FORGE" bogus > /dev/null 2>&1; then
  FAIL=$((FAIL + 1))
  echo "FAIL: forge bogus should have failed"
else
  PASS=$((PASS + 1))
fi

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
