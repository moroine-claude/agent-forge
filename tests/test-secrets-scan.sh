#!/bin/bash
# .github/scripts/scan-secrets.sh and the `secrets` job of ci.yml: the range
# scanned (merges included), the full-history fallback, a finding failing the
# job, and the pinned binary. A fake betterleaks records its arguments.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCAN="$ROOT/.github/scripts/scan-secrets.sh"
CI="$ROOT/.github/workflows/ci.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

mkdir -p "$TMP/bin"
cat > "$TMP/bin/betterleaks" <<'EOF'
#!/bin/bash
printf '%s\n' "$@" > "$FAKE_BL_ARGS"
exit "${FAKE_BL_EXIT:-0}"
EOF
chmod 755 "$TMP/bin/betterleaks"
export FAKE_BL_ARGS="$TMP/args"
# An empty global config: the developer's own (signing key...) never applies.
: > "$TMP/gitconfig"
export GIT_CONFIG_GLOBAL="$TMP/gitconfig" GIT_CONFIG_NOSYSTEM=1

check() {
  local what="$1"
  shift
  if "$@"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: $what"; fi
}

# A throwaway repository with three commits.
REPO="$TMP/repo"
git init -q -b main "$REPO"
for n in 1 2 3; do
  git -C "$REPO" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty --no-gpg-sign -m "c$n"
done
C1="$(git -C "$REPO" rev-parse HEAD~2)"
C3="$(git -C "$REPO" rev-parse HEAD)"

# run_scan <base> <head>: sets CODE.
run_scan() {
  CODE=0
  (cd "$REPO" && PATH="$TMP/bin:/usr/bin:/bin" bash "$SCAN" "$1" "$2" >/dev/null 2>&1) || CODE=$?
}
has() { grep -qxF -- "$1" "$FAKE_BL_ARGS"; }

# 1. The range of the added commits, merges included.
run_scan "$C1" "$C3"
check "range scanned, merges included" has "--log-opts=--diff-merges=remerge $C1..$C3"

# 2. A base unknown to the repository (force push): the full history.
run_scan deadbeefdeadbeefdeadbeefdeadbeefdeadbeef "$C3"
check "unknown base scans the full history" has "--log-opts=--diff-merges=remerge $C3"

# 3. A finding fails the job.
FAKE_BL_EXIT=1 run_scan "$C1" "$C3"
check "a finding fails the job" [ "$CODE" -ne 0 ]

# 4. The workflow installs the pinned binary and checks its checksum.
check "pinned binary" grep -qF betterleaks_1.10.0_linux_x64.tar.gz "$CI"
check "checksum checked" grep -qF '9d9ad503cd5d80d18a939352266c3fcca52f10da9b83cd5cfe646989b13940fe' "$CI"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
