# Supervised Git Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second `forge start` mode, `supervised`, in which a container never holds any GitHub credential (read or write) — the human clones the repo on the host, retrieves the agent's local commits to their laptop over SSH, reviews every line, and publishes under their own identity.

**Architecture:** A single decision — the mode, chosen once at provisioning time via an interactive prompt in `forge start` — is recorded in two places for two different execution contexts: the LXD container config key `user.forge.mode` (read by **host**-side scripts: `forge_check_wip` in `forge-common.sh`, `forge list`) and a plain-text marker file `/home/aiuser/.claude/forge-mode` inside the container (read by **container**-side scripts that have no `lxc` access: `pre-bash.sh`, `next-task`, and `templates/CLAUDE.md`'s own instructions to the agent). Both are written from the same `$mode` variable in `forge-start.sh` at provisioning time and never diverge.

**Tech Stack:** Bash (strict mode), `jq`, LXD (`lxc`), `git`, `gh` (installed but unauthenticated in supervised containers).

## Global Constraints

- Bash strict mode (`set -e`) in every script; quote all variable expansions (`"$VAR"`, never `$VAR`).
- Comment non-obvious blocks; test preconditions at the top of a function before it mutates anything.
- Never hardcode credentials, keys, or tokens. SSH keys are mounted from the host, never baked into `agent-base`.
- Supervised containers get **no** GitHub credential of any kind — no PAT, no `gh auth login`, no deploy key. This is the property every task in this plan protects.
- A missing/absent mode marker or config key always defaults to today's autonomous behavior — existing containers provisioned before this change must keep working unmodified.
- Tests in this repo are grep-based structural assertions (`assert_contains`/`assert_not_contains`/`assert_line_before`) plus `bash -n`, run directly with `bash tests/test-*.sh` — there's no test runner script and no CI config. Pure-bash functions (no `lxc` dependency) are executed for real, with `lxc` mocked as a shell function where needed. `pre-bash.sh` is executed for real (it never calls `lxc`). `forge-start.sh` and `next-task` remain structural-only (grep + `bash -n`) — this dev environment has no LXD access and `next-task` hardcodes `cd /workspace`, which is this very repo checkout, so it can't be run for real here either.

---

## Task 1: Baseline cleanup — fix pre-existing stale test assertions

Before adding anything new, get the suite to a clean, fully-green baseline. Two test files currently fail for reasons unrelated to this feature (confirmed by running `bash tests/test-forge-start.sh` and `bash tests/test-forge-delete.sh` today): `test-forge-start.sh` expects a stale default task-name (`main` instead of the actual, documented `init`), and `test-forge-delete.sh` tests a function name (`_forge_check_wip_before_delete`) that was refactored into `forge-common.sh`'s shared `forge_check_wip` and never removed from the old test file. This task fixes both, moving the orphaned injection-safety regression test to where the code it tests actually lives.

**Files:**
- Modify: `tests/test-forge-start.sh:70`
- Modify: `tests/test-forge-delete.sh:29-70`
- Modify: `tests/test-forge-common.sh` (append moved regression test)

**Interfaces:**
- Consumes: `forge_check_wip(container)` — existing function in `scripts/lib/forge-common.sh`, unchanged in this task.
- Produces: a fully green baseline (`PASS=N FAIL=0` for every `tests/test-*.sh`) for later tasks to build on.

- [ ] **Step 1: Confirm the current failures**

Run: `bash tests/test-forge-start.sh 2>&1 | tail -5 && bash tests/test-forge-delete.sh 2>&1 | tail -6`
Expected:
```
FAIL (attendu présent dans /workspace/scripts/lib/forge-start.sh): task_name="${2:-main}"

PASS=22 FAIL=1
FAIL (attendu présent dans /workspace/scripts/lib/forge-delete.sh): _forge_check_wip_before_delete
FAIL (attendu présent dans /workspace/scripts/lib/forge-delete.sh): [[ ! "$branch" =~ ^agent/[A-Za-z0-9._-]+$ ]]
FAIL (attendu présent dans /workspace/scripts/lib/forge-delete.sh): git rev-parse --verify origin/$branch

PASS=8 FAIL=4
```

- [ ] **Step 2: Fix the stale default-task-name assertion**

In `tests/test-forge-start.sh`, change:
```bash
assert_contains "$LIB" 'task_name="${2:-main}"'
```
to:
```bash
assert_contains "$LIB" 'task_name="${2:-init}"'
```
(`scripts/lib/forge-start.sh` already defaults to `init`, matching README's documented behavior — the test was wrong, not the code.)

- [ ] **Step 3: Run test-forge-start.sh, confirm it's green**

Run: `bash tests/test-forge-start.sh 2>&1 | tail -3`
Expected: `PASS=23 FAIL=0` (the same 23 total assertions as before — one of them now passes instead of failing).

- [ ] **Step 4: Replace the stale WIP-check assertions in test-forge-delete.sh**

In `tests/test-forge-delete.sh`, replace the entire block from the `assert_contains "$LIB" 'require_container_for_repo'` line through the end of the file with:

```bash
assert_contains "$LIB" 'require_container_for_repo'
assert_contains "$LIB" '--force'
assert_contains "$LIB" 'forge_check_wip "$container"'
assert_contains "$LIB" 'lxc delete "$container" --force'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

This drops the assertions on `_forge_check_wip_before_delete` and its inlined regex checks (that logic now lives in `forge_check_wip` in `forge-common.sh`, not in `forge-delete.sh`), and drops the injection-safety regression block that called the now-nonexistent local function — it's moved to `test-forge-common.sh` in the next step, next to the function it actually exercises.

- [ ] **Step 5: Move the injection-safety regression to test-forge-common.sh**

Append to the end of `tests/test-forge-common.sh`, right before the final `echo ""` / `PASS=$PASS FAIL=$FAIL` block:

```bash
# --- regression (moved from test-forge-delete.sh after forge_check_wip was
# centralized here): a malicious branch name must not be interpolated into
# a further lxc exec call, and must block forge_check_wip rather than being
# silently treated as safe ---
lxc() {
  case "$*" in
    "exec evil-container -- su - aiuser -c cd /workspace && git status --porcelain")
      echo ""
      ;;
    "exec evil-container -- su - aiuser -c cd /workspace && git rev-parse --abbrev-ref HEAD")
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
```

(No `user.forge.mode` mock case is needed yet — at this point in the plan, `forge_check_wip` doesn't call `forge_container_mode` yet. Task 2 will update this exact block when that changes.)

- [ ] **Step 6: Run both test files, confirm green**

Run: `bash tests/test-forge-delete.sh 2>&1 | tail -3 && bash tests/test-forge-common.sh 2>&1 | tail -3`
Expected:
```
PASS=4 FAIL=0
PASS=20 FAIL=0
```

- [ ] **Step 7: Run the full suite as a final baseline check**

Run: `for f in tests/test-*.sh; do bash "$f" > /tmp/t.out 2>&1 || { echo "=== $f FAILED ==="; cat /tmp/t.out; }; done; echo done`
Expected: `done` with no `FAILED` lines printed.

- [ ] **Step 8: Commit**

```bash
git add tests/test-forge-start.sh tests/test-forge-delete.sh tests/test-forge-common.sh
git commit -m "test: fix stale assertions predating the forge_check_wip refactor"
```

---

## Task 2: Mode-aware `forge_check_wip`

`forge stop`/`forge delete` currently refuse to proceed if the container's branch is ahead of `origin/main` with no matching `origin/<branch>` — meaning "this has been pushed." Supervised containers never push (no credential), so that condition would be permanently true and block every stop/delete. Fix: `forge_check_wip` checks `user.forge.mode` and, for supervised containers, only enforces the dirty-tree check.

**Files:**
- Modify: `scripts/lib/forge-common.sh` (the `forge_check_wip` function)
- Test: `tests/test-forge-common.sh`

**Interfaces:**
- Consumes: `forge_container_mode(container)` — existing function, returns the container's `user.forge.mode` value (empty string if unset).
- Produces: `forge_check_wip(container)` — same signature and same "return 0 = safe to proceed, return 1 = blocked" contract as before; new behavior only for `mode = "supervised"`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test-forge-common.sh`, right after the injection-safety regression block added in Task 1 (before the final `echo ""` / `PASS=$PASS FAIL=$FAIL`):

```bash
# --- forge_check_wip: supervised mode only checks the dirty tree; being
# ahead of main with no origin/<branch> is expected steady state there,
# not something to block on (there is no credential to have pushed with) ---
lxc() {
  case "$*" in
    "config get sup-dirty user.forge.mode")
      echo "supervised"
      ;;
    "exec sup-dirty -- su - aiuser -c cd /workspace && git status --porcelain")
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
    "exec sup-clean-ahead -- su - aiuser -c cd /workspace && git status --porcelain")
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
    "exec auto-ahead-unpushed -- su - aiuser -c cd /workspace && git status --porcelain")
      echo ""
      ;;
    "exec auto-ahead-unpushed -- su - aiuser -c cd /workspace && git rev-parse --abbrev-ref HEAD")
      echo "agent/foo"
      ;;
    "exec auto-ahead-unpushed -- su - aiuser -c cd /workspace && git log --oneline origin/main..agent/foo")
      echo "abc1234 feat: x"
      ;;
    "exec auto-ahead-unpushed -- su - aiuser -c cd /workspace && git rev-parse --verify origin/agent/foo")
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
```

Also update the injection-safety regression added in Task 1 (the `evil-container` block) to add the now-required `user.forge.mode` mock case — without it, `forge_container_mode`'s underlying `lxc config get` call falls through to the mock's `*)` branch, which does `return 1`, and since that happens inside a plain `mode=$(...)` assignment, `set -e` would abort the whole test script:

Change:
```bash
lxc() {
  case "$*" in
    "exec evil-container -- su - aiuser -c cd /workspace && git status --porcelain")
      echo ""
      ;;
    "exec evil-container -- su - aiuser -c cd /workspace && git rev-parse --abbrev-ref HEAD")
      echo 'x$(touch /tmp/PWNED_test)y'
      ;;
    *)
      echo "unexpected lxc call: $*" >&2
      return 1
      ;;
  esac
}
```
to:
```bash
lxc() {
  case "$*" in
    "exec evil-container -- su - aiuser -c cd /workspace && git status --porcelain")
      echo ""
      ;;
    "config get evil-container user.forge.mode")
      echo ""
      ;;
    "exec evil-container -- su - aiuser -c cd /workspace && git rev-parse --abbrev-ref HEAD")
      echo 'x$(touch /tmp/PWNED_test)y'
      ;;
    *)
      echo "unexpected lxc call: $*" >&2
      return 1
      ;;
  esac
}
```

- [ ] **Step 2: Run test-forge-common.sh, confirm the new assertions fail**

Run: `bash tests/test-forge-common.sh 2>&1 | tail -10`
Expected: the script aborts partway (before reaching the final PASS/FAIL echo) once it hits the `evil-container` block, because `forge_check_wip` doesn't yet call `forge_container_mode` and the new `sup-dirty`/`sup-clean-ahead` mocks' `"config get ... user.forge.mode"` cases are never consulted (current `forge_check_wip` never queries mode, so it proceeds straight to the branch-name check, which the `sup-dirty`/`sup-clean-ahead` mocks don't stub — those mocks only stub the `git status --porcelain` and `user.forge.mode` calls) — the missing branch-name mock hits `*)`, prints `unexpected lxc call`, returns 1, and (for `sup-clean-ahead`, inside a plain `branch=$(...)` assignment) trips `set -e`.

- [ ] **Step 3: Implement the mode-aware `forge_check_wip`**

In `scripts/lib/forge-common.sh`, replace the entire `forge_check_wip` function with:

```bash
# WIP pre-flight: checks dirty tree, and (autonomous mode only) branch name
# and unpushed commits. Container must be running. Used by both stop and
# delete. Supervised containers never have anything to "push" — no
# credential exists inside them — so only the dirty-tree check applies
# there; commits ahead of main are expected steady state, not something to
# block on (the workspace directory is host-mounted and survives
# lxc delete regardless of this check).
forge_check_wip() {
  local container="$1" dirty branch unpushed mode

  dirty=$(lxc exec "$container" -- su - aiuser -c "cd /workspace && git status --porcelain")
  if [ -n "$dirty" ]; then
    echo "Error: $container has uncommitted changes in /workspace:" >&2
    echo "$dirty" >&2
    echo "Commit/discard them, or pass --force." >&2
    return 1
  fi

  mode=$(forge_container_mode "$container")
  if [ "$mode" = "supervised" ]; then
    return 0
  fi

  branch=$(lxc exec "$container" -- su - aiuser -c "cd /workspace && git rev-parse --abbrev-ref HEAD")
  if [[ ! "$branch" =~ ^agent/[A-Za-z0-9._-]+$ ]]; then
    echo "Error: unexpected branch name '$branch' in $container; refusing to proceed." >&2
    return 1
  fi

  local ahead_of_main
  ahead_of_main=$(lxc exec "$container" -- su - aiuser -c "cd /workspace && git log --oneline origin/main..$branch")
  if [ -n "$ahead_of_main" ]; then
    if ! lxc exec "$container" -- su - aiuser -c "cd /workspace && git rev-parse --verify origin/$branch" > /dev/null 2>&1; then
      echo "Error: $container's branch $branch has no origin/$branch — it has never been pushed." >&2
      echo "Push it, or pass --force." >&2
      return 1
    fi

    unpushed=$(lxc exec "$container" -- su - aiuser -c "cd /workspace && git log --oneline origin/$branch..$branch")
    if [ -n "$unpushed" ]; then
      echo "Error: $container has unpushed commits on $branch:" >&2
      echo "$unpushed" >&2
      echo "Push them, or pass --force." >&2
      return 1
    fi
  fi
}
```

- [ ] **Step 4: Run test-forge-common.sh, confirm it passes**

Run: `bash tests/test-forge-common.sh 2>&1 | tail -3`
Expected: `PASS=23 FAIL=0`

- [ ] **Step 5: Run the full suite as a regression check**

Run: `for f in tests/test-*.sh; do bash "$f" > /tmp/t.out 2>&1 || { echo "=== $f FAILED ==="; cat /tmp/t.out; }; done; echo done`
Expected: `done` with no `FAILED` lines.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/forge-common.sh tests/test-forge-common.sh
git commit -m "feat: make forge_check_wip mode-aware for supervised containers"
```

---

## Task 3: Mode-aware `pre-bash.sh` — block all push/gh in supervised mode

The hook currently allows `git push origin agent/*` and a subset of `gh` subcommands (everything except `pr merge`/`api`/`repo`/`alias`/`extension`/`auth token`). In supervised mode neither has a legitimate target — there is no credential — so both must be blocked unconditionally. This task also establishes the `FORGE_MODE_FILE` convention (default path `/home/aiuser/.claude/forge-mode`, overridable via environment variable for tests) that Task 4 (`next-task`) and Task 5 (`forge-start.sh`, which writes the file) both build on.

**Files:**
- Modify: `.claude/hooks/pre-bash.sh`
- Test: `tests/test-pre-bash.sh`

**Interfaces:**
- Produces: `FORGE_MODE_FILE` environment variable convention — if set, `pre-bash.sh` reads the mode from that path instead of the real default `/home/aiuser/.claude/forge-mode`. File content is exactly `autonomous` or `supervised`; a missing file means `autonomous`. Task 4 and Task 5 depend on this exact path and convention.

- [ ] **Step 1: Write the failing tests**

In `tests/test-pre-bash.sh`, add this helper block right after the existing `expect_block()` function definition (before the `# --- git push` comment):

```bash
MODE_FILE=$(mktemp)
trap 'rm -f "$MODE_FILE"' EXIT

run_hook_as() {
  local mode="$1" cmd="$2"
  printf '%s' "$mode" > "$MODE_FILE"
  FORGE_MODE_FILE="$MODE_FILE" run_hook "$cmd"
}

expect_allow_as() {
  local mode="$1" cmd="$2" rc=0
  run_hook_as "$mode" "$cmd" || rc=$?
  if [ "$rc" -eq 0 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu ALLOW mode=$mode, rc=$rc): $cmd"
  fi
}

expect_block_as() {
  local mode="$1" cmd="$2" rc=0
  run_hook_as "$mode" "$cmd" || rc=$?
  if [ "$rc" -eq 2 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu BLOCK mode=$mode, rc=$rc): $cmd"
  fi
}
```

Then add this block right before the final `echo ""` / `echo "PASS: $PASS  FAIL: $FAIL"`:

```bash
# --- supervised mode: no credential exists, so every push and every gh
# subcommand is blocked, including forms autonomous mode explicitly allows ---
expect_block_as supervised 'git push origin agent/test-project'
expect_block_as supervised 'git push -u origin agent/test-project'
expect_block_as supervised 'git push origin main'
expect_block_as supervised 'gh pr create --base main --title "x" --body "y"'
expect_block_as supervised 'gh pr view 42'
expect_block_as supervised 'gh auth status'

# --- autonomous mode, explicit: unchanged from the default behavior above ---
expect_allow_as autonomous 'git push origin agent/test-project'
expect_block_as autonomous 'git push origin main'
expect_allow_as autonomous 'gh pr create --base main --title "x" --body "y"'
expect_block_as autonomous 'gh pr merge 42'

# --- ordinary commands stay allowed in supervised mode too ---
expect_allow_as supervised 'git status'
expect_allow_as supervised 'git commit -m "feat: x"'

# --- missing marker file defaults to autonomous (existing containers,
# provisioned before this feature, keep working unmodified) ---
rc=0
FORGE_MODE_FILE="$MODE_FILE.does-not-exist" run_hook 'git push origin agent/test-project' || rc=$?
if [ "$rc" -eq 0 ]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "FAIL (attendu ALLOW, missing marker file should default to autonomous, rc=$rc)"
fi
```

- [ ] **Step 2: Run test-pre-bash.sh, confirm the new assertions fail**

Run: `bash tests/test-pre-bash.sh 2>&1 | tail -20`
Expected: `PASS: 68  FAIL: 5`. The hook doesn't read `FORGE_MODE_FILE` yet, so every command is still evaluated under today's single unconditional policy — which already matches "autonomous" exactly. That means most of the new assertions pass immediately (the `autonomous`-mode ones, the `supervised`-mode ordinary-command ones, and the missing-marker-file one, since they're only re-asserting today's existing behavior), and one of the six `expect_block_as supervised` lines (`git push origin main`) already passes too — it's refused today regardless of mode by the existing default-deny-non-agent/* policy. Only the five checks that require genuinely new behavior fail:
```
FAIL (attendu BLOCK mode=supervised, rc=0): git push origin agent/test-project
FAIL (attendu BLOCK mode=supervised, rc=0): git push -u origin agent/test-project
FAIL (attendu BLOCK mode=supervised, rc=0): gh pr create --base main --title "x" --body "y"
FAIL (attendu BLOCK mode=supervised, rc=0): gh pr view 42
FAIL (attendu BLOCK mode=supervised, rc=0): gh auth status
```

- [ ] **Step 3: Implement the mode-aware blocking**

In `.claude/hooks/pre-bash.sh`, insert this right after the `block()` function definition (before the `# Politique git push` comment):

```bash
# Mode du container : "autonomous" (défaut) ou "supervised". Le fichier
# marqueur est écrit une fois par forge start ; FORGE_MODE_FILE est
# overridable pour les tests (le hook tourne en dur sur le chemin container
# en usage réel).
FORGE_MODE_FILE="${FORGE_MODE_FILE:-/home/aiuser/.claude/forge-mode}"
FORGE_MODE=$(cat "$FORGE_MODE_FILE" 2>/dev/null || echo autonomous)
```

Then change the top of the git-push block from:
```bash
GIT_PUSH_RE='git[[:space:]]+(-[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?[[:space:]]+)*push([[:space:];&|]|$)'
if echo "$COMMAND" | grep -qE "$GIT_PUSH_RE"; then
  # Force push interdit (préserve l'historique de la branche agent)
```
to:
```bash
GIT_PUSH_RE='git[[:space:]]+(-[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?[[:space:]]+)*push([[:space:];&|]|$)'
if echo "$COMMAND" | grep -qE "$GIT_PUSH_RE"; then
  # Container supervisé : aucune credential GitHub n'existe jamais ici, donc
  # aucun push n'a de cible légitime. Bloqué sans exception, avant même les
  # politiques par forme ci-dessous (qui ne s'appliquent qu'en autonomous).
  if [ "$FORGE_MODE" = "supervised" ]; then
    block "git push non autorisé : container supervisé, aucune credential GitHub n'existe."
  fi
  # Force push interdit (préserve l'historique de la branche agent)
```

Then change the top of the gh block from:
```bash
# gh : l'agent crée et met à jour des PRs, ne merge jamais, ne parle jamais
# à l'API brute, ne touche ni aux repos, ni aux alias, ni aux extensions,
# et ne lit jamais le token.
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])gh[[:space:]]+pr[[:space:]]+(-[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?[[:space:]]+)*merge([[:space:];&|]|$)'; then
```
to:
```bash
# gh : en mode supervised, aucune credential n'existe, donc aucune
# sous-commande gh n'a d'usage légitime — bloqué sans exception, avant les
# règles par sous-commande ci-dessous (qui ne s'appliquent qu'en autonomous).
if [ "$FORGE_MODE" = "supervised" ] && echo "$COMMAND" | grep -qE '(^|[[:space:];&|])gh([[:space:]]|$)'; then
  block "gh non autorisé : container supervisé, gh n'est jamais authentifié."
fi

# gh (mode autonomous) : l'agent crée et met à jour des PRs, ne merge jamais,
# ne parle jamais à l'API brute, ne touche ni aux repos, ni aux alias, ni aux
# extensions, et ne lit jamais le token.
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])gh[[:space:]]+pr[[:space:]]+(-[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?[[:space:]]+)*merge([[:space:];&|]|$)'; then
```

- [ ] **Step 4: Run test-pre-bash.sh, confirm it passes**

Run: `bash tests/test-pre-bash.sh 2>&1 | tail -3`
Expected: `PASS: 73  FAIL: 0`

- [ ] **Step 5: Run the full suite as a regression check**

Run: `for f in tests/test-*.sh; do bash "$f" > /tmp/t.out 2>&1 || { echo "=== $f FAILED ==="; cat /tmp/t.out; }; done; echo done`
Expected: `done` with no `FAILED` lines.

- [ ] **Step 6: Commit**

```bash
git add .claude/hooks/pre-bash.sh tests/test-pre-bash.sh
git commit -m "feat: block all git push and gh commands in supervised mode"
```

---

## Task 4: Mode-aware `next-task`

`next-task` currently does `git fetch origin` and requires an `origin/<branch>` ref before allowing reuse of a container whose branch is ahead of main — both assume a credential supervised containers will never have. Fix: read the same `FORGE_MODE_FILE` marker from Task 3; in supervised mode, skip the unpushed-commits gate and skip `git fetch origin` entirely (it would fail), and tell the operator how to refresh `main` themselves from a host shell first.

**Files:**
- Modify: `config/next-task.sh`
- Test: `tests/test-next-task.sh`

**Interfaces:**
- Consumes: `FORGE_MODE_FILE` convention from Task 3 (default path `/home/aiuser/.claude/forge-mode`, `autonomous`/`supervised`, missing file = `autonomous`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test-next-task.sh`, right before the final `echo ""` / `PASS=$PASS FAIL=$FAIL`:

```bash
# --- supervised mode: skip the fetch and the unpushed-commits gate ---
assert_contains "$SCRIPT" 'FORGE_MODE_FILE="${FORGE_MODE_FILE:-/home/aiuser/.claude/forge-mode}"'
assert_contains "$SCRIPT" 'FORGE_MODE=$(cat "$FORGE_MODE_FILE" 2>/dev/null || echo autonomous)'
assert_contains "$SCRIPT" 'if [ "$FORGE_MODE" = "supervised" ]; then'
assert_contains "$SCRIPT" 'skipping unpushed check and git fetch'
assert_line_before "$SCRIPT" 'if [ "$FORGE_MODE" = "supervised" ]; then' 'git checkout -b "agent/$SHORT_NAME" origin/main'
assert_line_before "$SCRIPT" 'git fetch origin' 'git checkout -b "agent/$SHORT_NAME" origin/main'
```

- [ ] **Step 2: Run test-next-task.sh, confirm the new assertions fail**

Run: `bash tests/test-next-task.sh 2>&1 | tail -8`
Expected:
```
FAIL (attendu présent dans /workspace/config/next-task.sh): FORGE_MODE_FILE="${FORGE_MODE_FILE:-/home/aiuser/.claude/forge-mode}"
FAIL (attendu présent dans /workspace/config/next-task.sh): FORGE_MODE=$(cat "$FORGE_MODE_FILE" 2>/dev/null || echo autonomous)
FAIL (attendu présent dans /workspace/config/next-task.sh): if [ "$FORGE_MODE" = "supervised" ]; then
FAIL (attendu présent dans /workspace/config/next-task.sh): skipping unpushed check and git fetch

PASS=10 FAIL=6
```
(The two `assert_line_before` calls also fail since neither pattern exists yet.)

- [ ] **Step 3: Implement the mode branch**

Replace the whole of `config/next-task.sh` with:

```bash
#!/bin/bash
set -e

# next-task <short-name>
# Human-invoked (via `!next-task <name>` from inside a live Claude session),
# never by the agent itself — outside the agent's own tool loop, so
# pre-bash.sh's "the agent never switches branches" guarantee is untouched.
# Reuses the current container for a new task: refuses on dirty WIP, then
# (autonomous mode) also refuses on unpushed commits and fetches origin
# before checking out a fresh branch from origin/main. Supervised
# containers have no GitHub credential, so there's nothing to fetch or
# push from inside the container: the unpushed check and the fetch are
# both skipped, and origin/main is whatever was last fetched from a host
# shell.

# All output is prefixed with [operator] so the agent does not interpret
# these messages as instructions directed at it.
err() { echo "[operator] $*" >&2; }

if [ -z "$1" ]; then
  err "Usage: next-task <short-name>"
  exit 1
fi

SHORT_NAME="$1"
if [[ ! "$SHORT_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  err "Error: short-name must only contain [A-Za-z0-9._-], got: $SHORT_NAME"
  exit 1
fi
cd /workspace

DIRTY=$(git status --porcelain)
if [ -n "$DIRTY" ]; then
  err "Error: /workspace has uncommitted changes:"
  err "$DIRTY"
  err "Please commit or discard them before running next-task."
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

if [[ ! "$CURRENT_BRANCH" =~ ^agent/ ]]; then
  err "Error: current branch is $CURRENT_BRANCH, not an agent/* branch."
  err "next-task is meant to be run from inside a forge-provisioned container."
  exit 1
fi

FORGE_MODE_FILE="${FORGE_MODE_FILE:-/home/aiuser/.claude/forge-mode}"
FORGE_MODE=$(cat "$FORGE_MODE_FILE" 2>/dev/null || echo autonomous)

if [ "$FORGE_MODE" = "supervised" ]; then
  err "Supervised container: skipping unpushed check and git fetch (no credential)."
  err "If you want an up-to-date main, fetch it first from a host shell:"
  err "  cd ~/workspaces/<container> && git fetch origin"
else
  AHEAD_OF_MAIN=$(git log --oneline "origin/main..$CURRENT_BRANCH")
  if [ -n "$AHEAD_OF_MAIN" ]; then
    if ! git rev-parse --verify "origin/$CURRENT_BRANCH" > /dev/null 2>&1; then
      err "Error: branch $CURRENT_BRANCH has no origin/$CURRENT_BRANCH — it has never been pushed."
      err "Please push it before running next-task, or the commits will be left behind."
      exit 1
    fi

    UNPUSHED=$(git log --oneline "origin/$CURRENT_BRANCH..$CURRENT_BRANCH")
    if [ -n "$UNPUSHED" ]; then
      err "Error: branch $CURRENT_BRANCH has unpushed commits:"
      err "$UNPUSHED"
      err "Please push them before running next-task, or they will be left behind."
      exit 1
    fi
  fi

  git fetch origin
fi

git checkout -b "agent/$SHORT_NAME" origin/main

echo "[operator] Ready on branch agent/$SHORT_NAME."
```

- [ ] **Step 4: Run test-next-task.sh, confirm it passes**

Run: `bash tests/test-next-task.sh 2>&1 | tail -3`
Expected: `PASS=16 FAIL=0`

- [ ] **Step 5: Run the full suite as a regression check**

Run: `for f in tests/test-*.sh; do bash "$f" > /tmp/t.out 2>&1 || { echo "=== $f FAILED ==="; cat /tmp/t.out; }; done; echo done`
Expected: `done` with no `FAILED` lines.

- [ ] **Step 6: Commit**

```bash
git add config/next-task.sh tests/test-next-task.sh
git commit -m "feat: make next-task mode-aware, skipping fetch/unpushed gate for supervised"
```

---

## Task 5: `forge start` — mode prompt and supervised provisioning path

The core of this feature: on first provisioning, `forge start` asks whether the container should be autonomous or supervised. Supervised skips the PAT prompt and `gh auth` entirely, instead cloning the repo **on the host** over SSH (using the operator's own forwarded agent — this is a human-run script, not an agent tool call, so a YubiKey touch here is fine), writes the `forge-mode` marker file from Task 3, records `user.forge.mode` for Task 2's `forge_check_wip`, and prints the exact `git remote add` command the operator will need to retrieve the work later.

**Files:**
- Modify: `scripts/lib/forge-start.sh`
- Test: `tests/test-forge-start.sh`

**Interfaces:**
- Consumes: `FORGE_MODE_FILE` path convention from Task 3 (writes to the literal container path `/home/aiuser/.claude/forge-mode`); `user.forge.mode` LXD config key consumed by Task 2's `forge_check_wip` and by `forge list`.
- Produces: no new function signatures — `_forge_provision_container(container, owner_repo, task_name)` keeps the same three positional arguments; the mode choice is entirely internal (an interactive prompt), not a new parameter.

- [ ] **Step 1: Write the failing tests**

In `tests/test-forge-start.sh`, replace this line:
```bash
assert_contains "$LIB" 'lxc config set "$container" user.forge.mode "autonomous"'
```
with:
```bash
assert_contains "$LIB" 'lxc config set "$container" user.forge.mode "$mode"'
```

Then append, right before the final `echo ""` / `echo "PASS=$PASS FAIL=$FAIL"`:

```bash
# --- new in this task: mode prompt, supervised host-side clone, mode
# marker file, retrieval reminder ---
assert_contains "$LIB" 'Mode for this container?'
assert_contains "$LIB" 'read -r -p "Choice [a/s]: " MODE_CHOICE'
assert_contains "$LIB" 's|S) mode="supervised" ;;'
assert_contains "$LIB" 'echo '"'"'$mode'"'"' > /home/aiuser/.claude/forge-mode'
assert_contains "$LIB" 'git clone "git@github.com:$owner_repo.git" "$workspace_dir"'
assert_contains "$LIB" 'git checkout -b "agent/$task_name"'
assert_contains "$LIB" 'git remote add $container ssh://<user>@'
assert_line_before "$LIB" 'Mode for this container?' 'lxc launch agent-base'
assert_line_before "$LIB" "echo '\$mode' > /home/aiuser/.claude/forge-mode" 'git clone "git@github.com:$owner_repo.git"'
assert_line_before "$LIB" 'git clone "git@github.com:$owner_repo.git" "$workspace_dir"' 'lxc config set "$container" user.forge.repo'
```

- [ ] **Step 2: Run test-forge-start.sh, confirm the new assertions fail**

Run: `bash tests/test-forge-start.sh 2>&1 | tail -12`
Expected: every one of the newly added `assert_contains`/`assert_line_before` calls reports FAIL (none of that text or ordering exists in `forge-start.sh` yet), and the changed `user.forge.mode "$mode"` assertion also fails (current code still hardcodes `"autonomous"`).

- [ ] **Step 3: Implement the mode prompt and supervised path**

Replace the whole of `_forge_provision_container` in `scripts/lib/forge-start.sh` with:

```bash
_forge_provision_container() {
  local container="$1" owner_repo="$2" task_name="$3"

  if [ ! -f "/home/<user>/.claude/.credentials.json" ]; then
    echo "Error: /home/<user>/.claude/.credentials.json not found. Run 'claude auth login' on the host first." >&2
    return 1
  fi
  if ! lxc image info agent-base > /dev/null 2>&1; then
    echo "Error: image agent-base not found. Run 'forge image build' first." >&2
    return 1
  fi

  echo "Mode for this container?"
  echo "  [a] autonomous — bot pushes commits and opens PRs itself"
  echo "  [s] supervised — no credential; you retrieve and publish the work yourself"
  read -r -p "Choice [a/s]: " MODE_CHOICE
  local mode
  case "$MODE_CHOICE" in
    s|S) mode="supervised" ;;
    *) mode="autonomous" ;;
  esac

  echo "Creating container $container..."
  lxc launch agent-base "$container" --profile agent

  # Supprime le compte ubuntu laissé par cloud-init qui peut avoir NOPASSWD:ALL sudo
  echo "Removing cloud-init ubuntu backdoor..."
  lxc exec "$container" -- deluser --remove-home ubuntu 2>/dev/null || true
  lxc exec "$container" -- rm -f /etc/sudoers.d/90-cloud-init-users

  echo "Mounting workspace..."
  local workspace_dir="/home/<user>/workspaces/$container"
  mkdir -p "$workspace_dir"
  # raw.idmap dans le profil mappe <user> (1000) → aiuser (1001) et gère aussi root :
  # les fichiers créés par root (UID 0 container) sont stockés UID 1000000 sur l'hôte,
  # re-mappés vers UID 0 à la lecture. Pas besoin d'idmap shifting sur ce device.
  lxc config device add "$container" workspace disk \
    source="$workspace_dir" \
    path=/workspace

  echo "Copying signing key..."
  lxc file push /home/<user>/.ssh/github_agents_signing "$container"/home/aiuser/.ssh/id_ed25519_signing --uid 1001 --gid 1001 --mode 600

  echo "Configuring git..."
  lxc exec "$container" -- su - aiuser -c "
    git config --global user.name 'Claude Agent'
    git config --global user.email '<bot>@users.noreply.github.com'
    git config --global gpg.format ssh
    git config --global user.signingkey /home/aiuser/.ssh/id_ed25519_signing
    git config --global commit.gpgsign true
  "

  echo "Reusing Claude Code credentials from host..."
  lxc exec "$container" -- su - aiuser -c "mkdir -p /home/aiuser/.claude"
  lxc file push /home/<user>/.claude/.credentials.json "$container"/home/aiuser/.claude/.credentials.json --uid 1001 --gid 1001 --mode 600

  echo "Pre-accepting Claude Code onboarding..."
  lxc file push /home/<user>/agent-forge/config/claude-onboarding-state.json "$container"/home/aiuser/.claude.json --uid 1001 --gid 1001 --mode 600

  echo "Updating Claude Code to latest..."
  lxc exec "$container" -- npm install -g @anthropic-ai/claude-code@latest

  echo "Installing Claude plugins..."
  lxc exec "$container" -- su - aiuser -c "claude plugin marketplace add anthropics/claude-plugins-official && claude plugin install superpowers@claude-plugins-official"

  echo "Installing Claude global instructions..."
  lxc file push /home/<user>/agent-forge/templates/CLAUDE.md \
    "$container"/home/aiuser/CLAUDE.md \
    --uid 1001 --gid 1001 --mode 644

  echo "Installing Claude security hooks..."
  lxc exec "$container" -- mkdir -p /home/aiuser/.claude/hooks
  lxc file push /home/<user>/agent-forge/.claude/hooks/pre-bash.sh \
    "$container"/home/aiuser/.claude/hooks/pre-bash.sh \
    --uid 0 --gid 0 --mode 755
  lxc file push /home/<user>/agent-forge/config/claude-container-settings.json \
    "$container"/home/aiuser/.claude/settings.json \
    --uid 0 --gid 0 --mode 644

  echo "Recording forge mode marker..."
  lxc exec "$container" -- su - aiuser -c "echo '$mode' > /home/aiuser/.claude/forge-mode"

  if [ "$mode" = "supervised" ]; then
    echo "Cloning $owner_repo on the host and creating branch agent/$task_name..."
    git clone "git@github.com:$owner_repo.git" "$workspace_dir"
    (cd "$workspace_dir" && git checkout -b "agent/$task_name")
  else
    echo ""
    echo "=============================================================="
    echo "  GitHub token required (BOT account, fine-grained PAT)"
    echo "  Scoped to: $owner_repo only"
    echo "  Permissions: Contents RW, Pull requests RW, Metadata R"
    echo "  The token is piped into the container and never written"
    echo "  to host disk."
    echo "=============================================================="
    read -r -s -p "Paste the token (input hidden): " GH_TOKEN
    echo ""
    if [ -z "$GH_TOKEN" ]; then
      echo "Error: empty token." >&2
      return 1
    fi

    echo "Authenticating gh inside the container..."
    printf '%s' "$GH_TOKEN" | lxc exec "$container" -- su - aiuser -c "gh auth login --hostname github.com --with-token"
    unset GH_TOKEN
    # Fail fast if the token is invalid (set -e aborts on non-zero)
    lxc exec "$container" -- su - aiuser -c "gh auth status --hostname github.com"
    lxc exec "$container" -- su - aiuser -c "gh auth setup-git"

    echo "Cloning $owner_repo and creating branch agent/$task_name..."
    lxc exec "$container" -- su - aiuser -c "git clone https://github.com/$owner_repo.git /workspace && cd /workspace && git checkout -b agent/$task_name"
  fi

  echo "Recording forge metadata..."
  lxc config set "$container" user.forge.repo "$owner_repo"
  lxc config set "$container" user.forge.mode "$mode"

  if [ "$mode" = "supervised" ]; then
    echo ""
    echo "Retrieve this container's work from your laptop with:"
    echo "  git remote add $container ssh://<user>@<host>:2222$workspace_dir"
  fi

  echo "Container $container provisioned."
}
```

- [ ] **Step 4: Run test-forge-start.sh, confirm it passes**

Run: `bash tests/test-forge-start.sh 2>&1 | tail -3`
Expected: `PASS=33 FAIL=0` (the baseline 23 assertions from Task 1 — one of which, `user.forge.mode`, has its expected text updated in place here, not added anew — plus 10 newly appended ones).

- [ ] **Step 5: Run the full suite as a regression check**

Run: `for f in tests/test-*.sh; do bash "$f" > /tmp/t.out 2>&1 || { echo "=== $f FAILED ==="; cat /tmp/t.out; }; done; echo done`
Expected: `done` with no `FAILED` lines.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/forge-start.sh tests/test-forge-start.sh
git commit -m "feat: add supervised mode to forge start (mode prompt, host-side clone, no credential)"
```

---

## Task 6: Mode-aware `templates/CLAUDE.md`

The Git section of the CLAUDE.md pushed into every container currently only describes the autonomous push/PR flow. Rather than maintaining two full template files (duplicating the Contexte/Environnement/Périmètre sections and risking drift), the single template's Git section now tells the agent to check the same `/home/aiuser/.claude/forge-mode` marker file from Task 3 and follow the matching branch.

**Files:**
- Modify: `templates/CLAUDE.md`
- Test: Create `tests/test-claude-template.sh`

**Interfaces:**
- Consumes: `/home/aiuser/.claude/forge-mode` marker file path/convention from Task 3 (referenced in prose, not executed — this file is read by the agent itself, not by a script).

- [ ] **Step 1: Write the failing test**

Create `tests/test-claude-template.sh`:

```bash
#!/bin/bash
# Tests structurels de templates/CLAUDE.md : le fichier reste unique pour
# les deux modes — sa section Git renvoie au marqueur forge-mode plutôt que
# de dupliquer le template (voir
# docs/superpowers/specs/2026-07-15-supervised-git-mode-design.md).
# Lancer : bash tests/test-claude-template.sh
set -e

TEMPLATE="$(cd "$(dirname "$0")/.." && pwd)/templates/CLAUDE.md"
PASS=0
FAIL=0

assert_contains() {
  if grep -qF -- "$1" "$TEMPLATE"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu présent): $1"
  fi
}

assert_line_before() {
  local p1="$1" p2="$2" l1 l2
  l1=$(grep -nF -- "$p1" "$TEMPLATE" | head -1 | cut -d: -f1)
  l2=$(grep -nF -- "$p2" "$TEMPLATE" | head -1 | cut -d: -f1)
  if [ -n "$l1" ] && [ -n "$l2" ] && [ "$l1" -lt "$l2" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu '$p1' avant '$p2'): l1=${l1:-?} l2=${l2:-?}"
  fi
}

assert_contains '/home/aiuser/.claude/forge-mode'
assert_contains '`autonomous`'
assert_contains '`supervised`'
assert_contains 'git push -u origin agent/<task-name>'
assert_contains 'gh pr create --base main'
assert_contains "aucune** credential GitHub"
assert_contains 'arrête-toi là'
assert_line_before '/home/aiuser/.claude/forge-mode' '`autonomous`'
assert_line_before '`autonomous`' '`supervised`'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `bash tests/test-claude-template.sh 2>&1 | tail -12`
Expected: every assertion referencing the marker file or the mode-branch structure fails (none of that text exists in `templates/CLAUDE.md` yet):
```
FAIL (attendu présent): /home/aiuser/.claude/forge-mode
FAIL (attendu présent): `autonomous`
FAIL (attendu présent): `supervised`
...
PASS=2 FAIL=7
```
(`git push -u origin agent/<task-name>` and `gh pr create --base main` already exist in the current, autonomous-only template, so those two `assert_contains` calls pass even before this task's edit — accounting for the 2 PASS above; the other 7 assertions fail.)

- [ ] **Step 3: Rewrite the Git section**

In `templates/CLAUDE.md`, replace the entire `## Git` section:

```markdown
## Git
- Tu peux faire des commits — ils sont signés automatiquement (SSH signing configuré)
- Tu dois rester sur ta branche `agent/<task-name>` en permanence — jamais de `git checkout main`, jamais de changement de branche
- Les commits doivent avoir des messages clairs et conventionnels (`feat:`, `fix:`, `chore:`, etc.)
- Pousse ta branche avec `git push -u origin agent/<task-name>` — c'est la seule destination autorisée
- **Ouvre la PR toi-même** avec `gh pr create --base main` dès que le travail est poussé — sans attendre qu'on te le demande. C'est une étape obligatoire du flux autonome, pas une action optionnelle
- Ne merge **jamais** ta branche dans `main`, et ne merge jamais une PR toi-même (`gh pr merge` bloqué). Si ta PR a un conflit, tu peux faire `git merge origin/main` (seule forme autorisée) pour la rafraîchir avant de pousser — jamais l'inverse
- Réponds aux retours de review en poussant de nouveaux commits sur la même branche (jamais de force push, jamais de rebase)
```

with:

```markdown
## Git
- Tu peux faire des commits — ils sont signés automatiquement (SSH signing configuré)
- Tu dois rester sur ta branche `agent/<task-name>` en permanence — jamais de `git checkout main`, jamais de changement de branche
- Les commits doivent avoir des messages clairs et conventionnels (`feat:`, `fix:`, `chore:`, etc.)
- **Avant toute action de publication** (push, PR), lis `/home/aiuser/.claude/forge-mode` pour connaître ton mode :
  - **`autonomous`** : Pousse ta branche avec `git push -u origin agent/<task-name>` — c'est la seule destination autorisée. **Ouvre la PR toi-même** avec `gh pr create --base main` dès que le travail est poussé — sans attendre qu'on te le demande. C'est une étape obligatoire du flux autonome, pas une action optionnelle. Ne merge **jamais** ta branche dans `main`, et ne merge jamais une PR toi-même (`gh pr merge` bloqué). Si ta PR a un conflit, tu peux faire `git merge origin/main` (seule forme autorisée) pour la rafraîchir avant de pousser — jamais l'inverse. Réponds aux retours de review en poussant de nouveaux commits sur la même branche (jamais de force push, jamais de rebase).
  - **`supervised`** : Tu n'as **aucune** credential GitHub — ni pour push, ni pour `gh`. Ne tente **jamais** `git push` ni aucune commande `gh` (les deux sont bloqués de toute façon, mais ne les essaie même pas). Commite localement, signé, sur ta branche, et **arrête-toi là** : quand la tâche est terminée, dis-le clairement dans ta dernière réponse — un humain récupère et publie ton travail depuis l'extérieur du container.
```

- [ ] **Step 4: Run test-claude-template.sh, confirm it passes**

Run: `bash tests/test-claude-template.sh 2>&1 | tail -3`
Expected: `PASS=9 FAIL=0`

- [ ] **Step 5: Run the full suite as a regression check**

Run: `for f in tests/test-*.sh; do bash "$f" > /tmp/t.out 2>&1 || { echo "=== $f FAILED ==="; cat /tmp/t.out; }; done; echo done`
Expected: `done` with no `FAILED` lines. (`test-next-task.sh`'s `assert_contains "$TEMPLATE" 'next-task'` still passes — that line is untouched.)

- [ ] **Step 6: Commit**

```bash
git add templates/CLAUDE.md tests/test-claude-template.sh
git commit -m "feat: make templates/CLAUDE.md's Git section mode-aware via the forge-mode marker"
```

---

## Task 7: README documentation

Document the mode prompt, the supervised provisioning path, and the retrieval flow; fix the now-incorrect note about the old deploy key returning as a "fetch-only credential" (it doesn't — supervised mode uses a host-side SSH clone instead, per the design spec).

**Files:**
- Modify: `README.md`
- Test: `tests/test-readme-docs.sh`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Write the failing tests**

In `tests/test-readme-docs.sh`, add before the final `echo ""` / `echo "PASS=$PASS FAIL=$FAIL"`:

```bash
assert_contains 'Supervised mode'
assert_contains 'git remote add'
assert_contains 'rebase --reset-author'
assert_not_contains 'fetch-only credential'
```

- [ ] **Step 2: Run test-readme-docs.sh, confirm the new assertions fail**

Run: `bash tests/test-readme-docs.sh 2>&1 | tail -6`
Expected:
```
FAIL (attendu présent): Supervised mode
FAIL (attendu présent): git remote add
FAIL (attendu présent): rebase --reset-author
FAIL (attendu absent): fetch-only credential

PASS=14 FAIL=4
```

- [ ] **Step 3: Fix the stale deploy-key note**

In `README.md`, replace:
```markdown
> The old read-only deploy key (`~/.ssh/github_agents`) is no longer used by
> autonomous containers — they authenticate with a PAT over HTTPS. It will
> return in supervised mode as the fetch-only credential; keep it if present.
```
with:
```markdown
> The old read-only deploy key (`~/.ssh/github_agents`) is no longer used by
> either mode — autonomous containers authenticate with a PAT over HTTPS,
> and supervised containers get no credential at all (the host clones over
> SSH using your own forwarded agent instead; see §7 and "Supervised mode"
> below). It can be removed if you don't need it for anything else.
```

- [ ] **Step 4: Update the "Start a container" bullets**

In `README.md`, replace:
```markdown
Container identity is derived from `owner/repo` — no project name to choose
or remember. If no container exists yet for that repo, `forge start`
provisions one first:
- Creates an LXD container from `agent-base`
- Mounts `/workspace` with correct permissions (no `sudo` required — LXD idmap shifting handles the UID mapping, scoped to that one mount)
- Copies the signing key and configures git (signed commits)
- Reuses your Claude Code credentials from the host (`~/.claude/.credentials.json`), so the container starts already authenticated — no Remote Control pairing needed
- Pre-accepts onboarding and installs the `superpowers` plugin, so the first `claude` launch skips the setup questions
- Prompts for the bot's fine-grained PAT (see setup §6) and authenticates `gh` inside the container — the token is never written to host disk
- Clones `https://github.com/<owner/repo>.git` and creates branch `agent/<task-name>` (`task-name` defaults to `init`, i.e. `agent/init`, if omitted)
- Records `owner/repo` and mode on the container itself (LXD config keys) — there's no separate registry file; `forge list` and future `forge start` calls discover containers this way
```
with:
```markdown
Container identity is derived from `owner/repo` — no project name to choose
or remember. If no container exists yet for that repo, `forge start`
provisions one first:
- Prompts for the container's mode: **autonomous** (bot pushes and opens PRs itself) or **supervised** (no GitHub credential ever touches the container — see "Supervised mode" below)
- Creates an LXD container from `agent-base`
- Mounts `/workspace` with correct permissions (no `sudo` required — LXD idmap shifting handles the UID mapping, scoped to that one mount)
- Copies the signing key and configures git (signed commits)
- Reuses your Claude Code credentials from the host (`~/.claude/.credentials.json`), so the container starts already authenticated — no Remote Control pairing needed
- Pre-accepts onboarding and installs the `superpowers` plugin, so the first `claude` launch skips the setup questions
- **Autonomous:** prompts for the bot's fine-grained PAT (see setup §6), authenticates `gh` inside the container — the token is never written to host disk — and clones `https://github.com/<owner/repo>.git` inside the container
- **Supervised:** no token prompt; clones `git@github.com:<owner/repo>.git` on the host over SSH, using your own forwarded agent (§7) — the container never receives any GitHub credential
- Creates branch `agent/<task-name>` (`task-name` defaults to `init`, i.e. `agent/init`, if omitted)
- Records `owner/repo` and mode on the container itself (LXD config keys) — there's no separate registry file; `forge list` and future `forge start` calls discover containers this way
```

- [ ] **Step 5: Add the "Supervised mode" section**

In `README.md`, right after the `### Autonomous PR flow` section and its paragraph (before `### Token renewal`), add:

```markdown
### Supervised mode

For repos where no standing GitHub credential should ever exist inside a
container. The container gets no PAT and no `gh auth` — `pre-bash.sh`
blocks every `git push` and every `gh` subcommand unconditionally, and
`templates/CLAUDE.md` tells the agent to commit locally (signed) and stop
when the task is done, never attempting to publish.

Retrieving and publishing the work is a manual, laptop-side flow — every
line the agent wrote gets reviewed before it's re-authored as your own:

```bash
git remote add <container> ssh://<user>@<host>:2222/home/<user>/workspaces/<container>
git fetch <container> agent/<task-name>:agent/<task-name>
git log -p main..agent/<task-name>          # review before doing anything else
git checkout agent/<task-name>
git rebase --reset-author main
git push origin agent/<task-name>            # your identity, YubiKey-signed
```

`forge start`'s supervised path prints the exact `git remote add` command
(container name filled in) at the end of provisioning.

Reusing a supervised container for a new task (`!next-task <short-name>`)
skips the unpushed-commits check (there's no "pushed" concept without a
credential) and skips `git fetch origin` (no credential to fetch with) — if
you want an up-to-date `main` first, fetch it yourself from a host shell in
the workspace directory before running `next-task`.
```

- [ ] **Step 6: Run test-readme-docs.sh, confirm it passes**

Run: `bash tests/test-readme-docs.sh 2>&1 | tail -3`
Expected: `PASS=18 FAIL=0`

- [ ] **Step 7: Run the full suite one final time**

Run: `for f in tests/test-*.sh; do bash "$f" > /tmp/t.out 2>&1 || { echo "=== $f FAILED ==="; cat /tmp/t.out; }; done; echo done`
Expected: `done` with no `FAILED` lines — every test file in the repo passes, confirming the whole plan's changes are consistent end to end.

- [ ] **Step 8: Commit**

```bash
git add README.md tests/test-readme-docs.sh
git commit -m "docs: document supervised mode and fix the stale deploy-key note"
```

---

## Manual verification (server-side, not part of this repo's automated suite)

This dev environment has no LXD access, so `forge start`, the container-side clone, and the retrieval flow can only be exercised on the real server, against a scratch repo. Checklist (mirrors the design spec's own verification section):

1. `forge start <owner>/<scratch-repo>`, choosing `s`: provisions with no PAT prompt, no `gh auth` call; `git log` inside the container shows the cloned history; `lxc config get <container> user.forge.mode` prints `supervised`.
2. Inside the container: a commit shows **Verified**; `git push origin agent/<task>` is blocked; any `gh` subcommand is blocked.
3. `!next-task foo` with a clean tree and commits ahead of main succeeds without attempting `git fetch origin` or demanding an `origin/<branch>` ref.
4. `forge stop`/`forge delete` on a supervised container with commits ahead of main (clean tree) succeeds without `--force`; with a dirty tree, both still refuse.
5. From the laptop: the printed `git remote add` command works verbatim; `git fetch <name> agent/<task>:agent/<task>` retrieves the branch; `git rebase --reset-author main` re-authors cleanly; the final push lands under the user's identity, YubiKey-signed, with no bot involvement anywhere in the pushed history.
6. An autonomous-mode container provisioned before this change (no `forge-mode` marker file) still behaves exactly as today.
