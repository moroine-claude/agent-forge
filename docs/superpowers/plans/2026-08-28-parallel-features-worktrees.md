# Parallel features via git worktrees + container versioning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one container per repo run several features in parallel via git worktrees (`start`/`resume`/`finish` verbs), keep `main` fresh automatically, ship `git-lfs`, and flag running containers built from an older image than the latest build.

**Architecture:** Model "A1" — `/workspace` stays a single clone pinned to `main`; each feature is a `git worktree` at `/workspace/.trees/<task>` on branch `agent/<task>`, under the existing host mount so WIP survives `lxc delete`. All `git worktree` commands run **inside the container** (`lxc exec … git -C /workspace …`) so the paths git stores are container-absolute (`/workspace/...`), valid regardless of the host mount path. The image and each container carry a git-commit stamp so `forge list` can compare a running container to the latest build.

**Tech Stack:** Bash (strict mode), LXD (`lxc`), git worktrees, tmux, plain-bash module tests (`tests/test-*.sh`).

## Global Constraints

- **Bash strict mode:** every script starts with `set -e`. (The `scripts/lib/forge-*.sh` files are *sourced* by `scripts/forge` which has `set -e` at the top — they don't repeat it; new standalone scripts do.)
- **Quote all variables:** `"$VAR"`, never `$VAR`.
- **The agent never switches branches.** `git worktree add|remove` are run by `forge` (operator/host side) via `lxc exec`, never by the agent. `pre-bash.sh` is unchanged.
- **Only `git merge origin/main` is an allowed merge** anywhere the agent could run it — plan code never merges the other direction.
- **All `git worktree` commands run inside the container** (`lxc exec "$container" -- su - aiuser -c "git -C /workspace worktree …"`), for path correctness. Never run `git worktree add` on the host mount directory.
- **No hardcoded credentials.** Supervised containers have no `gh`/push credential inside them; anything requiring `origin` fetch is skipped there with a `[operator]`/note message, matching the retired `next-task` policy.
- **`FORGE_REPO_DIR`** default: `/home/moroine/agent-forge` (the agent-forge checkout on the host, already used by `forge-start.sh` to push files). Overridable via env for tests.
- **Tests don't have `lxc`/`git`-against-a-real-repo available.** Follow the existing convention: pure-bash functions are tested by real execution (with `lxc()`/`git()` shell-function mocks where they shell out); everything else is verified structurally with `grep -qF` + `bash -n`.
- **Worktree task names** reuse `validate_task_name` (already restricts to `[A-Za-z0-9._-]`), so they're safe to interpolate into `su -c` strings and into `.trees/<task>` paths.

---

## File Structure

**Modified:**
- `scripts/lib/forge-common.sh` — worktree/versioning helpers; multi-worktree WIP check.
- `scripts/lib/forge-start.sh` — provisioning split (clone on `main`, lfs, stamp), worktree add, fetch/ff, per-task attach, orchestration.
- `scripts/lib/forge-image.sh` — install `git-lfs`, stamp image commit, drop `next-task` push.
- `scripts/lib/forge-list.sh` — per-task rows + build-vs-latest flag.
- `scripts/lib/forge-completion.sh` — complete `resume`/`finish`; robust repo parsing.
- `scripts/forge` — dispatch + usage for `resume`/`finish`.
- `templates/CLAUDE.md`, `README.md` — worktree model, new verbs, git-lfs, versioning, remove `next-task`.

**Created:**
- `scripts/lib/forge-resume.sh` — `cmd_forge_resume`.
- `scripts/lib/forge-finish.sh` — `cmd_forge_finish`.
- `tests/test-forge-resume.sh`, `tests/test-forge-finish.sh`.

**Deleted:**
- `config/next-task.sh`, `tests/test-next-task.sh`.

**Unchanged (inherit new behavior for free):**
- `scripts/lib/forge-stop.sh`, `scripts/lib/forge-delete.sh` — both call `forge_check_wip "$container"`, which becomes multi-worktree in Task 2. No edits; their existing tests still pass.

---

## Task 1: Worktree & versioning helpers in forge-common.sh

**Files:**
- Modify: `scripts/lib/forge-common.sh` (append new helpers)
- Test: `tests/test-forge-common.sh`

**Interfaces:**
- Produces:
  - `FORGE_REPO_DIR` — env-overridable constant, default `/home/moroine/agent-forge`.
  - `worktree_relpath <task>` → prints `.trees/<task>` (pure).
  - `worktree_abspath <task>` → prints `/workspace/.trees/<task>` (pure).
  - `current_image_commit` → prints the `user.forge.commit` property of the `agent-base` image, empty if unset (calls `lxc`).
  - `container_image_commit <container>` → prints the container's `user.forge.image_commit` config key, empty if unset (calls `lxc`).
  - `build_status <container_commit> <latest_commit>` → pure; prints one of: `unknown` (either arg empty), `up-to-date` (equal), `behind` (differ).

- [ ] **Step 1: Write the failing test**

Append to `tests/test-forge-common.sh` (before the final `echo "PASS=…"` block):

```bash
# --- worktree path helpers (pure) ---
assert_eq "worktree_relpath" "$(worktree_relpath 'feat-a')" ".trees/feat-a"
assert_eq "worktree_abspath" "$(worktree_abspath 'feat-a')" "/workspace/.trees/feat-a"

# --- build_status (pure comparison) ---
assert_eq "build up-to-date" "$(build_status abc123 abc123)" "up-to-date"
assert_eq "build behind" "$(build_status abc123 def456)" "behind"
assert_eq "build unknown (no container stamp)" "$(build_status '' def456)" "unknown"
assert_eq "build unknown (no image stamp)" "$(build_status abc123 '')" "unknown"

# --- versioning helpers that call lxc: structural ---
assert_contains 'FORGE_REPO_DIR'
assert_contains 'user.forge.image_commit'
assert_contains 'get-property agent-base user.forge.commit'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-forge-common.sh`
Expected: FAIL — `worktree_relpath`/`build_status` not defined; `assert_contains` failures for the new patterns.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/lib/forge-common.sh`:

```bash
# Path of the agent-forge checkout on the host (used to read the commit an
# image was built from). Overridable for tests.
FORGE_REPO_DIR="${FORGE_REPO_DIR:-/home/moroine/agent-forge}"

# Worktree paths for a task. Container-side: the main clone is /workspace and
# every feature is a worktree under .trees/. worktree_relpath is what we pass
# to `git -C /workspace worktree add`; worktree_abspath is the cd target for
# the tmux/claude session.
worktree_relpath() { echo ".trees/$1"; }
worktree_abspath() { echo "/workspace/.trees/$1"; }

# Commit the current agent-base image was built from (empty if the image is
# missing or unstamped).
current_image_commit() {
  lxc image get-property agent-base user.forge.commit 2>/dev/null || true
}

# Commit of the image a container was created from (empty if unset).
container_image_commit() {
  lxc config get "$1" user.forge.image_commit 2>/dev/null || true
}

# Pure comparison of a container's build stamp against the latest image build.
# Prints: unknown | up-to-date | behind.
build_status() {
  local container_commit="$1" latest_commit="$2"
  if [ -z "$container_commit" ] || [ -z "$latest_commit" ]; then
    echo "unknown"
  elif [ "$container_commit" = "$latest_commit" ]; then
    echo "up-to-date"
  else
    echo "behind"
  fi
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-forge-common.sh`
Expected: PASS (`FAIL=0`).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/forge-common.sh tests/test-forge-common.sh
git commit -m "feat: add worktree path and build-version helpers to forge-common"
```

---

## Task 2: Multi-worktree WIP check in forge-common.sh

Rework `forge_check_wip` so `stop`/`delete` block on WIP in **any** worktree, and expose a single-worktree check that `finish` (Task 7) reuses. The main clone (`/workspace`, on `main`) is never committed to, so it is not checked — only `.trees/*` worktrees are.

**Files:**
- Modify: `scripts/lib/forge-common.sh` (`forge_check_wip`, add `_forge_worktree_dirs`, `_forge_check_one_worktree`)
- Test: `tests/test-forge-common.sh`

**Interfaces:**
- Consumes: `forge_container_mode` (existing).
- Produces:
  - `_forge_worktree_dirs <container>` → prints each worktree dir (one per line), i.e. the `worktree ` paths from `git worktree list --porcelain` **excluding** the main `/workspace`. Calls `lxc`.
  - `_forge_check_one_worktree <container> <worktree_dir>` → runs the dirty check always; in autonomous mode also the branch-name safety + unpushed checks, `cd`-ing into `<worktree_dir>`. Returns non-zero and prints to stderr on any problem. (This is the per-tree body lifted out of today's `forge_check_wip`.)
  - `forge_check_wip <container>` → loops `_forge_worktree_dirs` and calls `_forge_check_one_worktree` for each; returns non-zero on the first failure.

**Design notes for the implementer:**
- Today's `forge_check_wip` hardcodes `cd /workspace`. The new per-tree helper takes the worktree dir as an argument and `cd`s there.
- Keep the **branch-name safety regex** (`^agent/[A-Za-z0-9._-]+$`) exactly as today — it defends against a malicious branch name being interpolated into a later `lxc exec`. The existing malicious-branch regression test must keep passing.
- `git worktree list --porcelain` output has stanzas; the worktree path lines start with `worktree `. The main clone's line is `worktree /workspace`. Filter it out.

- [ ] **Step 1: Write the failing test**

In `tests/test-forge-common.sh`, replace the existing single-tree `forge_check_wip` mock blocks with worktree-aware ones. Add these cases (keep the malicious-branch and supervised-dirty intent):

```bash
# --- forge_check_wip iterates all worktrees; a dirty one blocks ---
lxc() {
  case "$*" in
    "config get multi user.forge.mode") echo "" ;;
    "exec multi -- su - aiuser -c cd /workspace && git worktree list --porcelain")
      printf 'worktree /workspace\n\nworktree /workspace/.trees/feat-a\n\nworktree /workspace/.trees/feat-b\n' ;;
    "exec multi -- su - aiuser -c cd /workspace/.trees/feat-a && git status --porcelain") echo "" ;;
    "exec multi -- su - aiuser -c cd /workspace/.trees/feat-a && git rev-parse --abbrev-ref HEAD") echo "agent/feat-a" ;;
    "exec multi -- su - aiuser -c cd /workspace/.trees/feat-a && git log --oneline origin/main..agent/feat-a") echo "" ;;
    "exec multi -- su - aiuser -c cd /workspace/.trees/feat-b && git status --porcelain") echo "M dirty.txt" ;;
    *) echo "unexpected lxc call: $*" >&2; return 1 ;;
  esac
}
if forge_check_wip multi 2>/dev/null; then
  FAIL=$((FAIL + 1)); echo "FAIL: a dirty second worktree should block forge_check_wip"
else
  PASS=$((PASS + 1))
fi
unset -f lxc

# --- all worktrees clean & pushed → passes ---
lxc() {
  case "$*" in
    "config get clean user.forge.mode") echo "" ;;
    "exec clean -- su - aiuser -c cd /workspace && git worktree list --porcelain")
      printf 'worktree /workspace\n\nworktree /workspace/.trees/feat-a\n' ;;
    "exec clean -- su - aiuser -c cd /workspace/.trees/feat-a && git status --porcelain") echo "" ;;
    "exec clean -- su - aiuser -c cd /workspace/.trees/feat-a && git rev-parse --abbrev-ref HEAD") echo "agent/feat-a" ;;
    "exec clean -- su - aiuser -c cd /workspace/.trees/feat-a && git log --oneline origin/main..agent/feat-a") echo "" ;;
    *) echo "unexpected lxc call: $*" >&2; return 1 ;;
  esac
}
if forge_check_wip clean 2>/dev/null; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1)); echo "FAIL: all-clean worktrees should pass forge_check_wip"
fi
unset -f lxc
```

Also update the **existing** malicious-branch and supervised mock blocks so their `lxc` mocks answer the new call shape: `forge_check_wip` now first asks `… cd /workspace && git worktree list --porcelain`, then per-tree `cd /workspace/.trees/<task> && …`. For the malicious case, return a single worktree `worktree /workspace/.trees/evil` and have its `git rev-parse --abbrev-ref HEAD` echo the `x$(touch /tmp/PWNED_test)y` payload. For the supervised-dirty case, return one worktree and a dirty `git status`. For supervised-clean, return one worktree with clean status (mode `supervised` must short-circuit before branch/unpushed checks).

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-forge-common.sh`
Expected: FAIL — `forge_check_wip` still `cd /workspace` and doesn't enumerate worktrees, so the new `unexpected lxc call: … git worktree list …` fires.

- [ ] **Step 3: Write minimal implementation**

Replace `forge_check_wip` in `scripts/lib/forge-common.sh` with:

```bash
# Prints each feature worktree dir for a container (one per line), excluding
# the main /workspace clone. Container must be running.
_forge_worktree_dirs() {
  local container="$1"
  lxc exec "$container" -- su - aiuser -c "cd /workspace && git worktree list --porcelain" \
    | awk '/^worktree /{print $2}' \
    | grep -vx '/workspace' || true
}

# WIP pre-flight for a single worktree dir. Always checks the dirty tree; in
# autonomous mode also the branch-name safety regex and unpushed commits.
# Supervised containers have no credential to have pushed with, so only the
# dirty check applies there.
_forge_check_one_worktree() {
  local container="$1" dir="$2" dirty branch mode ahead unpushed

  dirty=$(lxc exec "$container" -- su - aiuser -c "cd $dir && git status --porcelain")
  if [ -n "$dirty" ]; then
    echo "Error: $container has uncommitted changes in $dir:" >&2
    echo "$dirty" >&2
    echo "Commit/discard them, or pass --force." >&2
    return 1
  fi

  mode=$(forge_container_mode "$container")
  if [ "$mode" = "supervised" ]; then
    return 0
  fi

  branch=$(lxc exec "$container" -- su - aiuser -c "cd $dir && git rev-parse --abbrev-ref HEAD")
  if [[ ! "$branch" =~ ^agent/[A-Za-z0-9._-]+$ ]]; then
    echo "Error: unexpected branch name '$branch' in $dir ($container); refusing to proceed." >&2
    return 1
  fi

  ahead=$(lxc exec "$container" -- su - aiuser -c "cd $dir && git log --oneline origin/main..$branch")
  if [ -n "$ahead" ]; then
    if ! lxc exec "$container" -- su - aiuser -c "cd $dir && git rev-parse --verify origin/$branch" > /dev/null 2>&1; then
      echo "Error: $container's branch $branch has no origin/$branch — it has never been pushed." >&2
      echo "Push it, or pass --force." >&2
      return 1
    fi
    unpushed=$(lxc exec "$container" -- su - aiuser -c "cd $dir && git log --oneline origin/$branch..$branch")
    if [ -n "$unpushed" ]; then
      echo "Error: $container has unpushed commits on $branch:" >&2
      echo "$unpushed" >&2
      echo "Push them, or pass --force." >&2
      return 1
    fi
  fi
}

# WIP pre-flight across every feature worktree. Container must be running.
# Used by stop and delete.
forge_check_wip() {
  local container="$1" dir
  while IFS= read -r dir; do
    [ -z "$dir" ] && continue
    _forge_check_one_worktree "$container" "$dir" || return 1
  done < <(_forge_worktree_dirs "$container")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-forge-common.sh`
Expected: PASS.

Also run the neighbors that call it (they mock `require_container_for_repo`/`lxc` at the dispatch level and should be unaffected):
Run: `bash tests/test-forge-stop.sh && bash tests/test-forge-delete.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/forge-common.sh tests/test-forge-common.sh
git commit -m "feat: check WIP across all worktrees, not just /workspace"
```

---

## Task 3: git-lfs + image commit stamp in forge-image.sh

**Files:**
- Modify: `scripts/lib/forge-image.sh`
- Test: `tests/test-forge-image.sh`

**Interfaces:**
- Consumes: `FORGE_REPO_DIR` (Task 1).
- Produces: an `agent-base` image with `git-lfs` installed and image property `user.forge.commit` set to the agent-forge build commit; no `next-task` inside it.

- [ ] **Step 1: Write the failing test**

Append to `tests/test-forge-image.sh` (match its existing `assert_contains`/`assert_not_contains` helpers and `$LIB` var):

```bash
# git-lfs ships in the image
assert_contains 'git-lfs'
# image is stamped with the build commit
assert_contains 'lxc image set-property agent-base user.forge.commit'
assert_contains 'git -C "$FORGE_REPO_DIR" rev-parse HEAD'
# next-task is gone
assert_not_contains 'next-task'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-forge-image.sh`
Expected: FAIL — `git-lfs`, the stamp, and (absence of) `next-task` assertions fail.

- [ ] **Step 3: Write minimal implementation**

In `scripts/lib/forge-image.sh`:

1. Add `git-lfs` to the base apt install line:

```bash
  lxc exec "$setup" -- apt install -y git git-lfs tmux curl wget unzip zip python3 python3-pip
```

2. Delete the `next-task` install block (the `echo "Installing next-task..."` line and the `lxc file push … next-task.sh …` command).

3. Stamp the image right after publish. Replace the publish tail:

```bash
  lxc stop "$setup"
  lxc image delete agent-base 2>/dev/null || true
  lxc publish "$setup" --alias agent-base
  lxc delete "$setup"

  # Stamp the build commit so `forge list` can flag containers running on an
  # older image than the latest build.
  local build_commit
  build_commit=$(git -C "$FORGE_REPO_DIR" rev-parse HEAD)
  lxc image set-property agent-base user.forge.commit "$build_commit"

  echo "Image agent-base published (build $build_commit)."
```

(Remove the old `echo "Image agent-base published."` line.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-forge-image.sh`
Expected: PASS. Also `bash -n scripts/lib/forge-image.sh`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/forge-image.sh tests/test-forge-image.sh
git commit -m "feat: install git-lfs and stamp the build commit into agent-base"
```

---

## Task 4: Provisioning rework — clone on main, git-lfs, exclude .trees, stamp image_commit

Refactor `_forge_provision_container` so the clone lands on `main` (no feature checkout — that becomes a worktree in Task 5), configures LFS, ignores `.trees/`, and records the image commit it was built from.

**Files:**
- Modify: `scripts/lib/forge-start.sh` (`_forge_provision_container`)
- Test: `tests/test-forge-start.sh`

**Interfaces:**
- Consumes: `current_image_commit` (Task 1).
- Produces: a provisioned container whose `/workspace` is a clone on `main`, with `.trees/` in `.git/info/exclude`, LFS filters installed, and config key `user.forge.image_commit` set. Leaves the worktree creation + attach to `cmd_forge_start` (Task 5).

**Design notes:**
- Both modes currently end their clone with `git checkout -b agent/$task_name`. **Remove that** — the clone stays on the default branch (`main`).
- Supervised host clone (`git clone … "$workspace_dir"`) stays on `main` too (drop its `(cd … git checkout -b …)` line).
- LFS + `.git/info/exclude` must be set **inside the container** for both modes (path-correct, and the container is where the mount is visible). Do it after the clone exists.

- [ ] **Step 1: Write the failing test**

In `tests/test-forge-start.sh`:

- Change the task-name assertion — task-name is now required (Task 5), so update:
  ```bash
  # was: assert_contains "$LIB" 'task_name="${2:-init}"'
  assert_contains "$LIB" 'validate_task_name "$task_name"'
  ```
  (Leave the exact required/optional wording to Task 5; here just stop asserting the `init` default.) Replace the line `assert_contains "$LIB" 'task_name="${2:-init}"'` with a comment noting it moved to Task 5, or delete it.
- Remove the two assertions that pin a feature checkout in the clone step:
  ```bash
  # delete: assert_contains "$LIB" 'git checkout -b "agent/$task_name"'
  # delete: assert_line_before "$LIB" 'validate_task_name "$task_name"' 'lxc exec "$container" -- su - aiuser -c "git clone'
  ```
- Add:
  ```bash
  # provisioning now leaves the clone on main and configures LFS + excludes .trees
  assert_contains "$LIB" 'git lfs install'
  assert_contains "$LIB" '.trees/'
  assert_contains "$LIB" 'info/exclude'
  assert_contains "$LIB" 'lxc config set "$container" user.forge.image_commit'
  assert_not_contains "$LIB" 'git checkout -b "agent/$task_name"'
  ```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-forge-start.sh`
Expected: FAIL — new patterns absent, and the `assert_not_contains` for the old checkout fails until removed.

- [ ] **Step 3: Write minimal implementation**

In `_forge_provision_container` (`scripts/lib/forge-start.sh`):

1. **Supervised clone** — drop the feature checkout:

```bash
    echo "Cloning $owner_repo on the host (branch main)..."
    git clone "git@github.com:$owner_repo.git" "$workspace_dir"
```

2. **Autonomous clone** — drop the feature checkout:

```bash
    echo "Cloning $owner_repo (branch main)..."
    lxc exec "$container" -- su - aiuser -c "git clone https://github.com/$owner_repo.git /workspace"
```

3. After the mode-specific clone (both paths joined again), add LFS + exclude + image stamp, before the final `user.forge.repo`/`user.forge.mode` metadata block:

```bash
  echo "Configuring git-lfs and ignoring worktrees..."
  lxc exec "$container" -- su - aiuser -c "cd /workspace && git lfs install && grep -qxF '.trees/' .git/info/exclude || echo '.trees/' >> .git/info/exclude"

  echo "Stamping the image build this container came from..."
  lxc config set "$container" user.forge.image_commit "$(current_image_commit)"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-forge-start.sh`
Expected: PASS. Also `bash -n scripts/lib/forge-start.sh`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/forge-start.sh tests/test-forge-start.sh
git commit -m "feat: provision clones on main, configures lfs, stamps image build"
```

---

## Task 5: start orchestration — worktree add, fetch/ff main, per-task attach

Rewire `cmd_forge_start` so it: requires a task name, provisions only when the container is absent, fetches + fast-forwards `main` (autonomous), adds the `.trees/<task>` worktree (refusing if it already exists), and attaches a per-task tmux session.

**Files:**
- Modify: `scripts/lib/forge-start.sh` (`cmd_forge_start`; add `_forge_add_worktree`, `_forge_attach_task`)
- Test: `tests/test-forge-start.sh`

**Interfaces:**
- Consumes: `sanitize_container_name`, `check_container_name_collision`, `validate_owner_repo`, `validate_task_name` (existing); `worktree_relpath`, `worktree_abspath` (Task 1); `forge_container_mode` (existing).
- Produces:
  - `_forge_add_worktree <container> <task>` → fetch+ff `main` (autonomous only), then `git -C /workspace worktree add .trees/<task> -b agent/<task> origin/main` inside the container. Errors if `.trees/<task>` already exists.
  - `_forge_attach_task <container> <task>` → `tmux new-session -A -s "<task>"` running claude in `worktree_abspath <task>` with `--remote-control "<container>-<task>"`. Reused by `cmd_forge_resume` (Task 6).

**Design notes:**
- `task_name` is now **required** — no `init` default. Update the usage string and the early guard.
- The old "container already exists → warn, ignore task-name" branch is replaced: an existing container just skips provisioning and proceeds to add-worktree.
- Fetch/ff runs **inside** the container for autonomous; skipped for supervised (no credential) with a note — mirror the retired `next-task` policy.
- Refuse a duplicate worktree by testing the dir: `lxc exec … test -e /workspace/.trees/<task>` → non-zero means absent (good).

- [ ] **Step 1: Write the failing test**

In `tests/test-forge-start.sh` add:

```bash
# task-name required (no init default)
assert_contains "$LIB" 'Usage: forge start <owner/repo> <task>'
assert_not_contains "$LIB" 'task_name="${2:-init}"'

# worktree add inside the container, from origin/main, on agent/<task>
assert_contains "$LIB" 'git -C /workspace worktree add'
assert_contains "$LIB" '-b agent/$task_name origin/main'
assert_contains "$LIB" 'already exists'          # duplicate-worktree guard message

# fetch + ff main (autonomous), skipped for supervised
assert_contains "$LIB" 'git -C /workspace fetch origin'
assert_contains "$LIB" 'merge --ff-only origin/main'

# per-task attach: session named after the task, cd into the worktree
assert_contains "$LIB" 'tmux new-session -A -s'
assert_contains "$LIB" 'cd /workspace/.trees/'
assert_contains "$LIB" '--remote-control ${container}-${task_name}'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-forge-start.sh`
Expected: FAIL — new patterns absent; `task_name="${2:-init}"` still present.

- [ ] **Step 3: Write minimal implementation**

Replace `cmd_forge_start` and add the two helpers in `scripts/lib/forge-start.sh`:

```bash
cmd_forge_start() {
  local owner_repo="$1" task_name="$2"

  if [ -z "$owner_repo" ] || [ -z "$task_name" ]; then
    echo "Usage: forge start <owner/repo> <task>" >&2
    return 1
  fi
  validate_owner_repo "$owner_repo" || return 1
  validate_task_name "$task_name" || return 1

  local container
  container=$(sanitize_container_name "$owner_repo")
  check_container_name_collision "$container" "$owner_repo" || return 1

  if ! lxc info "$container" > /dev/null 2>&1; then
    _forge_provision_container "$container" "$owner_repo" "$task_name" || return 1
  fi

  echo "Starting container $container..."
  if [ "$(lxc list "$container" -f json | jq -r '.[0].status')" != "Running" ]; then
    lxc start "$container"
  fi

  _forge_add_worktree "$container" "$task_name" || return 1
  _forge_attach_task "$container" "$task_name"
}

# Fetch + fast-forward main (autonomous only), then create the task's worktree.
# Refuses if the worktree already exists (use `forge resume`).
_forge_add_worktree() {
  local container="$1" task_name="$2" mode
  mode=$(forge_container_mode "$container")

  if lxc exec "$container" -- su - aiuser -c "test -e /workspace/.trees/$task_name"; then
    echo "Error: worktree .trees/$task_name already exists in $container. Use 'forge resume $(forge_container_repo "$container") $task_name'." >&2
    return 1
  fi

  if [ "$mode" = "supervised" ]; then
    echo "Supervised container: skipping origin fetch (no credential); branching from last-known origin/main." >&2
  else
    echo "Refreshing main..."
    lxc exec "$container" -- su - aiuser -c "git -C /workspace fetch origin && git -C /workspace merge --ff-only origin/main"
  fi

  echo "Creating worktree .trees/$task_name on agent/$task_name..."
  lxc exec "$container" -- su - aiuser -c "git -C /workspace worktree add .trees/$task_name -b agent/$task_name origin/main"
}

# Attach (or create) the task's tmux session, running claude in its worktree.
_forge_attach_task() {
  local container="$1" task_name="$2"
  echo "Attaching to $container session '$task_name' as aiuser..."
  lxc exec "$container" -- su - aiuser -c "
    cd /workspace/.trees/$task_name
    tmux new-session -A -s '$task_name' 'claude --permission-mode auto --remote-control ${container}-${task_name}'
  "
}
```

**Note for the implementer:** the `_forge_provision_container` signature keeps `task_name` as its 3rd arg (it's used in the mode banner/messages), but it no longer creates a branch — the worktree is created by `_forge_add_worktree` after provisioning returns. Ensure `_forge_provision_container` no longer does any `git checkout -b`/`worktree add` itself (verified in Task 4).

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-forge-start.sh`
Expected: PASS. Also `bash -n scripts/forge scripts/lib/forge-start.sh`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/forge-start.sh tests/test-forge-start.sh
git commit -m "feat: forge start adds a per-task worktree and attaches its own session"
```

---

## Task 6: forge resume

**Files:**
- Create: `scripts/lib/forge-resume.sh`
- Modify: `scripts/forge` (source + dispatch + usage)
- Create: `tests/test-forge-resume.sh`
- Modify: `tests/test-forge-dispatcher.sh` (assert `resume` wired)

**Interfaces:**
- Consumes: `require_container_for_repo` (existing), `validate_owner_repo`, `validate_task_name`, `_forge_attach_task` (Task 5).
- Produces: `cmd_forge_resume <owner/repo> <task>` — re-attaches the task's session; errors if the worktree is absent. No fetch, no rebranch.

- [ ] **Step 1: Write the failing test**

Create `tests/test-forge-resume.sh`:

```bash
#!/bin/bash
# Tests structurels de scripts/lib/forge-resume.sh + wiring dans scripts/forge.
# Lancer : bash tests/test-forge-resume.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORGE="$ROOT/scripts/forge"
LIB="$ROOT/scripts/lib/forge-resume.sh"
PASS=0; FAIL=0
assert_contains() {
  if grep -qF -- "$2" "$1"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL (dans $1): $2"; fi
}

echo "bash -n syntax check..."
bash -n "$LIB"
bash -n "$FORGE"

# dispatcher wiring
assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-resume.sh"'
assert_contains "$FORGE" 'resume)'
assert_contains "$FORGE" 'cmd_forge_resume "$@"'

# behavior
assert_contains "$LIB" 'Usage: forge resume <owner/repo> <task>'
assert_contains "$LIB" 'validate_task_name "$task_name"'
assert_contains "$LIB" 'require_container_for_repo'
assert_contains "$LIB" 'test -e /workspace/.trees/$task_name'
assert_contains "$LIB" '_forge_attach_task "$container" "$task_name"'
# resume must NOT rebranch or worktree-add
if grep -qF -- 'worktree add' "$LIB"; then FAIL=$((FAIL + 1)); echo "FAIL: resume must not create a worktree"; else PASS=$((PASS + 1)); fi

echo ""; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-forge-resume.sh`
Expected: FAIL — `scripts/lib/forge-resume.sh` doesn't exist (`bash -n` errors).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/lib/forge-resume.sh`:

```bash
# forge resume <owner/repo> <task>
# Re-attaches the tmux session for an existing task worktree. No fetch, no
# rebranch — that's what `forge start` does. Errors if the worktree is absent.

cmd_forge_resume() {
  local owner_repo="$1" task_name="$2" container

  if [ -z "$owner_repo" ] || [ -z "$task_name" ]; then
    echo "Usage: forge resume <owner/repo> <task>" >&2
    return 1
  fi
  validate_owner_repo "$owner_repo" || return 1
  validate_task_name "$task_name" || return 1
  container=$(require_container_for_repo "$owner_repo") || return 1

  echo "Starting container $container..."
  if [ "$(lxc list "$container" -f json | jq -r '.[0].status')" != "Running" ]; then
    lxc start "$container"
  fi

  if ! lxc exec "$container" -- su - aiuser -c "test -e /workspace/.trees/$task_name"; then
    echo "Error: no worktree .trees/$task_name in $container. Start it with 'forge start $owner_repo $task_name'." >&2
    return 1
  fi

  _forge_attach_task "$container" "$task_name"
}
```

Wire it in `scripts/forge`:
- After `source "$FORGE_LIB_DIR/forge-start.sh"`, add `source "$FORGE_LIB_DIR/forge-resume.sh"`.
- Add a `resume)` case mirroring `start`:
  ```bash
    resume)
      shift
      cmd_forge_resume "$@"
      ;;
  ```
- Add to the usage heredoc:
  ```
    resume <owner/repo> <task>       Re-attach an existing task's session
  ```

Add to `tests/test-forge-dispatcher.sh` an assertion that `resume)` and `cmd_forge_resume "$@"` appear in `scripts/forge` (match that file's existing assertion style).

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-forge-resume.sh && bash tests/test-forge-dispatcher.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/forge-resume.sh scripts/forge tests/test-forge-resume.sh tests/test-forge-dispatcher.sh
git commit -m "feat: add forge resume to re-attach an existing task session"
```

---

## Task 7: forge finish

**Files:**
- Create: `scripts/lib/forge-finish.sh`
- Modify: `scripts/forge` (source + dispatch + usage)
- Create: `tests/test-forge-finish.sh`
- Modify: `tests/test-forge-dispatcher.sh` (assert `finish` wired)

**Interfaces:**
- Consumes: `require_container_for_repo`, `validate_owner_repo`, `validate_task_name`, `worktree_abspath` (Task 1), `_forge_check_one_worktree` (Task 2).
- Produces: `cmd_forge_finish <owner/repo> <task> [--force]` — WIP-checks the one worktree (unless `--force`), then `git worktree remove` and kills the task's tmux session. The branch ref is retained.

- [ ] **Step 1: Write the failing test**

Create `tests/test-forge-finish.sh`:

```bash
#!/bin/bash
# Tests structurels de scripts/lib/forge-finish.sh + wiring dans scripts/forge.
# Lancer : bash tests/test-forge-finish.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORGE="$ROOT/scripts/forge"
LIB="$ROOT/scripts/lib/forge-finish.sh"
PASS=0; FAIL=0
assert_contains() {
  if grep -qF -- "$2" "$1"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL (dans $1): $2"; fi
}

echo "bash -n syntax check..."
bash -n "$LIB"
bash -n "$FORGE"

assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-finish.sh"'
assert_contains "$FORGE" 'finish)'
assert_contains "$FORGE" 'cmd_forge_finish "$@"'

assert_contains "$LIB" 'Usage: forge finish <owner/repo> <task> [--force]'
assert_contains "$LIB" 'require_container_for_repo'
assert_contains "$LIB" '_forge_check_one_worktree'
assert_contains "$LIB" 'git -C /workspace worktree remove'
assert_contains "$LIB" 'tmux kill-session -t'
assert_contains "$LIB" '--force'

echo ""; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-forge-finish.sh`
Expected: FAIL — `scripts/lib/forge-finish.sh` missing.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/lib/forge-finish.sh`:

```bash
# forge finish <owner/repo> <task> [--force]
# Removes a task's worktree once its work is safely committed/pushed. Runs the
# WIP pre-flight on that worktree unless --force. The branch ref stays in .git,
# so a merged/abandoned branch can still be inspected or re-checked-out later.

cmd_forge_finish() {
  local owner_repo="$1" task_name="$2" force="${3:-}" container dir

  if [ -z "$owner_repo" ] || [ -z "$task_name" ]; then
    echo "Usage: forge finish <owner/repo> <task> [--force]" >&2
    return 1
  fi
  validate_owner_repo "$owner_repo" || return 1
  validate_task_name "$task_name" || return 1
  container=$(require_container_for_repo "$owner_repo") || return 1

  dir=$(worktree_abspath "$task_name")
  if ! lxc exec "$container" -- su - aiuser -c "test -e $dir"; then
    echo "Error: no worktree .trees/$task_name in $container." >&2
    return 1
  fi

  if [ "$force" != "--force" ]; then
    _forge_check_one_worktree "$container" "$dir" || return 1
  fi

  echo "Removing worktree .trees/$task_name..."
  local remove_flags="worktree remove"
  if [ "$force" = "--force" ]; then
    remove_flags="worktree remove --force"
  fi
  lxc exec "$container" -- su - aiuser -c "git -C /workspace $remove_flags .trees/$task_name"

  # Best-effort: tear down the task's session if it's still around.
  lxc exec "$container" -- su - aiuser -c "tmux kill-session -t $task_name 2>/dev/null || true"

  echo "Finished task $task_name (branch agent/$task_name retained)."
}
```

Wire it in `scripts/forge` (source line, `finish)` case, usage entry `finish <owner/repo> <task>   Remove a finished task's worktree`), and add the dispatcher assertions to `tests/test-forge-dispatcher.sh`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-forge-finish.sh && bash tests/test-forge-dispatcher.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/forge-finish.sh scripts/forge tests/test-forge-finish.sh tests/test-forge-dispatcher.sh
git commit -m "feat: add forge finish to remove a completed task worktree"
```

---

## Task 8: forge list — per-task rows + build-vs-latest flag

**Files:**
- Modify: `scripts/lib/forge-list.sh`
- Test: `tests/test-forge-list.sh`

**Interfaces:**
- Consumes: `list_forge_containers`, `forge_container_repo`, `forge_container_mode` (existing); `current_image_commit`, `container_image_commit`, `build_status`, `_forge_worktree_dirs` (Tasks 1–2).
- Produces: a listing where each container is a header row `CONTAINER REPO MODE STATE BUILD` (container name at column 0), followed by indented task rows `  <task>  agent/<task>  <session-state>`.

**Design notes:**
- Keep the container header line starting with the container name at column 0 and **REPO as the 2nd whitespace field** — Task 9's completion parses `awk '/^agent-/{print $2}'`.
- BUILD column: compute `build_status "$(container_image_commit "$name")" "$latest"`; render `✓` for `up-to-date`, `⚠ behind (<c>→<l>)` for `behind`, `? unknown` otherwise. Short-hash the commits with `cut -c1-7`.
- Per task: session state via `tmux has-session -t <task>` (session names are the task names now). Derive `<task>` as the basename of each worktree dir, and its branch as `agent/<task>`.
- Only inspect worktrees/sessions for `Running` containers.

- [ ] **Step 1: Write the failing test**

Rewrite `tests/test-forge-list.sh` to assert structurally (it currently checks the header/columns). Add:

```bash
# header keeps CONTAINER then REPO as the first two columns (completion parses $2)
assert_contains 'CONTAINER'
assert_contains 'REPO'
assert_contains 'BUILD'
# per-task rows + session probe by task name
assert_contains '_forge_worktree_dirs'
assert_contains 'tmux has-session -t'
# build flag
assert_contains 'build_status'
assert_contains 'container_image_commit'
assert_contains 'current_image_commit'
```

(Use the same `assert_contains`/`$LIB` structure as the current `tests/test-forge-list.sh`; if it currently sources and runs, keep it structural via `grep` against `$LIB` since these paths call `lxc`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-forge-list.sh`
Expected: FAIL — new patterns absent.

- [ ] **Step 3: Write minimal implementation**

Replace `cmd_forge_list` in `scripts/lib/forge-list.sh`:

```bash
# forge list — one header row per agent-* container (repo, mode, state, and
# whether it's running an older image than the latest build), followed by an
# indented row per feature worktree (task, branch, session state).
cmd_forge_list() {
  local name repo mode status latest c_commit build task dir sess

  latest=$(current_image_commit)

  printf '%-28s %-26s %-11s %-9s %s\n' "CONTAINER" "REPO" "MODE" "STATE" "BUILD"
  for name in $(list_forge_containers); do
    repo=$(forge_container_repo "$name")
    mode=$(forge_container_mode "$name")
    status=$(lxc list "$name" -f json | jq -r '.[0].status')

    c_commit=$(container_image_commit "$name")
    case "$(build_status "$c_commit" "$latest")" in
      up-to-date) build="ok" ;;
      behind)     build="behind ($(echo "$c_commit" | cut -c1-7)->$(echo "$latest" | cut -c1-7))" ;;
      *)          build="unknown" ;;
    esac

    printf '%-28s %-26s %-11s %-9s %s\n' "$name" "${repo:--}" "${mode:--}" "$status" "$build"

    if [ "$status" = "Running" ]; then
      while IFS= read -r dir; do
        [ -z "$dir" ] && continue
        task=$(basename "$dir")
        if lxc exec "$name" -- su - aiuser -c "tmux has-session -t $task" > /dev/null 2>&1; then
          sess="attached"
        else
          sess="detached"
        fi
        printf '  %-24s %-24s %s\n' "$task" "agent/$task" "$sess"
      done < <(_forge_worktree_dirs "$name")
    fi
  done
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-forge-list.sh`
Expected: PASS. Also `bash -n scripts/lib/forge-list.sh`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/forge-list.sh tests/test-forge-list.sh
git commit -m "feat: forge list shows per-task worktrees and stale-build flag"
```

---

## Task 9: completion — resume/finish + robust repo parsing

**Files:**
- Modify: `scripts/lib/forge-completion.sh`
- Test: `tests/test-forge-completion.sh`

**Interfaces:**
- Produces: an updated completion function offering `resume`/`finish` as first-word commands and completing `<owner/repo>` for `start|resume|finish|stop|delete` by parsing only container header rows (`^agent-`, field 2).

- [ ] **Step 1: Write the failing test**

In `tests/test-forge-completion.sh` add:

```bash
assert_contains 'start stop delete list image completion resume finish'
assert_contains 'start|stop|delete|resume|finish)'
assert_contains "awk '/^agent-/{print \$2}'"
```

(Match the file's existing `assert_contains`/`$LIB` helper.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-forge-completion.sh`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `scripts/lib/forge-completion.sh`, update the emitted function:

- First-word command list:
  ```bash
    COMPREPLY=($(compgen -W "start stop delete list image completion resume finish" -- "$cur"))
  ```
- Repo-completing case — add `resume|finish` and parse only container rows (the new list format indents task rows, so anchor on `^agent-` and take field 2 = REPO):
  ```bash
    start|stop|delete|resume|finish)
      local repos
      repos=$(forge list 2>/dev/null | awk '/^agent-/{print $2}' | grep -v '^-$')
      COMPREPLY=($(compgen -W "$repos" -- "$cur"))
      ;;
  ```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-forge-completion.sh`
Expected: PASS. Also `bash -n scripts/lib/forge-completion.sh`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/forge-completion.sh tests/test-forge-completion.sh
git commit -m "feat: complete resume/finish and parse repos from container rows"
```

---

## Task 10: Remove next-task

**Files:**
- Delete: `config/next-task.sh`, `tests/test-next-task.sh`
- Verify: no remaining references in `scripts/` or `config/` (docs handled in Tasks 11–12).

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

Add a guard to `tests/test-forge-common.sh` (runs in the default suite) that fails while `next-task` still exists in shipped code:

```bash
# next-task is retired: no shipped script should reference it
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if grep -rInF -- 'next-task' "$ROOT_DIR/scripts" "$ROOT_DIR/config" 2>/dev/null; then
  FAIL=$((FAIL + 1)); echo "FAIL: next-task still referenced under scripts/ or config/"
else
  PASS=$((PASS + 1))
fi
if [ -e "$ROOT_DIR/config/next-task.sh" ]; then
  FAIL=$((FAIL + 1)); echo "FAIL: config/next-task.sh still exists"
else
  PASS=$((PASS + 1))
fi
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-forge-common.sh`
Expected: FAIL — `config/next-task.sh` still present (its image push was already removed in Task 3; confirm nothing else references it).

- [ ] **Step 3: Write minimal implementation**

```bash
git rm config/next-task.sh tests/test-next-task.sh
```

Then grep and clean any stray reference under `scripts/`/`config/` (Task 3 already removed the image push; there should be none left):

Run: `grep -rInF -- 'next-task' scripts config` → expect no output.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-forge-common.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove next-task (subsumed by forge start + worktrees)"
```

---

## Task 11: Docs — template CLAUDE.md

Update the agent-facing template so provisioned agents understand the worktree model and no longer hear about `next-task`.

**Files:**
- Modify: `templates/CLAUDE.md`
- Test: `tests/test-claude-template.sh`

**Interfaces:** none (documentation).

- [ ] **Step 1: Write the failing test**

In `tests/test-claude-template.sh` (match its existing assert helper against the template file):

```bash
assert_not_contains 'next-task'
assert_contains '.trees/'
assert_contains 'worktree'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-claude-template.sh`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `templates/CLAUDE.md`:
- Remove the `!next-task <nom>` reuse paragraph.
- Add a short note under the environment/git section, e.g.:

```markdown
- **Workspace & worktrees** : `/workspace` est le clone principal, épinglé sur `main` — n'y committe jamais. Ton travail se fait dans un git worktree `/workspace/.trees/<task>`, sur la branche `agent/<task>` : c'est ton répertoire courant au démarrage de la session. Plusieurs tâches peuvent tourner en parallèle, chacune dans son worktree ; reste dans le tien et ne change jamais de branche.
```

- Keep the existing "toujours rester sur `agent/*`, ne jamais changer de branche" guarantee (it now describes the per-worktree branch).

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-claude-template.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add templates/CLAUDE.md tests/test-claude-template.sh
git commit -m "docs: template describes the worktree model, drops next-task"
```

---

## Task 12: Docs — README

**Files:**
- Modify: `README.md`
- Test: `tests/test-readme-docs.sh`

**Interfaces:** none (documentation).

- [ ] **Step 1: Write the failing test**

In `tests/test-readme-docs.sh` (match its existing assert helper against `README.md`):

```bash
assert_not_contains 'next-task'
assert_contains 'forge resume'
assert_contains 'forge finish'
assert_contains 'worktree'
assert_contains 'git-lfs'
assert_contains 'older than latest build'
```

(If the helper is named differently, mirror the file's own convention.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-readme-docs.sh`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Update `README.md`:
- **Commands**: document `forge start <owner/repo> <task>`, `forge resume <owner/repo> <task>`, `forge finish <owner/repo> <task> [--force]`; update `stop`/`delete`/`list`.
- **Mental model**: one container per repo; `/workspace` stays on `main`; features live in `/workspace/.trees/<task>` as worktrees with a per-task tmux session named after the task; run several in parallel.
- **Fresh main**: every `forge start` fetches + fast-forwards `main` (autonomous); supervised skips the fetch (no credential) and branches from last-known `origin/main`.
- **git-lfs**: shipped in `agent-base`, `git lfs install` run at provisioning.
- **Versioning**: `forge image build` stamps the build commit; `forge list` flags containers running an image `older than latest build` — recreate (`delete` + `start`) to refresh. The operator decides when to rebuild the image.
- **Remove** the `!next-task <short-name>` reuse section (both the autonomous and supervised paragraphs) and the supervised "fetch main yourself before next-task" note; replace with: to work on another feature, run `forge start <owner/repo> <other-task>` (adds a worktree, no re-provision).
- Keep the supervised retrieval instructions (`git remote add … ssh://…`, `git fetch … agent/<task>:agent/<task>`) — still valid; branches live in the shared `.git`.

- [ ] **Step 2 (repeat): Run test to verify it fails**, then implement, then:

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-readme-docs.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md tests/test-readme-docs.sh
git commit -m "docs: README covers worktrees, resume/finish, git-lfs, versioning"
```

---

## Final verification

- [ ] **Run the whole suite:**

```bash
for t in tests/test-*.sh; do echo "== $t =="; bash "$t" || echo "FAILED: $t"; done
```

Expected: every test prints `PASS=… FAIL=0`; no `FAILED:` line.

- [ ] **Grep sweep for leftovers:**

```bash
grep -rInF -- 'next-task' . --exclude-dir=.git --exclude-dir=docs
```

Expected: no output (docs/specs may still mention it historically; the `--exclude-dir=docs` keeps the sweep to shipped code).

- [ ] **Syntax-check every script:**

```bash
bash -n scripts/forge && for f in scripts/lib/forge-*.sh; do bash -n "$f"; done && echo OK
```

Expected: `OK`.

Note: LXD/`lxc` behavior (real provisioning, worktree creation, tmux attach, image stamping) can't be exercised in the test container — it's validated structurally here and must be smoke-tested on the host by the operator: `forge image build`, then `forge start <owner/repo> a`, `forge start <owner/repo> b` (two parallel sessions), `forge list`, `forge resume … a`, `forge finish … a`.
