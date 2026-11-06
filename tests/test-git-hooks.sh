#!/bin/bash
# .githooks/pre-commit (secret scan with Betterleaks) and .githooks/install.sh.
# A fake betterleaks stands in for the real one, except in case R1, which uses
# the real binary when a 1.x is installed (else it is skipped).
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/.githooks/pre-commit"
INSTALL="$ROOT/.githooks/install.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0
CASE=""

mkdir -p "$TMP/bin"
cat > "$TMP/bin/betterleaks" <<'EOF'
#!/bin/bash
if [ "$1" = version ]; then
  echo "$FAKE_BL_VERSION"
  exit 0
fi
printf '%s\n' "$@" >> "$FAKE_BL_ARGS"
echo "BETTERLEAKS_VALIDATE=${BETTERLEAKS_VALIDATE-unset}" >> "$FAKE_BL_ENV"
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

# begin <case> <repo dir> [branch]: a throwaway repo with its own empty global
# git config, so the developer's own config (signing key...) never applies.
begin() {
  CASE="$1"
  : > "$TMP/gitconfig-$CASE"
  export GIT_CONFIG_GLOBAL="$TMP/gitconfig-$CASE" GIT_CONFIG_NOSYSTEM=1
  export FAKE_BL_ARGS="$TMP/args-$CASE" FAKE_BL_ENV="$TMP/env-$CASE"
  export FAKE_BL_VERSION=1.10.0 FAKE_BL_EXIT=0
  : > "$FAKE_BL_ARGS"
  : > "$FAKE_BL_ENV"
  mkdir -p "$2"
  git init -q -b "${3:-main}" "$2"
  git -C "$2" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty --no-gpg-sign -m init
}

# run_hook <repo> [PATH]: sets CODE and ERR (stderr of the hook).
run_hook() {
  CODE=0
  ERR="$(cd "$1" && PATH="${2:-$TMP/bin:/usr/bin:/bin}" "$HOOK" 2>&1 >/dev/null)" || CODE=$?
}

# run_install <repo> [args...]: sets CODE and OUT (stdout and stderr).
run_install() {
  local repo="$1"
  shift
  CODE=0
  OUT="$(cd "$repo" && "$INSTALL" "$@" 2>&1)" || CODE=$?
}

has() { grep -qxF -- "$1" "$FAKE_BL_ARGS"; }
contains() { printf '%s' "$1" | grep -qF -- "$2"; }

bash -n "$HOOK"
bash -n "$INSTALL"

# Assertions shared by the clean runs (H3, H7).
assert_clean_run() {
  local repo="$1" top
  top="$(git -C "$repo" rev-parse --show-toplevel)"
  check "$CASE exit 0" [ "$CODE" -eq 0 ]
  check "$CASE argv" [ "$(cat "$FAKE_BL_ARGS")" = "$(printf '%s\n' git --pre-commit --staged --redact --no-banner "$top")" ]
  local flag
  for flag in --validation -v --verbose --trust-local-git-config --unsafe-auto-load-config --gitleaks-ignore-path; do
    if has "$flag"; then fail "forbidden or unexpected flag $flag"; else pass; fi
  done
}

# H1 missing binary
begin H1 "$TMP/h1"
run_hook "$TMP/h1" /usr/bin:/bin
check "H1 exit 0" [ "$CODE" -eq 0 ]
check "H1 message" contains "$ERR" "pre-commit: betterleaks is not installed, the secret scan is skipped (CI still runs it). See CONTRIBUTING.md."

# H2 other major
begin H2 "$TMP/h2"
FAKE_BL_VERSION=2.0.0 run_hook "$TMP/h2"
check "H2 exit 0" [ "$CODE" -eq 0 ]
check "H2 message" contains "$ERR" "pre-commit: betterleaks 2.0.0 is not 1.x, the secret scan is skipped (CI still runs it). See CONTRIBUTING.md."
check "H2 no scan" [ ! -s "$FAKE_BL_ARGS" ]

# H3 clean
begin H3 "$TMP/h3"
run_hook "$TMP/h3"
assert_clean_run "$TMP/h3"

# H4 finding
begin H4 "$TMP/h4"
FAKE_BL_EXIT=1 run_hook "$TMP/h4"
check "H4 exit non-zero" [ "$CODE" -ne 0 ]
check "H4 message" contains "$ERR" "pre-commit: betterleaks found a possible secret in the staged changes. See CONTRIBUTING.md for false positives."

# H5 ignore file
begin H5 "$TMP/h5"
: > "$TMP/h5/.betterleaksignore"
run_hook "$TMP/h5"
top="$(git -C "$TMP/h5" rev-parse --show-toplevel)"
check "H5 exit 0" [ "$CODE" -eq 0 ]
check "H5 ignore flag" [ "$(grep -xF -A1 -- --gitleaks-ignore-path "$FAKE_BL_ARGS" | tail -n1)" = "$top/.betterleaksignore" ]

# H6 validation env is removed
begin H6 "$TMP/h6"
BETTERLEAKS_VALIDATE=true BETTERLEAKS_ANALYZE=true run_hook "$TMP/h6"
check "H6 env" [ "$(cat "$FAKE_BL_ENV")" = "BETTERLEAKS_VALIDATE=unset" ]

# H7 space in path
begin H7 "$TMP/with space/repo"
run_hook "$TMP/with space/repo"
assert_clean_run "$TMP/with space/repo"

# I1 fresh install
begin I1 "$TMP/i1"
run_install "$TMP/i1"
common="$(git -C "$TMP/i1" rev-parse --path-format=absolute --git-common-dir)"
check "I1 exit 0" [ "$CODE" -eq 0 ]
check "I1 output" [ "$OUT" = "installed $common/hooks/pre-commit" ]
check "I1 executable" [ -x "$common/hooks/pre-commit" ]
check "I1 identical" cmp -s "$HOOK" "$common/hooks/pre-commit"
check "I1 no hooksPath" [ -z "$(git -C "$TMP/i1" config --get core.hooksPath || true)" ]
if contains "$OUT" "not main"; then fail "I1 unexpected branch warning"; else pass; fi

# I2 rerun
run_install "$TMP/i1"
check "I2 exit 0" [ "$CODE" -eq 0 ]
check "I2 output" contains "$OUT" "already installed:"

# I3 different hook
begin I3 "$TMP/i3"
common="$(git -C "$TMP/i3" rev-parse --path-format=absolute --git-common-dir)"
mkdir -p "$common/hooks"
printf '#!/bin/sh\nexit 0\n' > "$common/hooks/pre-commit"
cp "$common/hooks/pre-commit" "$TMP/i3-before"
run_install "$TMP/i3"
check "I3 exit non-zero" [ "$CODE" -ne 0 ]
check "I3 output" contains "$OUT" "a different pre-commit hook exists at $common/hooks/pre-commit; rerun with --force to replace it"
check "I3 untouched" cmp -s "$TMP/i3-before" "$common/hooks/pre-commit"
run_install "$TMP/i3" --force
check "I3 force exit 0" [ "$CODE" -eq 0 ]
check "I3 force identical" cmp -s "$HOOK" "$common/hooks/pre-commit"

# I4 linked worktree
begin I4 "$TMP/i4"
git -C "$TMP/i4" worktree add -q "$TMP/wt" -b side
run_install "$TMP/wt"
common="$(git -C "$TMP/i4" rev-parse --path-format=absolute --git-common-dir)"
check "I4 exit 0" [ "$CODE" -eq 0 ]
check "I4 hook in main repo" [ -x "$common/hooks/pre-commit" ]
check "I4 not under worktrees" [ ! -e "$common/worktrees/wt/hooks/pre-commit" ]
wttop="$(git -C "$TMP/wt" rev-parse --show-toplevel)"
echo x > "$TMP/wt/file"
git -C "$TMP/wt" add file
# The hook runs with the fake betterleaks first on PATH.
(cd "$TMP/wt" && PATH="$TMP/bin:/usr/bin:/bin" git -c user.name=t -c user.email=t@example.invalid commit -q --no-gpg-sign -m wt)
check "I4 hook ran in worktree" [ "$(tail -n1 "$FAKE_BL_ARGS")" = "$wttop" ]

# I5 global hooksPath
begin I5 "$TMP/i5"
printf '[core]\n\thooksPath = /nonexistent\n' > "$GIT_CONFIG_GLOBAL"
run_install "$TMP/i5"
check "I5 warning" contains "$OUT" "warning: core.hooksPath is set to /nonexistent"

# I6 branch
begin I6 "$TMP/i6" side
run_install "$TMP/i6"
check "I6 warning" contains "$OUT" "warning: installing the hook from side, not main"

# R1 real Betterleaks
if command -v betterleaks >/dev/null 2>&1 && betterleaks version 2>/dev/null | head -n1 | grep -q '^v\{0,1\}1\.'; then
  begin R1 "$TMP/r1"
  run_install "$TMP/r1"
  # Random token built at run time, never stored in the repo.
  token="ghp_$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 36)"
  printf 'token = "%s"\n' "$token" > "$TMP/r1/secret.txt"
  git -C "$TMP/r1" add secret.txt
  code=0
  (cd "$TMP/r1" && git -c user.name=t -c user.email=t@example.invalid commit -q --no-gpg-sign -m leak >/dev/null 2>&1) || code=$?
  check "R1 commit with secret fails" [ "$code" -ne 0 ]
  git -C "$TMP/r1" reset -q
  code=0
  (cd "$TMP/r1" && git -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty --no-gpg-sign -m ok >/dev/null 2>&1) || code=$?
  check "R1 empty commit passes" [ "$code" -eq 0 ]
else
  echo "SKIP R1: betterleaks 1.x not installed"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
