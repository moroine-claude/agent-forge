#!/bin/bash
# .github/scripts/scan-secrets.sh (CI secret scan of the commits being added)
# and the `secrets` job of .github/workflows/ci.yml. A fake betterleaks stands
# in for the real one: the CI test never needs the binary.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCAN="$ROOT/.github/scripts/scan-secrets.sh"
CI="$ROOT/.github/workflows/ci.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0
CASE=""

# The fake records one argument per line, and the two variables that could
# switch on network validation or analysis.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/betterleaks" <<'EOF'
#!/bin/bash
printf '%s\n' "$@" >> "$FAKE_BL_ARGS"
echo "BETTERLEAKS_VALIDATE=${BETTERLEAKS_VALIDATE-unset}" >> "$FAKE_BL_ENV"
echo "BETTERLEAKS_ANALYZE=${BETTERLEAKS_ANALYZE-unset}" >> "$FAKE_BL_ENV"
exit "${FAKE_BL_EXIT:-0}"
EOF
chmod 755 "$TMP/bin/betterleaks"

pass() { PASS=$((PASS + 1)); }
fail() { FAIL=$((FAIL + 1)); echo "FAIL ($CASE): $*"; }

# check <description> <command...>: passes when the command succeeds.
check() {
  local what="$1"
  shift
  if "$@"; then pass; else fail "$what"; fi
}

has() { grep -qxF -- "$1" "$FAKE_BL_ARGS"; }
contains() { printf '%s' "$1" | grep -qF -- "$2"; }

# begin <case>: a throwaway repo with three commits (C1, C3 = full SHAs) and
# its own empty global git config, so the developer's config never applies.
begin() {
  CASE="$1"
  : > "$TMP/gitconfig-$CASE"
  export GIT_CONFIG_GLOBAL="$TMP/gitconfig-$CASE" GIT_CONFIG_NOSYSTEM=1
  export FAKE_BL_ARGS="$TMP/args-$CASE" FAKE_BL_ENV="$TMP/env-$CASE"
  export FAKE_BL_EXIT=0
  : > "$FAKE_BL_ARGS"
  : > "$FAKE_BL_ENV"
  REPO="$TMP/repo-$CASE"
  git init -q -b main "$REPO"
  local n
  for n in 1 2 3; do
    git -C "$REPO" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty --no-gpg-sign -m "c$n"
  done
  C1="$(git -C "$REPO" rev-parse HEAD~2)"
  C3="$(git -C "$REPO" rev-parse HEAD)"
  TOP="$(git -C "$REPO" rev-parse --show-toplevel)"
}

# run_scan <base> <head>: sets CODE and OUT (stdout and stderr).
run_scan() {
  CODE=0
  OUT="$(cd "$REPO" && PATH="$TMP/bin:/usr/bin:/bin" bash "$SCAN" "$1" "$2" 2>&1)" || CODE=$?
}

bash -n "$SCAN"

ZEROS=0000000000000000000000000000000000000000
UNKNOWN=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef

# Assertions shared by the full-history cases (S2, S3, S4).
assert_full_history() {
  check "$CASE exit 0" [ "$CODE" -eq 0 ]
  check "$CASE message" contains "$OUT" "scanning the full history"
  check "$CASE log-opts" has "--log-opts=$C3"
}

# S1 range
begin S1
run_scan "$C1" "$C3"
check "S1 exit 0" [ "$CODE" -eq 0 ]
check "S1 log-opts" has "--log-opts=$C1..$C3"
check "S1 redact" has --redact
check "S1 no-banner" has --no-banner
check "S1 repo last" [ "$(tail -n1 "$FAKE_BL_ARGS")" = "$TOP" ]
if contains "$OUT" "scanning the full history"; then fail "S1 unexpected full-history message"; else pass; fi

# S2 zeros
begin S2
run_scan "$ZEROS" "$C3"
assert_full_history

# S3 empty base
begin S3
run_scan "" "$C3"
assert_full_history

# S4 unknown base
begin S4
run_scan "$UNKNOWN" "$C3"
assert_full_history

# S5 bad head
begin S5
run_scan "$C1" "$UNKNOWN"
check "S5 exit 2" [ "$CODE" -eq 2 ]
check "S5 message" contains "$OUT" "is not a commit"
check "S5 no scan" [ ! -s "$FAKE_BL_ARGS" ]

# S6 finding
begin S6
FAKE_BL_EXIT=1 run_scan "$C1" "$C3"
check "S6 exit non-zero" [ "$CODE" -ne 0 ]

# S7 safety: validation and analysis are removed from the environment, and no
# flag that enables them (or trusts the repository's own config) is passed.
begin S7
BETTERLEAKS_VALIDATE=true BETTERLEAKS_ANALYZE=true run_scan "$C1" "$C3"
check "S7 env" [ "$(cat "$FAKE_BL_ENV")" = "$(printf 'BETTERLEAKS_VALIDATE=unset\nBETTERLEAKS_ANALYZE=unset')" ]
for flag in --validation -v --verbose --trust-local-git-config --unsafe-auto-load-config; do
  if has "$flag"; then fail "forbidden flag $flag"; else pass; fi
done

# W1 workflow (text checks)
CASE=W1
for text in 'secrets:' 'betterleaks_1.10.0_linux_x64.tar.gz' \
  '9d9ad503cd5d80d18a939352266c3fcca52f10da9b83cd5cfe646989b13940fe' \
  'sha256sum -c' 'fetch-depth: 0' 'persist-credentials: false' \
  '.github/scripts/scan-secrets.sh'; do
  check "W1 contains $text" grep -qF -- "$text" "$CI"
done
check "W1 push branches" [ "$(grep -F 'branches:' "$CI" | sed 's/^ *//')" = "branches: [main]" ]
if grep 'branches:' "$CI" | grep -qw next; then fail "W1 branches mention next"; else pass; fi
if grep -qF -- '--validation' "$CI"; then fail "W1 mentions --validation"; else pass; fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
