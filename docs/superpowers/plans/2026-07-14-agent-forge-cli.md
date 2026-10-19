# agent-forge CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two loose scripts (`new-agent-container.sh`, `start-agent.sh`) with a single `forge` CLI that derives container identity from `owner/repo` (no free-form project name, no separate registry file), collapses provisioning and session-start into `forge start`, and adds `stop`/`delete`/`list`/`image build`/`completion bash` subcommands plus a baked-in `next-task` helper for reusing a container across sequential tasks.

**Architecture:** `scripts/forge` is a thin dispatcher (`case "$1" in ...`) that sources `scripts/lib/forge-common.sh` (naming/validation/discovery helpers) and one `scripts/lib/forge-<subcommand>.sh` per subcommand. LXD container config keys (`user.forge.repo`, `user.forge.mode`), read via `lxc config get` and discovered via `lxc list -f json | jq`, are the only state — no registry file. `config/next-task.sh` is a new standalone script, pushed into the `agent-base` image (not per-container) by `forge image build`, invoked by the human operator via `!next-task <name>` inside a live session.

**Tech Stack:** Bash, LXD (`lxc`), `jq` (container discovery + tests).

**Spec:** `docs/superpowers/specs/2026-07-14-agent-forge-cli-design.md`

## Global Constraints

- Bash strict mode: `set -e` mandatory in every directly-executed script (`scripts/forge`, `config/next-task.sh`). Files under `scripts/lib/` are sourced, not executed directly, and define functions only — no top-level `set -e` needed there, but every function must still check its own preconditions.
- Variables always quoted: `"$VAR"`, never `$VAR`.
- Precondition checks at the top of each subcommand function (container exists, image exists, credential file exists, etc.) before mutating anything.
- Never hardcode credentials, keys, or tokens. The GitHub PAT is piped in and never written to host disk; the Claude credential is pushed from the host at provisioning time, never stored in the `agent-base` image or this repo.
- File-path style: hardcoded `/home/<user>/...` paths (workspace dir, signing key, `agent-forge` checkout), matching the existing scripts — no `$HOME`.
- No separate registry file. Container discovery and repo/mode lookup go through `lxc list -f json` + `lxc config get user.forge.*` exclusively (design spec §1) — do not introduce a JSON/YAML state file as a shortcut.
- This repo is edited from inside an agent container with no `lxc` binary and no LXD host to talk to. Nothing involving `lxc` can be executed while implementing this plan. Locally testable: `bash -n` syntax checks, direct execution of pure-bash functions (`sanitize_container_name`, `validate_owner_repo` — no `lxc` call inside them), and grep-based structural/ordering assertions on script *text* for everything that does call `lxc`. Real end-to-end behavior is verified on the real server (Task 10, manual, not run by the implementing agent).
- **This container's own `pre-bash.sh` hook blocks the standalone word `sudo`** (bounded by whitespace or line start/end) in any command passed to the Bash tool — including inside a `git commit -m` message. Avoid the bare word `sudo` in any command you actually *run*; it's fine inside file *content* written via Edit/Write.
- Commit messages: conventional (`feat:`, `fix:`, `chore:`, `docs:`), auto-signed, one commit per task.
- `new-agent-container.sh` and `start-agent.sh` keep working, unmodified, until Task 9 — don't touch or partially migrate them before then, so every intermediate commit leaves the repo in a working state.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/lib/forge-common.sh` (create) | `sanitize_container_name`, `validate_owner_repo` (pure bash), `list_forge_containers`, `forge_container_repo`, `forge_container_mode`, `container_for_repo`, `check_container_name_collision`, `require_container_for_repo` (all `lxc`-calling). |
| `scripts/lib/forge-start.sh` (create) | `cmd_forge_start` (provision-if-missing + start/attach), `_forge_provision_container` (today's `new-agent-container.sh` body, adapted). |
| `scripts/lib/forge-stop.sh` (create) | `cmd_forge_stop`. |
| `scripts/lib/forge-delete.sh` (create) | `cmd_forge_delete`, `_forge_check_wip_before_delete`. |
| `scripts/lib/forge-list.sh` (create) | `cmd_forge_list`. |
| `scripts/lib/forge-image.sh` (create) | `cmd_forge_image`, `_forge_image_build` (today's README §5 manual steps, scripted, plus installing `next-task`). |
| `scripts/lib/forge-completion.sh` (create) | `cmd_forge_completion_bash`. |
| `scripts/forge` (create) | Dispatcher: sources all `scripts/lib/forge-*.sh`, `case "$1" in start\|stop\|delete\|list\|image\|completion\|--help)` dispatch. |
| `config/next-task.sh` (create) | Standalone script baked into `agent-base` at `/home/aiuser/.local/bin/next-task`; refuses on dirty/unpushed tree, else `git fetch origin && git checkout -b agent/<name> origin/main`. |
| `templates/CLAUDE.md` (modify) | One-line informational note about `!next-task` container reuse. |
| `README.md` (modify) | Usage section rewritten around `forge`; completion setup; `!next-task` subsection; §5 reframed as `forge image build`. |
| `scripts/new-agent-container.sh`, `scripts/start-agent.sh` (delete, Task 9) | Retired — fully replaced by `forge start`. |
| `tests/test-forge-common.sh` (create) | Executes `sanitize_container_name`/`validate_owner_repo` directly; grep-checks the `lxc`-calling helpers. |
| `tests/test-forge-start.sh` (create) | Structural assertions on `scripts/forge` + `scripts/lib/forge-start.sh`. |
| `tests/test-forge-stop.sh` (create) | Structural assertions on `scripts/forge` + `scripts/lib/forge-stop.sh`. |
| `tests/test-forge-delete.sh` (create) | Structural assertions on `scripts/forge` + `scripts/lib/forge-delete.sh`. |
| `tests/test-forge-list.sh` (create) | Structural assertions on `scripts/forge` + `scripts/lib/forge-list.sh`. |
| `tests/test-forge-image.sh` (create) | Structural assertions on `scripts/forge` + `scripts/lib/forge-image.sh`. |
| `tests/test-forge-completion.sh` (create) | Structural assertions on `scripts/forge` + `scripts/lib/forge-completion.sh`. |
| `tests/test-next-task.sh` (create) | `bash -n` + structural assertions on `config/next-task.sh`; also checks `templates/CLAUDE.md` mentions `next-task`. |
| `tests/test-readme-docs.sh` (modify, Task 9) | Extended with `forge`-era assertions. |
| `tests/test-new-agent-container.sh`, `tests/test-start-agent.sh` (delete, Task 9) | Tested a now-deleted script. |

---

### Task 1: `scripts/lib/forge-common.sh` — naming, validation, discovery

**Files:**
- Create: `scripts/lib/forge-common.sh`
- Test: Create `tests/test-forge-common.sh`

**Interfaces:**
- Consumes: nothing (foundational library).
- Produces: `sanitize_container_name(owner_repo) -> echoes container name`, `validate_owner_repo(owner_repo) -> return 0/1, stderr on failure`, `list_forge_containers() -> echoes one container name per line`, `forge_container_repo(container) -> echoes stored owner/repo`, `forge_container_mode(container) -> echoes stored mode`, `container_for_repo(owner_repo) -> echoes container name, return 1 if none`, `check_container_name_collision(container, owner_repo) -> return 0/1, stderr on mismatch`, `require_container_for_repo(owner_repo) -> echoes container name, return 1 with stderr if none`. All of Tasks 2-6 call these by name — do not rename.

- [ ] **Step 1: Write the failing test**

Create `tests/test-forge-common.sh`:

```bash
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-forge-common.sh`
Expected: FAIL at `bash -n "$LIB"` — the file doesn't exist yet, so the whole script aborts under `set -e` before any PASS/FAIL counting.

- [ ] **Step 3: Implement**

Create `scripts/lib/forge-common.sh`:

```bash
# Shared helpers for the forge CLI: name sanitization, owner/repo
# validation, and container discovery via LXD config keys — no separate
# registry file (docs/superpowers/specs/2026-07-14-agent-forge-cli-design.md §1).

# Derives the deterministic container name for a given owner/repo.
# Lowercases, then collapses any run of non-[a-z0-9-] chars to a single "-".
sanitize_container_name() {
  local owner_repo="$1"
  local sanitized
  sanitized=$(echo "$owner_repo" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g')
  echo "agent-${sanitized}"
}

# Validates <owner>/<repo> format. Prints an error and returns 1 on mismatch.
validate_owner_repo() {
  local owner_repo="$1"
  if ! echo "$owner_repo" | grep -qE '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'; then
    echo "Error: repo must be <owner>/<repo>, got: $owner_repo" >&2
    return 1
  fi
}

# Lists all agent-* container names, one per line.
list_forge_containers() {
  lxc list -f json | jq -r '.[] | select(.name | startswith("agent-")) | .name'
}

# Echoes the owner/repo stored on a container, empty if unset.
forge_container_repo() {
  lxc config get "$1" user.forge.repo
}

# Echoes the mode stored on a container, empty if unset.
forge_container_mode() {
  lxc config get "$1" user.forge.mode
}

# Echoes the container name already provisioned for a given owner/repo;
# empty output and non-zero exit if none exists yet.
container_for_repo() {
  local owner_repo="$1" name existing
  for name in $(list_forge_containers); do
    existing=$(forge_container_repo "$name")
    if [ "$existing" = "$owner_repo" ]; then
      echo "$name"
      return 0
    fi
  done
  return 1
}

# Fails loudly if a container already exists under the derived name but for
# a *different* repo (naming collision), instead of silently reusing it.
check_container_name_collision() {
  local container="$1" owner_repo="$2" existing
  if lxc info "$container" > /dev/null 2>&1; then
    existing=$(forge_container_repo "$container")
    if [ -n "$existing" ] && [ "$existing" != "$owner_repo" ]; then
      echo "Error: container $container already exists for a different repo ($existing), refusing to reuse it for $owner_repo." >&2
      return 1
    fi
  fi
}

# Errors out (stderr) if no container exists yet for the given repo.
require_container_for_repo() {
  local owner_repo="$1" container
  if ! container=$(container_for_repo "$owner_repo"); then
    echo "Error: no container found for $owner_repo. Run 'forge start $owner_repo' first." >&2
    return 1
  fi
  echo "$container"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-forge-common.sh`
Expected: `PASS=11 FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/forge-common.sh tests/test-forge-common.sh
git commit -m "$(cat <<'EOF'
feat: add forge-common.sh with container naming and discovery helpers

Foundational library for the forge CLI: deterministic container naming
from owner/repo, owner/repo format validation, and LXD-config-key-based
discovery (no separate registry file — LXD's own state is authoritative).
EOF
)"
```

---

### Task 2: `scripts/forge` dispatcher + `forge start`

**Files:**
- Create: `scripts/forge`
- Create: `scripts/lib/forge-start.sh`
- Test: Create `tests/test-forge-start.sh`

**Interfaces:**
- Consumes: `sanitize_container_name`, `validate_owner_repo`, `check_container_name_collision` from Task 1's `forge-common.sh`.
- Produces: `scripts/forge` executable dispatcher sourcing `scripts/lib/forge-common.sh` and `scripts/lib/forge-start.sh`, with a `usage()` function and `case "${1:-}" in start) shift; cmd_forge_start "$@" ;; ...)`. Tasks 3-7 each add one more `source` line and one more `case` branch to this same file — do not restructure the dispatch pattern.

- [ ] **Step 1: Write the failing test**

Create `tests/test-forge-start.sh`:

```bash
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
assert_contains "$LIB" 'shift=true'
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
assert_contains "$LIB" 'agent/$task_name'
assert_contains "$LIB" 'already exists; task-name'
assert_contains "$LIB" '--permission-mode auto'
assert_contains "$LIB" 'tmux new-session'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-forge-start.sh`
Expected: FAIL at `bash -n "$FORGE"` — neither file exists yet.

- [ ] **Step 3: Implement**

Create `scripts/lib/forge-start.sh`:

```bash
# forge start <owner/repo> [task-name]
# Provisions a container if none exists yet for the repo, then starts/attaches
# a Claude Code session inside it. See design spec §2.

cmd_forge_start() {
  local owner_repo="$1" task_name="${2:-main}"

  if [ -z "$owner_repo" ]; then
    echo "Usage: forge start <owner/repo> [task-name]" >&2
    return 1
  fi
  validate_owner_repo "$owner_repo" || return 1

  local container
  container=$(sanitize_container_name "$owner_repo")
  check_container_name_collision "$container" "$owner_repo" || return 1

  if lxc info "$container" > /dev/null 2>&1; then
    if [ -n "${2:-}" ]; then
      echo "Warning: container $container already exists; task-name '$task_name' ignored." >&2
    fi
  else
    _forge_provision_container "$container" "$owner_repo" "$task_name" || return 1
  fi

  echo "Starting container $container..."
  if [ "$(lxc list "$container" -f json | jq -r '.[0].status')" != "Running" ]; then
    lxc start "$container"
  fi

  echo "Attaching to $container as aiuser..."
  lxc exec "$container" -- su - aiuser -c "
    cd /workspace
    tmux new-session -A -s claude 'claude --permission-mode auto --remote-control ${container}'
  "
}

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

  echo "Creating container $container..."
  lxc launch agent-base "$container" --profile agent

  # Supprime le compte ubuntu laissé par cloud-init qui peut avoir NOPASSWD:ALL sudo
  echo "Removing cloud-init ubuntu backdoor..."
  lxc exec "$container" -- deluser --remove-home ubuntu 2>/dev/null || true
  lxc exec "$container" -- rm -f /etc/sudoers.d/90-cloud-init-users

  echo "Mounting workspace..."
  local workspace_dir="/home/<user>/workspaces/$container"
  mkdir -p "$workspace_dir"
  chmod 750 "$workspace_dir"
  # shift=true : idmap shifting LXD — le dossier reste possédé par l'utilisateur
  # hôte courant, pas besoin de chown vers l'UID mappé du container.
  lxc config device add "$container" workspace disk \
    source="$workspace_dir" \
    path=/workspace \
    shift=true

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
  lxc file push /home/moroine/agent-forge/config/claude-onboarding-state.json "$container"/home/aiuser/.claude.json --uid 1001 --gid 1001 --mode 600

  echo "Updating Claude Code to latest..."
  lxc exec "$container" -- npm install -g @anthropic-ai/claude-code@latest

  echo "Installing Claude plugins..."
  lxc exec "$container" -- su - aiuser -c "claude plugin marketplace add anthropics/claude-plugins-official && claude plugin install superpowers@claude-plugins-official"

  echo "Installing Claude security hooks..."
  lxc exec "$container" -- mkdir -p /home/aiuser/.claude/hooks
  lxc file push /home/moroine/agent-forge/.claude/hooks/pre-bash.sh \
    "$container"/home/aiuser/.claude/hooks/pre-bash.sh \
    --uid 0 --gid 0 --mode 755
  lxc file push /home/moroine/agent-forge/config/claude-container-settings.json \
    "$container"/home/aiuser/.claude/settings.json \
    --uid 0 --gid 0 --mode 644

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

  echo "Recording forge metadata..."
  lxc config set "$container" user.forge.repo "$owner_repo"
  lxc config set "$container" user.forge.mode "autonomous"

  echo "Container $container provisioned."
}
```

Create `scripts/forge`:

```bash
#!/bin/bash
set -e

# forge — single entry point for agent-forge container lifecycle.
# Subcommands live in scripts/lib/forge-*.sh, sourced below.

FORGE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
source "$FORGE_LIB_DIR/forge-common.sh"
source "$FORGE_LIB_DIR/forge-start.sh"

usage() {
  cat <<'EOF'
Usage: forge <command> [args]

Commands:
  start <owner/repo> [task-name]   Provision (if needed) and start/attach a session
EOF
}

case "${1:-}" in
  start)
    shift
    cmd_forge_start "$@"
    ;;
  ""|-h|--help)
    usage
    ;;
  *)
    echo "Error: unknown command '$1'" >&2
    usage >&2
    exit 1
    ;;
esac
```

Make it executable:

```bash
chmod 755 scripts/forge
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-forge-start.sh`
Expected: `PASS=20 FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/forge scripts/lib/forge-start.sh tests/test-forge-start.sh
git commit -m "$(cat <<'EOF'
feat: add forge CLI dispatcher and forge start

forge start <owner/repo> [task-name] collapses provisioning and session
launch into one command: provisions a container (idmap-shifted mount,
credential/onboarding push, plugin install, PAT prompt, clone) only if
none exists yet for the repo, records owner/repo and mode as LXD config
keys, then always starts/attaches a tmux+claude session in auto
permission mode. new-agent-container.sh and start-agent.sh are untouched
for now — cutover happens once every subcommand exists (see Task 9).
EOF
)"
```

---

### Task 3: `forge stop`

**Files:**
- Create: `scripts/lib/forge-stop.sh`
- Modify: `scripts/forge` (add source line + `stop)` case branch + usage line)
- Test: Create `tests/test-forge-stop.sh`

**Interfaces:**
- Consumes: `require_container_for_repo` (Task 1).
- Produces: none consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Create `tests/test-forge-stop.sh`:

```bash
#!/bin/bash
# Tests structurels de scripts/forge (dispatch "stop") et
# scripts/lib/forge-stop.sh. Lancer : bash tests/test-forge-stop.sh
set -e

FORGE="$(cd "$(dirname "$0")/.." && pwd)/scripts/forge"
LIB="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/forge-stop.sh"
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

echo "bash -n syntax check..."
bash -n "$FORGE"
bash -n "$LIB"

assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-stop.sh"'
assert_contains "$FORGE" 'stop)'
assert_contains "$FORGE" 'cmd_forge_stop "$@"'

assert_contains "$LIB" 'require_container_for_repo'
assert_contains "$LIB" 'lxc stop'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-forge-stop.sh`
Expected: FAIL at `bash -n "$LIB"` — file doesn't exist yet.

- [ ] **Step 3: Implement**

Create `scripts/lib/forge-stop.sh`:

```bash
# forge stop <owner/repo>

cmd_forge_stop() {
  local owner_repo="$1" container

  if [ -z "$owner_repo" ]; then
    echo "Usage: forge stop <owner/repo>" >&2
    return 1
  fi
  container=$(require_container_for_repo "$owner_repo") || return 1

  echo "Stopping container $container..."
  lxc stop "$container"
}
```

In `scripts/forge`, add the source line after the `forge-start.sh` source:

```bash
source "$FORGE_LIB_DIR/forge-stop.sh"
```

Add to `usage()`'s heredoc, after the `start` line:

```
  stop <owner/repo>                Stop a container (workspace/auth/tmux state persists)
```

Add a case branch after `start)`'s closing `;;`:

```bash
  stop)
    shift
    cmd_forge_stop "$@"
    ;;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-forge-stop.sh`
Expected: `PASS=5 FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/forge scripts/lib/forge-stop.sh tests/test-forge-stop.sh
git commit -m "feat: add forge stop subcommand"
```

---

### Task 4: `forge delete`

**Files:**
- Create: `scripts/lib/forge-delete.sh`
- Modify: `scripts/forge` (add source line + `delete)` case branch + usage line)
- Test: Create `tests/test-forge-delete.sh`

**Interfaces:**
- Consumes: `require_container_for_repo` (Task 1).
- Produces: none consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Create `tests/test-forge-delete.sh`:

```bash
#!/bin/bash
# Tests structurels de scripts/forge (dispatch "delete") et
# scripts/lib/forge-delete.sh. Lancer : bash tests/test-forge-delete.sh
set -e

FORGE="$(cd "$(dirname "$0")/.." && pwd)/scripts/forge"
LIB="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/forge-delete.sh"
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

echo "bash -n syntax check..."
bash -n "$FORGE"
bash -n "$LIB"

assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-delete.sh"'
assert_contains "$FORGE" 'delete)'
assert_contains "$FORGE" 'cmd_forge_delete "$@"'

assert_contains "$LIB" 'require_container_for_repo'
assert_contains "$LIB" '--force'
assert_contains "$LIB" 'git status --porcelain'
assert_contains "$LIB" '_forge_check_wip_before_delete'
assert_contains "$LIB" 'lxc delete "$container" --force'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-forge-delete.sh`
Expected: FAIL at `bash -n "$LIB"` — file doesn't exist yet.

- [ ] **Step 3: Implement**

Create `scripts/lib/forge-delete.sh`:

```bash
# forge delete <owner/repo> [--force]
# WIP pre-flight (dirty tree / unpushed commits) unless --force. The
# workspace directory itself is host-mounted and survives regardless — this
# check exists to surface *forgotten* WIP before re-provisioning re-clones
# fresh, not to prevent actual data loss.

cmd_forge_delete() {
  local owner_repo="$1" force="${2:-}" container

  if [ -z "$owner_repo" ]; then
    echo "Usage: forge delete <owner/repo> [--force]" >&2
    return 1
  fi
  container=$(require_container_for_repo "$owner_repo") || return 1

  if [ "$force" != "--force" ]; then
    _forge_check_wip_before_delete "$container" || return 1
  fi

  echo "Deleting container $container..."
  lxc delete "$container" --force
}

_forge_check_wip_before_delete() {
  local container="$1" dirty unpushed branch

  dirty=$(lxc exec "$container" -- su - aiuser -c "cd /workspace && git status --porcelain")
  if [ -n "$dirty" ]; then
    echo "Error: $container has uncommitted changes in /workspace:" >&2
    echo "$dirty" >&2
    echo "Commit/discard them, or pass --force." >&2
    return 1
  fi

  branch=$(lxc exec "$container" -- su - aiuser -c "cd /workspace && git rev-parse --abbrev-ref HEAD")
  unpushed=$(lxc exec "$container" -- su - aiuser -c "cd /workspace && git log --oneline origin/$branch..$branch" 2>/dev/null || true)
  if [ -n "$unpushed" ]; then
    echo "Error: $container has unpushed commits on $branch:" >&2
    echo "$unpushed" >&2
    echo "Push them, or pass --force." >&2
    return 1
  fi
}
```

In `scripts/forge`, add the source line:

```bash
source "$FORGE_LIB_DIR/forge-delete.sh"
```

Add to `usage()`, after the `stop` line:

```
  delete <owner/repo> [--force]    Delete a container (blocked on dirty/unpushed WIP unless --force)
```

Add a case branch after `stop)`'s closing `;;`:

```bash
  delete)
    shift
    cmd_forge_delete "$@"
    ;;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-forge-delete.sh`
Expected: `PASS=8 FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/forge scripts/lib/forge-delete.sh tests/test-forge-delete.sh
git commit -m "feat: add forge delete subcommand with WIP pre-flight check"
```

---

### Task 5: `forge list`

**Files:**
- Create: `scripts/lib/forge-list.sh`
- Modify: `scripts/forge` (add source line + `list)` case branch + usage line)
- Test: Create `tests/test-forge-list.sh`

**Interfaces:**
- Consumes: `list_forge_containers`, `forge_container_repo`, `forge_container_mode` (Task 1).
- Produces: none consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Create `tests/test-forge-list.sh`:

```bash
#!/bin/bash
# Tests structurels de scripts/forge (dispatch "list") et
# scripts/lib/forge-list.sh. Lancer : bash tests/test-forge-list.sh
set -e

FORGE="$(cd "$(dirname "$0")/.." && pwd)/scripts/forge"
LIB="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/forge-list.sh"
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

echo "bash -n syntax check..."
bash -n "$FORGE"
bash -n "$LIB"

assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-list.sh"'
assert_contains "$FORGE" 'list)'
assert_contains "$FORGE" 'cmd_forge_list "$@"'

assert_contains "$LIB" 'list_forge_containers'
assert_contains "$LIB" 'forge_container_repo'
assert_contains "$LIB" 'forge_container_mode'
assert_contains "$LIB" 'tmux has-session -t claude'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-forge-list.sh`
Expected: FAIL at `bash -n "$LIB"` — file doesn't exist yet.

- [ ] **Step 3: Implement**

Create `scripts/lib/forge-list.sh`:

```bash
# forge list — one line per agent-* container: repo, mode, LXD state, and
# (for running containers) whether a claude tmux session is alive inside.

cmd_forge_list() {
  local name repo mode status tmux_alive

  printf '%-30s %-30s %-12s %-10s %s\n' "CONTAINER" "REPO" "MODE" "STATE" "SESSION"
  for name in $(list_forge_containers); do
    repo=$(forge_container_repo "$name")
    mode=$(forge_container_mode "$name")
    status=$(lxc list "$name" -f json | jq -r '.[0].status')

    tmux_alive="-"
    if [ "$status" = "Running" ]; then
      if lxc exec "$name" -- su - aiuser -c "tmux has-session -t claude" > /dev/null 2>&1; then
        tmux_alive="alive"
      else
        tmux_alive="none"
      fi
    fi

    printf '%-30s %-30s %-12s %-10s %s\n' "$name" "${repo:--}" "${mode:--}" "$status" "$tmux_alive"
  done
}
```

In `scripts/forge`, add the source line:

```bash
source "$FORGE_LIB_DIR/forge-list.sh"
```

Add to `usage()`, after the `delete` line:

```
  list                              Show all containers: repo, mode, state, session
```

Add a case branch after `delete)`'s closing `;;`:

```bash
  list)
    cmd_forge_list
    ;;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-forge-list.sh`
Expected: `PASS=7 FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/forge scripts/lib/forge-list.sh tests/test-forge-list.sh
git commit -m "feat: add forge list subcommand"
```

---

### Task 6: `next-task` script + `forge image build`

**Files:**
- Create: `config/next-task.sh`
- Create: `scripts/lib/forge-image.sh`
- Modify: `scripts/forge` (add source line + `image)` case branch + usage line)
- Modify: `templates/CLAUDE.md` (one-line note about `!next-task`)
- Test: Create `tests/test-next-task.sh`
- Test: Create `tests/test-forge-image.sh`

**Interfaces:**
- Consumes: nothing from earlier tasks (both files are independent of `forge-common.sh`).
- Produces: `config/next-task.sh`, pushed into `agent-base` by `_forge_image_build` at `/home/aiuser/.local/bin/next-task`; not consumed by any later task's code, only documented in Task 9's README update.

- [ ] **Step 1: Write the failing tests**

Create `tests/test-next-task.sh`:

```bash
#!/bin/bash
# Tests structurels de config/next-task.sh, et vérifie que
# templates/CLAUDE.md documente son existence.
# Lancer : bash tests/test-next-task.sh
set -e

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/config/next-task.sh"
TEMPLATE="$(cd "$(dirname "$0")/.." && pwd)/templates/CLAUDE.md"
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

echo "bash -n syntax check..."
bash -n "$SCRIPT"

assert_contains "$SCRIPT" 'git status --porcelain'
assert_contains "$SCRIPT" 'git log --oneline'
assert_contains "$SCRIPT" 'git fetch origin'
assert_contains "$SCRIPT" 'git checkout -b "agent/$SHORT_NAME" origin/main'

assert_contains "$TEMPLATE" 'next-task'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

Create `tests/test-forge-image.sh`:

```bash
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

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bash tests/test-next-task.sh`
Expected: FAIL at `bash -n "$SCRIPT"` — `config/next-task.sh` doesn't exist yet.

Run: `bash tests/test-forge-image.sh`
Expected: FAIL at `bash -n "$LIB"` — `scripts/lib/forge-image.sh` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `config/next-task.sh`:

```bash
#!/bin/bash
set -e

# next-task <short-name>
# Human-invoked (via `!next-task <name>` from inside a live Claude session),
# never by the agent itself — outside the agent's own tool loop, so
# pre-bash.sh's "the agent never switches branches" guarantee is untouched.
# Reuses the current container for a new task: refuses on dirty/unpushed
# WIP, then checks out a fresh branch from origin/main.

if [ -z "$1" ]; then
  echo "Usage: next-task <short-name>"
  exit 1
fi

SHORT_NAME="$1"
cd /workspace

DIRTY=$(git status --porcelain)
if [ -n "$DIRTY" ]; then
  echo "Error: /workspace has uncommitted changes:"
  echo "$DIRTY"
  echo "Commit or discard them first."
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
UNPUSHED=$(git log --oneline "origin/$CURRENT_BRANCH..$CURRENT_BRANCH" 2>/dev/null || true)
if [ -n "$UNPUSHED" ]; then
  echo "Error: branch $CURRENT_BRANCH has unpushed commits:"
  echo "$UNPUSHED"
  echo "Push them first, or they'll be left behind."
  exit 1
fi

git fetch origin
git checkout -b "agent/$SHORT_NAME" origin/main

echo "Ready on branch agent/$SHORT_NAME."
```

Create `scripts/lib/forge-image.sh`:

```bash
# forge image build (alias: forge image update)
# Scripts the manual agent-base build sequence from README §5, plus
# installing next-task. Only affects containers created after the rebuild —
# already-running containers are not patched in place.

cmd_forge_image() {
  case "${1:-}" in
    build|update)
      _forge_image_build
      ;;
    *)
      echo "Usage: forge image build|update" >&2
      return 1
      ;;
  esac
}

_forge_image_build() {
  local setup="agent-base-setup"

  if lxc info "$setup" > /dev/null 2>&1; then
    echo "Removing leftover $setup container from a previous failed build..."
    lxc delete "$setup" --force
  fi

  echo "Launching scratch container $setup..."
  lxc launch ubuntu:24.04 "$setup"

  lxc exec "$setup" -- apt update
  lxc exec "$setup" -- apt install -y git tmux curl wget unzip zip python3 python3-pip
  lxc exec "$setup" -- bash -c "curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -"
  lxc exec "$setup" -- apt install -y nodejs
  lxc exec "$setup" -- npm install -g pnpm
  lxc exec "$setup" -- npm install -g @anthropic-ai/claude-code
  lxc exec "$setup" -- bash -c 'mkdir -p -m 755 /etc/apt/keyrings && wget -qO /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg'
  lxc exec "$setup" -- bash -c 'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list'
  lxc exec "$setup" -- bash -c 'apt update && apt install -y gh'
  lxc exec "$setup" -- bash -c "wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb && apt install -y --fix-missing /tmp/chrome.deb"
  lxc exec "$setup" -- useradd -m -s /bin/bash aiuser
  lxc exec "$setup" -- bash -c "mkdir -p /workspace /home/aiuser/.ssh /home/aiuser/.claude /home/aiuser/.local/bin && chown aiuser:aiuser /workspace /home/aiuser/.ssh /home/aiuser/.claude /home/aiuser/.local/bin && chmod 750 /workspace && chmod 700 /home/aiuser/.ssh"

  echo "Installing next-task..."
  lxc file push /home/moroine/agent-forge/config/next-task.sh \
    "$setup"/home/aiuser/.local/bin/next-task \
    --uid 1001 --gid 1001 --mode 755

  lxc stop "$setup"
  lxc publish "$setup" --alias agent-base
  lxc delete "$setup"

  echo "Image agent-base published."
}
```

In `templates/CLAUDE.md`, add one line under the `## Environnement` section, after the `**Branche courante**` bullet:

```markdown
- **Réutilisation** : l'opérateur peut réutiliser ce container pour une prochaine tâche via `!next-task <nom>` — n'affecte pas les règles ci-dessus (toujours rester sur `agent/*`, ne jamais changer de branche soi-même)
```

In `scripts/forge`, add the source line:

```bash
source "$FORGE_LIB_DIR/forge-image.sh"
```

Add to `usage()`, after the `list` line:

```
  image build|update                Rebuild the agent-base image (only affects new containers)
```

Add a case branch after `list)`'s closing `;;`:

```bash
  image)
    shift
    cmd_forge_image "$@"
    ;;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bash tests/test-next-task.sh`
Expected: `PASS=5 FAIL=0`.

Run: `bash tests/test-forge-image.sh`
Expected: `PASS=8 FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add config/next-task.sh scripts/lib/forge-image.sh scripts/forge \
  templates/CLAUDE.md tests/test-next-task.sh tests/test-forge-image.sh
git commit -m "$(cat <<'EOF'
feat: add next-task helper and forge image build

next-task is baked into agent-base (not pushed per-container) so
finishing a task and starting the next one in the same container is a
human-invoked `!next-task <name>` instead of recreating the whole
container. forge image build scripts the previously manual README §5
sequence and re-runs safely if a prior build failed partway (cleans up
a leftover agent-base-setup container first).
EOF
)"
```

---

### Task 7: `forge completion bash`

**Files:**
- Create: `scripts/lib/forge-completion.sh`
- Modify: `scripts/forge` (add source line + `completion)` case branch + usage line)
- Test: Create `tests/test-forge-completion.sh`

**Interfaces:**
- Consumes: nothing from earlier tasks (the completion function shells out to `forge list` at *completion time*, not at *definition time* — no direct dependency on other lib functions).
- Produces: none consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Create `tests/test-forge-completion.sh`:

```bash
#!/bin/bash
# Tests structurels de scripts/forge (dispatch "completion") et
# scripts/lib/forge-completion.sh. Lancer : bash tests/test-forge-completion.sh
set -e

FORGE="$(cd "$(dirname "$0")/.." && pwd)/scripts/forge"
LIB="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/forge-completion.sh"
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

echo "bash -n syntax check..."
bash -n "$FORGE"
bash -n "$LIB"

assert_contains "$FORGE" 'source "$FORGE_LIB_DIR/forge-completion.sh"'
assert_contains "$FORGE" 'completion)'
assert_contains "$FORGE" 'cmd_forge_completion_bash'

assert_contains "$LIB" 'complete -F _forge_completions forge'
assert_contains "$LIB" 'forge list'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-forge-completion.sh`
Expected: FAIL at `bash -n "$LIB"` — file doesn't exist yet.

- [ ] **Step 3: Implement**

Create `scripts/lib/forge-completion.sh`:

```bash
# forge completion bash — prints a bash completion function to stdout.
# Usage: eval "$(forge completion bash)"

cmd_forge_completion_bash() {
  cat <<'EOF'
_forge_completions() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "start stop delete list image completion" -- "$cur"))
    return
  fi

  case "$prev" in
    start|stop|delete)
      local repos
      repos=$(forge list 2>/dev/null | tail -n +2 | awk '{print $2}' | grep -v '^-$')
      COMPREPLY=($(compgen -W "$repos" -- "$cur"))
      ;;
    image)
      COMPREPLY=($(compgen -W "build update" -- "$cur"))
      ;;
    completion)
      COMPREPLY=($(compgen -W "bash" -- "$cur"))
      ;;
  esac
}
complete -F _forge_completions forge
EOF
}
```

In `scripts/forge`, add the source line:

```bash
source "$FORGE_LIB_DIR/forge-completion.sh"
```

Add to `usage()`, after the `image` line:

```
  completion bash                   Print a bash completion function (eval it in ~/.bashrc)
```

Add a case branch after `image)`'s closing `;;`:

```bash
  completion)
    shift
    case "${1:-}" in
      bash) cmd_forge_completion_bash ;;
      *) echo "Usage: forge completion bash" >&2; exit 1 ;;
    esac
    ;;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-forge-completion.sh`
Expected: `PASS=5 FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/forge scripts/lib/forge-completion.sh tests/test-forge-completion.sh
git commit -m "feat: add forge completion bash subcommand"
```

---

### Task 8: Full `forge` test pass + `--help` sanity check

**Files:**
- Test: Create `tests/test-forge-dispatcher.sh`

**Interfaces:**
- Consumes: the fully-assembled `scripts/forge` from Tasks 2-7 (all six subcommands wired in).
- Produces: none — this is a cross-cutting regression test, not new subcommand behavior.

- [ ] **Step 1: Write the failing test**

Create `tests/test-forge-dispatcher.sh`:

```bash
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

for lib in forge-common forge-start forge-stop forge-delete forge-list forge-image forge-completion; do
  assert_contains "source \"\$FORGE_LIB_DIR/$lib.sh\""
done

for cmd in 'start)' 'stop)' 'delete)' 'list)' 'image)' 'completion)'; do
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
```

- [ ] **Step 2: Run test to verify it fails**

This should already pass at this point in the plan, since Tasks 2-7 wired everything in incrementally. Run: `bash tests/test-forge-dispatcher.sh`
Expected: `PASS=16 FAIL=0` immediately (no code change needed — this task is a regression-test safety net, not new behavior). If any assertion fails, it means a wiring step from an earlier task was missed; fix `scripts/forge` before proceeding.

- [ ] **Step 3: N/A**

No implementation step — this task only adds the cross-cutting test.

- [ ] **Step 4: Confirm test passes**

Run: `bash tests/test-forge-dispatcher.sh`
Expected: `PASS=16 FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add tests/test-forge-dispatcher.sh
git commit -m "test: add cross-cutting regression test for the forge dispatcher"
```

---

### Task 9: Retire old scripts, rewrite README

**Files:**
- Delete: `scripts/new-agent-container.sh`
- Delete: `scripts/start-agent.sh`
- Delete: `tests/test-new-agent-container.sh`
- Delete: `tests/test-start-agent.sh`
- Modify: `README.md`
- Modify: `tests/test-readme-docs.sh`

**Interfaces:**
- Consumes: the complete `forge` CLI from Tasks 1-8.
- Produces: none — final documentation/cutover task.

- [ ] **Step 1: Write the failing test**

Replace `tests/test-readme-docs.sh` entirely:

```bash
#!/bin/bash
# Vérifie que README.md documente le forge CLI (post-cutover).
# Lancer : bash tests/test-readme-docs.sh
set -e

FILE="$(cd "$(dirname "$0")/.." && pwd)/README.md"
PASS=0
FAIL=0

assert_contains() {
  if grep -qF -- "$1" "$FILE"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu présent): $1"
  fi
}

assert_not_contains() {
  if grep -qF -- "$1" "$FILE"; then
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu absent): $1"
  else
    PASS=$((PASS + 1))
  fi
}

assert_contains 'forge start'
assert_contains 'forge stop'
assert_contains 'forge delete'
assert_contains 'forge list'
assert_contains 'forge image build'
assert_contains 'forge completion bash'
assert_contains 'next-task'
assert_contains 'idmap'
assert_contains 'Claude Code credentials'
assert_contains 'onboarding'
assert_contains 'permission mode'
assert_not_contains 'new-agent-container.sh'
assert_not_contains 'start-agent.sh'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-readme-docs.sh`
Expected: FAIL — `README.md` still describes `new-agent-container.sh`/`start-agent.sh` and has no `forge` mentions. `PASS=4 FAIL=9` (the four pre-existing terms — `idmap`, `Claude Code credentials`, `onboarding`, `permission mode` — still match; the seven `forge`/`next-task` terms don't; the two `assert_not_contains` checks also fail since the old script names are still present).

- [ ] **Step 3: Implement**

Delete the retired scripts and their tests:

```bash
git rm scripts/new-agent-container.sh scripts/start-agent.sh \
  tests/test-new-agent-container.sh tests/test-start-agent.sh
```

In `README.md`, replace the entire "### 5. LXD" code block that builds `agent-base` manually (current lines starting `lxc launch ubuntu:24.04 agent-base-setup` through `lxc delete agent-base-setup`) with:

```markdown
Build the base image:

\`\`\`bash
./scripts/forge image build
\`\`\`

(Aliased as `forge image update` — same command, use whichever name you find
more intuitive for a rebuild.) This scripts the same steps every time:
launches a scratch `agent-base-setup` container, installs Node LTS, `pnpm`,
Claude Code, `gh`, Chrome, and the `next-task` helper, creates `aiuser`, sets
up `/workspace`/`.ssh`/`.claude` ownership, then publishes the `agent-base`
alias and cleans up the scratch container. Only affects containers created
*after* the rebuild — already-running containers keep their existing image
until you delete and `forge start` them again. Safely re-runnable: a leftover
`agent-base-setup` from a previous failed build is deleted first.
```

Replace the "Usage" section's "Create a new agent container" subsection (current lines 218-231) with:

```markdown
### Start a container (creates it on first use)

\`\`\`bash
./scripts/forge start <owner/repo> [task-name]
\`\`\`

Container identity is derived from `owner/repo` — no project name to choose
or remember. If no container exists yet for that repo, `forge start`
provisions one first:
- Creates an LXD container from `agent-base`
- Mounts `/workspace` with correct permissions (no `sudo` required — LXD idmap shifting handles the UID mapping, scoped to that one mount)
- Copies the signing key and configures git (signed commits)
- Reuses your Claude Code credentials from the host (`~/.claude/.credentials.json`), so the container starts already authenticated — no Remote Control pairing needed
- Pre-accepts onboarding and installs the `superpowers` plugin, so the first `claude` launch skips the setup questions
- Prompts for the bot's fine-grained PAT (see setup §6) and authenticates `gh` inside the container — the token is never written to host disk
- Clones `https://github.com/<owner/repo>.git` and creates branch `agent/<task-name>` (`task-name` defaults to `main`, i.e. `agent/main`, if omitted)
- Records `owner/repo` and mode on the container itself (LXD config keys) — there's no separate registry file; `forge list` and future `forge start` calls discover containers this way

Either way (freshly provisioned or already existing), `forge start` then
starts the container if it's stopped and attaches a `claude` session in
`auto` permission mode inside tmux — autonomous by default, but the
auto-mode classifier pauses for confirmation on sensitive actions (credential
handling, irreversible deletion, pushes to protected branches, etc.). A
session URL and QR code are displayed at startup. Running it again on a
repo that already has a container just starts/attaches — no re-provisioning,
no re-pasting the PAT.
```

Replace the "Start a Claude Code session" subsection (now redundant with the above) and the tmux cheatsheet's "Reattach" row: find

```markdown
### Start a Claude Code session

\`\`\`bash
./scripts/start-agent.sh <project-name>
\`\`\`

This starts Claude in `auto` permission mode with Remote Control enabled, named after the project — autonomous by default, but the auto-mode classifier pauses for confirmation on sensitive actions (credential handling, irreversible deletion, pushes to protected branches, etc.). A session URL and QR code are displayed at startup.
```

and delete it entirely (superseded by the "Start a container" subsection above). In the tmux cheatsheet table, replace:

```markdown
| Reattach | `./scripts/start-agent.sh <project-name>` |
| List sessions | `lxc exec agent-<project> -- su - aiuser -c "tmux ls"` |
| Kill session | `lxc exec agent-<project> -- su - aiuser -c "tmux kill-session -t claude"` |
```

with:

```markdown
| Reattach | `./scripts/forge start <owner/repo>` |
| List sessions | `./scripts/forge list` |
| Kill session | `lxc exec agent-<owner>-<repo> -- su - aiuser -c "tmux kill-session -t claude"` |
```

Replace the "Remote access" Requirements line unchanged in substance but referencing `forge start`:

```markdown
**Requirements**: the host must be authenticated with a claude.ai account (`claude auth login`). API key auth does not support Remote Control. New containers reuse this credential automatically at provisioning time (see "Start a container" above); if you re-authenticate on the host afterward, existing containers keep their own copy until recreated.
```

Replace the final "Delete a container" section:

```markdown
### Delete a container

\`\`\`bash
lxc delete agent-<project-name> --force
\`\`\`
```

with:

```markdown
### Stop / list / delete containers

\`\`\`bash
./scripts/forge stop <owner/repo>              # stops the container; workspace/auth/tmux state persists
./scripts/forge list                           # repo, mode, LXD state, and session-alive status for every container
./scripts/forge delete <owner/repo> [--force]  # refuses on dirty/unpushed WIP unless --force
\`\`\`

### Reusing a container for a new task

Once a task is done, committed, and pushed, reuse the same container instead
of recreating it: inside the live session, run `!next-task <short-name>`
(the `!` prefix runs it as a plain shell command, not an agent action). It
refuses if `/workspace` has uncommitted or unpushed changes; otherwise it
fetches `origin`, checks out a fresh `agent/<short-name>` branch from
`origin/main`, and prints the new branch name so you can tell the agent to
start fresh. `next-task` is baked into the `agent-base` image (see `forge
image build` above) — changes to it require an image rebuild plus
recreating affected containers.

### Bash completion

\`\`\`bash
eval "$(./scripts/forge completion bash)"
\`\`\`

Add that line to `~/.bashrc` to get `<owner/repo>` tab-completion on `forge
start`/`stop`/`delete`, sourced dynamically from `forge list`.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-readme-docs.sh`
Expected: `PASS=13 FAIL=0`.

Also re-run the full suite to confirm nothing else regressed:

```bash
for t in tests/test-*.sh; do echo "=== $t ==="; bash "$t"; done
```

Expected: every file ends with `FAIL=0` (or, for `test-pre-bash.sh` / `test-claude-onboarding-state.sh` / `test-claude-container-settings.sh`, whatever their own pre-existing pass count is — unaffected by this plan).

- [ ] **Step 5: Commit**

```bash
git add README.md tests/test-readme-docs.sh scripts/new-agent-container.sh \
  scripts/start-agent.sh tests/test-new-agent-container.sh tests/test-start-agent.sh
git commit -m "$(cat <<'EOF'
docs: rewrite README around the forge CLI, retire old scripts

new-agent-container.sh and start-agent.sh are fully replaced by
forge start/stop/delete/list/image/completion (kept in git history, no
deprecation shim, per repo convention). README now documents container
discovery via owner/repo instead of a free-form project name, the
next-task reuse flow, and bash completion setup.
EOF
)"
```

---

### Task 10: Server verification (manual — run by the maintainer on the LXD host, not by an agent)

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything from Tasks 1-9, deployed on the server (pull the branch into `/home/moroine/agent-forge`), plus an existing `agent-base` image and a host already authenticated with `claude auth login`.

This task cannot run from inside an agent container. It is the spec's verification checklist, to run after the PR from Tasks 1-9 is reviewed and merged:

- [ ] **1. Fresh provisioning:** `forge start <owner>/<scratch-repo>` on a repo with no existing container. Confirm it provisions end to end (same outcome as today's `new-agent-container.sh`) and then starts a session with no onboarding questions.
- [ ] **2. Reuse, no re-prompt:** `forge start <owner>/<scratch-repo>` again (container already exists, possibly stopped). Confirm it starts/attaches without re-provisioning or re-prompting for the PAT.
- [ ] **3. `forge list` accuracy:** confirm it shows the container with correct repo, mode, state, and tmux-alive status.
- [ ] **4. Stop/start round-trip:** `forge stop <owner/repo>`, then `forge list` reflects STOPPED; `forge start <owner/repo>` again brings it back with the same `gh` auth and workspace state intact.
- [ ] **5. `next-task` guard and happy path:** inside a session, confirm a dirty/unpushed tree blocks `!next-task foo`; confirm a clean, pushed tree lets it create `agent/foo` from fresh `origin/main`.
- [ ] **6. `forge delete` guard:** confirm it refuses on a dirty/unpushed tree without `--force`, and succeeds with `--force` or once the tree is clean/pushed.
- [ ] **7. Image rebuild:** `forge image build` produces a new `agent-base` publish and cleans up its scratch container; a subsequent `forge start` on a new repo picks up the new image (spot-check `next-task` is present at `/home/aiuser/.local/bin/next-task`).
- [ ] **8. Bash completion:** `eval "$(forge completion bash)"` in `~/.bashrc`; tab-completing `forge start <TAB>` lists known repos.
- [ ] **9. Collision handling:** attempt `forge start` with a fabricated `owner/repo` that sanitizes to an already-used container name (e.g. two repos differing only in characters that collapse to the same dashes) and confirm it's refused with a clear error rather than silently reusing the wrong container.
- [ ] **10. Existing guardrails unchanged:** confirm `pre-bash.sh`'s branch/push restrictions and `gh` restrictions still fire unchanged (e.g. `git push origin main` → `BLOCKED`) — this plan doesn't touch that file.
- [ ] **11. Cleanup:** `forge delete <owner>/<scratch-repo> --force` and remove `/home/<user>/workspaces/agent-<owner>-<scratch-repo>` once satisfied.
