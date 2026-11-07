#!/bin/bash
# .githooks/pre-commit and .githooks/install.sh: only the cases that guard the
# security choices (spec 2026-11-06-open-source-publication-design.md, §3).
# A fake betterleaks records its arguments and environment.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/.githooks/pre-commit"
INSTALL="$ROOT/.githooks/install.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

mkdir -p "$TMP/bin" "$TMP/empty"
cat > "$TMP/bin/betterleaks" <<'EOF'
#!/bin/bash
if [ "$1" = version ]; then echo 1.10.0; exit 0; fi
printf '%s\n' "$@" > "$FAKE_BL_ARGS"
echo "${BETTERLEAKS_VALIDATE-unset} ${BETTERLEAKS_ANALYZE-unset}" > "$FAKE_BL_ENV"
exit "${FAKE_BL_EXIT:-0}"
EOF
chmod 755 "$TMP/bin/betterleaks"
export FAKE_BL_ARGS="$TMP/args" FAKE_BL_ENV="$TMP/env"
# An empty global config: the developer's own (signing key...) never applies.
: > "$TMP/gitconfig"
export GIT_CONFIG_GLOBAL="$TMP/gitconfig" GIT_CONFIG_NOSYSTEM=1

check() {
  local what="$1"
  shift
  if "$@"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: $what"; fi
}

# new_repo <dir>: a throwaway repository with one commit.
new_repo() {
  git init -q -b main "$1"
  git -C "$1" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty --no-gpg-sign -m init
}

# run_hook <repo> <PATH>: sets CODE and ERR (the hook's stderr).
run_hook() {
  CODE=0
  ERR="$(cd "$1" && PATH="$2" "$HOOK" 2>&1 >/dev/null)" || CODE=$?
}

# 1. No Betterleaks: the commit goes through.
new_repo "$TMP/r1"
run_hook "$TMP/r1" "$TMP/empty"
check "missing betterleaks lets the commit through" [ "$CODE" -eq 0 ]
check "missing betterleaks is said" grep -qF "betterleaks is not installed" <<< "$ERR"

# 2. A finding blocks the commit.
new_repo "$TMP/r2"
FAKE_BL_EXIT=1 run_hook "$TMP/r2" "$TMP/bin:/usr/bin:/bin"
check "a finding blocks the commit" [ "$CODE" -ne 0 ]

# 3. Exact arguments: no validation, no trust in the repository's config,
# inline allow comments ignored; the validation switches are removed.
new_repo "$TMP/r3"
BETTERLEAKS_VALIDATE=true BETTERLEAKS_ANALYZE=true run_hook "$TMP/r3" "$TMP/bin:/usr/bin:/bin"
top="$(git -C "$TMP/r3" rev-parse --show-toplevel)"
report="$(grep -xF -A1 -- --report-path "$FAKE_BL_ARGS" | tail -n1)"
check "clean scan passes" [ "$CODE" -eq 0 ]
check "exact arguments" [ "$(cat "$FAKE_BL_ARGS")" = "$(printf '%s\n' git --pre-commit --staged --redact --no-banner --ignore-gitleaks-allow --report-format json --report-path "$report" "$top")" ]
check "validation switches removed" [ "$(cat "$FAKE_BL_ENV")" = "unset unset" ]

# 4. The installer copies the hook into the common hooks directory and never
# sets core.hooksPath.
new_repo "$TMP/r4"
common="$(git -C "$TMP/r4" rev-parse --path-format=absolute --git-common-dir)"
(cd "$TMP/r4" && "$INSTALL" >/dev/null)
check "hook copied and executable" [ -x "$common/hooks/pre-commit" ]
check "copy identical to the source" cmp -s "$HOOK" "$common/hooks/pre-commit"
check "core.hooksPath untouched" [ -z "$(git -C "$TMP/r4" config --get core.hooksPath || true)" ]

# 5. A different existing hook is not overwritten without --force.
new_repo "$TMP/r5"
common="$(git -C "$TMP/r5" rev-parse --path-format=absolute --git-common-dir)"
mkdir -p "$common/hooks"
printf '#!/bin/sh\nexit 0\n' > "$common/hooks/pre-commit"
cp "$common/hooks/pre-commit" "$TMP/before"
code=0
(cd "$TMP/r5" && "$INSTALL" >/dev/null 2>&1) || code=$?
check "refuses to overwrite" [ "$code" -ne 0 ]
check "existing hook untouched" cmp -s "$TMP/before" "$common/hooks/pre-commit"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
