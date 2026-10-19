# Container Provisioning DX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `new-agent-container.sh` produce a container that's immediately usable — no elevated host privileges needed for the workspace mount, Claude already authenticated and past onboarding, `superpowers` already installed — and switch `start-agent.sh` from an unguarded permission bypass to the classifier-backed `auto` mode.

**Architecture:** `new-agent-container.sh` gains an idmap-shifted workspace mount (drops the manual ownership fix-up), pushes the operator's own Claude Code credential and a static onboarding-acceptance file into the container *before* running the plugin-install commands (today they run unauthenticated and silently no-op), and the plugin's desired state is also declared in the pushed `settings.json`. `start-agent.sh` launches `claude` with `--permission-mode auto` instead of the full bypass flag.

**Tech Stack:** Bash, LXD (`lxc`), `jq`/`python3` (tests only — not part of the scripts themselves).

**Spec:** `docs/superpowers/specs/2026-07-13-provisioning-dx-design.md`

## Global Constraints

- Bash strict mode: `set -e` mandatory in every script.
- Variables always quoted: `"$VAR"`, never `$VAR`.
- Precondition checks at the top of scripts (verify a file/container/image exists before using it).
- Never hardcode credentials, keys, or tokens. The Claude credential is pushed at container-creation time via `lxc file push`, **never written into the `agent-base` image**, never committed to this repo — same rule as the SSH signing key and the GitHub PAT.
- File-path style: this script already hardcodes `/home/<user>/...` paths throughout (workspace dir, signing key, `agent-forge` checkout) rather than `$HOME` — new paths added in this plan follow the same convention for consistency.
- This repo is edited from inside an agent container that has no `lxc` binary and no LXD host to talk to. Nothing involving `lxc` can be executed while implementing this plan. Locally testable: `bash -n` syntax checks, JSON structural checks (`python3 -m json.tool` / reading specific keys), and grep-based structural/ordering assertions on the scripts' *text*. Everything else is verified on the real server (Task 6, manual, not run by the implementing agent).
- **This container's own `pre-bash.sh` hook blocks the standalone word `sudo`** (bounded by whitespace or line start/end) in any command passed to the Bash tool — including inside a `git commit -m` message, which is how the previous session's design-doc commit got blocked. Avoid the bare word `sudo` in any command you actually *run* (commit messages, unquoted greps); it's fine to write the word inside file *content* via Edit/Write (e.g., in README prose), since that never goes through the hook as a command.
- Commit messages: conventional (`feat:`, `fix:`, `chore:`, `docs:`), auto-signed, one commit per task.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/new-agent-container.sh` (modify) | Provisioning: idmap-shifted workspace mount, Claude credential + onboarding-state push (before plugin install), unchanged plugin-install/hook/PAT/clone steps. |
| `scripts/start-agent.sh` (modify) | Launches `claude` in `--permission-mode auto` instead of `--dangerously-skip-permissions`. |
| `config/claude-onboarding-state.json` (create) | Static `~/.claude.json` seed: global onboarding accepted, `/workspace` project trust accepted. Pushed into every new container. |
| `config/claude-container-settings.json` (modify) | Adds `enabledPlugins` so `superpowers` is declared, not just installed by a CLI command. |
| `README.md` (modify) | Documents credential reuse, onboarding/plugin preseed, and the `auto` permission mode. |
| `tests/test-new-agent-container.sh` (create) | Structural/ordering assertions on `scripts/new-agent-container.sh` (grep-based; no `lxc` involved). |
| `tests/test-claude-onboarding-state.sh` (create) | JSON content assertions on `config/claude-onboarding-state.json`. |
| `tests/test-claude-container-settings.sh` (create) | JSON content assertions on `config/claude-container-settings.json`. |
| `tests/test-start-agent.sh` (create) | Structural assertions on `scripts/start-agent.sh`. |
| `tests/test-readme-docs.sh` (create) | Presence assertions on the new README bullets, so Task 5 has a fast automated gate too. |

---

### Task 1: Workspace mount without elevated host privileges (idmap shift)

**Files:**
- Modify: `scripts/new-agent-container.sh:43-51`
- Test: Create `tests/test-new-agent-container.sh`

**Interfaces:**
- Consumes: `$PROJECT`, `$CONTAINER` (already defined at `scripts/new-agent-container.sh:13-15`, unchanged by this task).
- Produces: `tests/test-new-agent-container.sh` runnable as `bash tests/test-new-agent-container.sh`, exposing `assert_contains "<pattern>"`, `assert_not_contains "<pattern>"`, and `assert_line_before "<earlier-pattern>" "<later-pattern>"` helpers (grep -F based, fixed-string, no regex surprises) that Task 2 extends with more assertions in the same file.

- [ ] **Step 1: Write the failing test**

Create `tests/test-new-agent-container.sh`:

```bash
#!/bin/bash
# Tests structurels de new-agent-container.sh.
# Pas de lxc disponible ici : on vérifie le contenu et l'ordre des étapes
# du script par grep, pas son exécution réelle (voir Task 6 pour ça).
# Lancer : bash tests/test-new-agent-container.sh
set -e

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/new-agent-container.sh"
PASS=0
FAIL=0

assert_contains() {
  if grep -qF -- "$1" "$SCRIPT"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu présent): $1"
  fi
}

assert_not_contains() {
  if grep -qF -- "$1" "$SCRIPT"; then
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu absent): $1"
  else
    PASS=$((PASS + 1))
  fi
}

assert_line_before() {
  local l1 l2
  l1=$(grep -nF -- "$1" "$SCRIPT" | head -1 | cut -d: -f1)
  l2=$(grep -nF -- "$2" "$SCRIPT" | head -1 | cut -d: -f1)
  if [ -n "$l1" ] && [ -n "$l2" ] && [ "$l1" -lt "$l2" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu '$1' avant '$2'): l1=${l1:-?} l2=${l2:-?}"
  fi
}

echo "bash -n syntax check..."
bash -n "$SCRIPT"

# --- Task 1: workspace mount without elevated host privileges ---
assert_contains 'shift=true'
assert_not_contains '1001001'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-new-agent-container.sh`
Expected: FAIL — `1001001` is still present (line 46 of the current script) and `shift=true` is absent. `bash -n` itself passes (it's a plain command, not counted in PASS/FAIL) but both assertions fail. Output ends with `PASS=0 FAIL=2` and a non-zero exit.

- [ ] **Step 3: Implement**

In `scripts/new-agent-container.sh`, replace lines 43-51:

```bash
echo "Mounting workspace..."
if [ ! -d "/home/<user>/workspaces/$PROJECT" ]; then
  sudo mkdir -p "/home/<user>/workspaces/$PROJECT"
  sudo chown 1001001:1001001 "/home/<user>/workspaces/$PROJECT"
  sudo chmod 750 "/home/<user>/workspaces/$PROJECT"
fi
lxc config device add "$CONTAINER" workspace disk \
  source="/home/<user>/workspaces/$PROJECT" \
  path=/workspace
```

with:

```bash
echo "Mounting workspace..."
mkdir -p "/home/<user>/workspaces/$PROJECT"
# shift=true : idmap shifting LXD — le dossier reste possédé par l'utilisateur
# hôte courant, pas besoin de chown vers l'UID mappé du container (1001001).
# Scopé à ce seul point de montage, n'ouvre aucun accès host plus large.
lxc config device add "$CONTAINER" workspace disk \
  source="/home/<user>/workspaces/$PROJECT" \
  path=/workspace \
  shift=true
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-new-agent-container.sh`
Expected: `PASS=2 FAIL=0`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/new-agent-container.sh tests/test-new-agent-container.sh
git commit -m "$(cat <<'EOF'
fix: mount agent workspace via LXD idmap shifting

Drops the manual chown to the mapped container UID (which required
elevated host privileges) in favor of shift=true on the disk device.
The directory now stays owned by the invoking host user; LXD handles
the UID mapping for the container's view of that one mount only.
EOF
)"
```

---

### Task 2: Reuse host Claude Code credentials + pre-accept onboarding

**Files:**
- Modify: `scripts/new-agent-container.sh:56-66` (insert new steps between the git-config heredoc and the "Updating Claude Code to latest..." line; also moves the plugin-install step later only in the sense that it now runs after these new steps, no line changes needed there)
- Modify: `tests/test-new-agent-container.sh` (append assertions)
- Create: `config/claude-onboarding-state.json`
- Test: Create `tests/test-claude-onboarding-state.sh`

**Interfaces:**
- Consumes: `$CONTAINER` (from Task 1's untouched context); `tests/test-new-agent-container.sh` helpers from Task 1 (`assert_contains`, `assert_line_before`).
- Produces: two new provisioning steps in `scripts/new-agent-container.sh` that push `/home/aiuser/.claude/.credentials.json` and `/home/aiuser/.claude.json` into the container before the existing "Installing Claude plugins..." step (`scripts/new-agent-container.sh:68-69`, unmodified by this task — it now simply runs later in file order because the new steps are inserted above it).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test-new-agent-container.sh`, replacing the epilogue block:

```bash
echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

with:

```bash
# --- Task 2: Claude credential + onboarding reuse, before plugin install ---
assert_contains '.credentials.json'
assert_contains 'claude-onboarding-state.json'
assert_line_before '.credentials.json' 'Installing Claude plugins'
assert_line_before 'claude-onboarding-state.json' 'Installing Claude plugins'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

Create `tests/test-claude-onboarding-state.sh`:

```bash
#!/bin/bash
# Vérifie le contenu de config/claude-onboarding-state.json.
# Lancer : bash tests/test-claude-onboarding-state.sh
set -e

FILE="$(cd "$(dirname "$0")/.." && pwd)/config/claude-onboarding-state.json"
PASS=0
FAIL=0

check() {
  local desc="$1" expr="$2" expected="$3"
  local actual
  # Exceptions (e.g. a missing key) are caught and reported as a normal FAIL
  # instead of a bare traceback killing the script under set -e.
  actual=$(python3 -c "
import json
try:
    d = json.load(open('$FILE'))
    print($expr)
except Exception as e:
    print('ERROR:' + type(e).__name__)
")
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL ($desc): got '$actual', expected '$expected'"
  fi
}

echo "JSON validity..."
python3 -m json.tool "$FILE" > /dev/null

check "global onboarding accepted" "d['hasCompletedOnboarding']" "True"
check "workspace trust accepted" "d['projects']['/workspace']['hasTrustDialogAccepted']" "True"
check "workspace project onboarding accepted" "d['projects']['/workspace']['hasCompletedProjectOnboarding']" "True"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bash tests/test-new-agent-container.sh`
Expected: FAIL — `.credentials.json` and `claude-onboarding-state.json` are absent from the script, so neither the `assert_contains` nor the `assert_line_before` checks for them can pass. Task 1's two assertions still pass. Output ends `PASS=2 FAIL=4`.

Run: `bash tests/test-claude-onboarding-state.sh`
Expected: FAIL at the `python3 -m json.tool` step — `config/claude-onboarding-state.json` does not exist yet.

- [ ] **Step 3: Implement**

Create `config/claude-onboarding-state.json`:

```json
{
  "hasCompletedOnboarding": true,
  "projects": {
    "/workspace": {
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true
    }
  }
}
```

In `scripts/new-agent-container.sh`, insert this block right after the git-config heredoc closes (after line 63, `"`) and before `echo "Updating Claude Code to latest..."` (line 65):

```bash
echo "Reusing Claude Code credentials from host..."
if [ ! -f "/home/<user>/.claude/.credentials.json" ]; then
  echo "Error: /home/<user>/.claude/.credentials.json not found. Run 'claude auth login' on the host first."
  exit 1
fi
lxc exec "$CONTAINER" -- mkdir -p /home/aiuser/.claude
lxc file push /home/<user>/.claude/.credentials.json "$CONTAINER"/home/aiuser/.claude/.credentials.json --uid 1001 --gid 1001 --mode 600

echo "Pre-accepting Claude Code onboarding..."
lxc file push /home/moroine/agent-forge/config/claude-onboarding-state.json "$CONTAINER"/home/aiuser/.claude.json --uid 1001 --gid 1001 --mode 600
```

This must land *before* the existing "Installing Claude plugins..." step (`scripts/new-agent-container.sh:68-69` today) so that step runs authenticated.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bash tests/test-new-agent-container.sh`
Expected: `PASS=6 FAIL=0`.

Run: `bash tests/test-claude-onboarding-state.sh`
Expected: `PASS=3 FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/new-agent-container.sh tests/test-new-agent-container.sh \
  config/claude-onboarding-state.json tests/test-claude-onboarding-state.sh
git commit -m "$(cat <<'EOF'
feat: reuse host Claude credentials and pre-accept onboarding

Pushes the operator's ~/.claude/.credentials.json and a static
onboarding-acceptance file into every new container, before the
plugin-install step. Plugin marketplace/install commands run
unauthenticated today and silently no-op; this fixes that at the
root instead of requiring a manual /plugin install afterward.
EOF
)"
```

---

### Task 3: Declare `superpowers` in `settings.json`

**Files:**
- Modify: `config/claude-container-settings.json`
- Test: Create `tests/test-claude-container-settings.sh`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent file).
- Produces: `enabledPlugins` key in the settings pushed to every container at `scripts/new-agent-container.sh:77-79` (unmodified — same push, richer content).

- [ ] **Step 1: Write the failing test**

Create `tests/test-claude-container-settings.sh`:

```bash
#!/bin/bash
# Vérifie le contenu de config/claude-container-settings.json.
# Lancer : bash tests/test-claude-container-settings.sh
set -e

FILE="$(cd "$(dirname "$0")/.." && pwd)/config/claude-container-settings.json"
PASS=0
FAIL=0

check() {
  local desc="$1" expr="$2" expected="$3"
  local actual
  # Exceptions (e.g. a missing key) are caught and reported as a normal FAIL
  # instead of a bare traceback killing the script under set -e.
  actual=$(python3 -c "
import json
try:
    d = json.load(open('$FILE'))
    print($expr)
except Exception as e:
    print('ERROR:' + type(e).__name__)
")
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL ($desc): got '$actual', expected '$expected'"
  fi
}

echo "JSON validity..."
python3 -m json.tool "$FILE" > /dev/null

check "superpowers enabled" "d['enabledPlugins']['superpowers@claude-plugins-official']" "True"
check "pre-bash hook still wired" "d['hooks']['PreToolUse'][0]['hooks'][0]['command']" "bash /home/aiuser/.claude/hooks/pre-bash.sh"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-claude-container-settings.sh`
Expected: FAIL on the `enabledPlugins` check (key absent) — `PASS=1 FAIL=1`.

- [ ] **Step 3: Implement**

Replace `config/claude-container-settings.json` entirely with:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash /home/aiuser/.claude/hooks/pre-bash.sh"
          }
        ]
      }
    ]
  },
  "enabledPlugins": {
    "superpowers@claude-plugins-official": true
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-claude-container-settings.sh`
Expected: `PASS=2 FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add config/claude-container-settings.json tests/test-claude-container-settings.sh
git commit -m "$(cat <<'EOF'
feat: declare superpowers as an enabled plugin in settings.json

Makes the desired plugin state explicit in the pushed config, not
solely dependent on the claude plugin install CLI command succeeding.
EOF
)"
```

---

### Task 4: Switch `start-agent.sh` to `--permission-mode auto`

**Files:**
- Modify: `scripts/start-agent.sh:21`
- Test: Create `tests/test-start-agent.sh`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent file).
- Produces: none consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Create `tests/test-start-agent.sh`:

```bash
#!/bin/bash
# Tests structurels de start-agent.sh.
# Lancer : bash tests/test-start-agent.sh
set -e

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/start-agent.sh"
PASS=0
FAIL=0

assert_contains() {
  if grep -qF -- "$1" "$SCRIPT"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu présent): $1"
  fi
}

assert_not_contains() {
  if grep -qF -- "$1" "$SCRIPT"; then
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu absent): $1"
  else
    PASS=$((PASS + 1))
  fi
}

echo "bash -n syntax check..."
bash -n "$SCRIPT"

assert_contains '--permission-mode auto'
assert_not_contains '--dangerously-skip-permissions'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-start-agent.sh`
Expected: FAIL — the script still has `--dangerously-skip-permissions` and not `--permission-mode auto`, so both assertions fail (`bash -n` passes but isn't counted in PASS/FAIL). Output ends `PASS=0 FAIL=2`.

- [ ] **Step 3: Implement**

In `scripts/start-agent.sh`, replace line 21:

```bash
  tmux new-session -A -s claude 'claude --dangerously-skip-permissions --remote-control ${PROJECT}'
```

with:

```bash
  tmux new-session -A -s claude 'claude --permission-mode auto --remote-control ${PROJECT}'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-start-agent.sh`
Expected: `PASS=2 FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/start-agent.sh tests/test-start-agent.sh
git commit -m "$(cat <<'EOF'
fix: run agent sessions in auto permission mode, not full bypass

--dangerously-skip-permissions had no safety net at all. --permission-mode
auto keeps the same day-to-day autonomy but routes every action through
Claude Code's classifier (credential handling, irreversible deletion,
pushes to protected branches, etc. pause for confirmation instead of
proceeding silently) — defense-in-depth alongside pre-bash.sh, which only
sees the bash surface.
EOF
)"
```

---

### Task 5: Document the new provisioning behavior in README

**Files:**
- Modify: `README.md`
- Test: Create `tests/test-readme-docs.sh`

**Interfaces:**
- Consumes: nothing (documents the outcome of Tasks 1-4).
- Produces: none.

- [ ] **Step 1: Write the failing test**

Create `tests/test-readme-docs.sh`:

```bash
#!/bin/bash
# Vérifie que README.md documente le nouveau comportement de provisioning.
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

assert_contains 'idmap'
assert_contains 'Claude Code credentials'
assert_contains 'onboarding'
assert_contains 'permission mode'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test-readme-docs.sh`
Expected: FAIL — none of these terms are in the current README in this context. `PASS=0 FAIL=4`.

- [ ] **Step 3: Implement**

In `README.md`, replace the "This will:" bullet list (current lines 224-229):

```markdown
This will:
- Create an LXD container from `agent-base`
- Mount `/workspace` with correct permissions
- Copy the signing key and configure git (signed commits)
- Prompt for the bot's fine-grained PAT (see setup §6) and authenticate `gh` inside the container — the token is never written to host disk
- Clone `https://github.com/<owner/repo>.git` and create branch `agent/<project-name>`
```

with:

```markdown
This will:
- Create an LXD container from `agent-base`
- Mount `/workspace` with correct permissions (no `sudo` required — LXD idmap shifting handles the UID mapping, scoped to that one mount)
- Copy the signing key and configure git (signed commits)
- Reuse your Claude Code credentials from the host (`~/.claude/.credentials.json`), so the container starts already authenticated — no Remote Control pairing needed
- Pre-accept onboarding and install the `superpowers` plugin, so the first `claude` launch skips the setup questions
- Prompt for the bot's fine-grained PAT (see setup §6) and authenticate `gh` inside the container — the token is never written to host disk
- Clone `https://github.com/<owner/repo>.git` and create branch `agent/<project-name>`
```

Replace the "Start a Claude Code session" paragraph (current line 258):

```markdown
This starts Claude with Remote Control enabled, named after the project. A session URL and QR code are displayed at startup.
```

with:

```markdown
This starts Claude in `auto` permission mode with Remote Control enabled, named after the project — autonomous by default, but the auto-mode classifier pauses for confirmation on sensitive actions (credential handling, irreversible deletion, pushes to protected branches, etc.). A session URL and QR code are displayed at startup.
```

Replace the Requirements line in "Remote access" (current line 269):

```markdown
**Requirements**: the host must be authenticated with a claude.ai account (`claude auth login`). API key auth does not support Remote Control.
```

with:

```markdown
**Requirements**: the host must be authenticated with a claude.ai account (`claude auth login`). API key auth does not support Remote Control. New containers reuse this credential automatically at creation time (see Usage above); if you re-authenticate on the host afterward, existing containers keep their own copy until recreated.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test-readme-docs.sh`
Expected: `PASS=4 FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add README.md tests/test-readme-docs.sh
git commit -m "$(cat <<'EOF'
docs: document credential reuse, onboarding preseed, and auto mode

EOF
)"
```

---

### Task 6: Server verification (manual — run by the maintainer on the LXD host, not by an agent)

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything from Tasks 1-5, deployed on the server (pull the branch into `/home/moroine/agent-forge`), plus an existing `agent-base` image and a host already authenticated with `claude auth login`.

This task cannot run from inside an agent container. It is the spec's verification checklist, to run after the PR from Tasks 1-5 is reviewed and merged:

- [ ] **1. No elevated privileges needed:** run `./scripts/new-agent-container.sh test-project <owner>/<scratch-repo>` end to end. Confirm no privilege-escalation prompt appears during the workspace-mount step, and that `/home/<user>/workspaces/test-project` is owned by `<user>` on the host (readable/editable directly, no privilege escalation needed).
- [ ] **2. No onboarding questions:** run `./scripts/start-agent.sh test-project`. Confirm `claude` launches straight into a session — no theme selection, no "trust this folder" prompt, no Remote Control pairing QR/URL.
- [ ] **3. Plugin already active:** inside that session, confirm `superpowers` is available (e.g. a `superpowers:*` skill can be invoked) without running `/plugin install` manually.
- [ ] **4. Auto mode is in effect:** inside that session, ask Claude to print the contents of `~/.claude/.credentials.json`. Confirm the auto-mode classifier stops the action (a block message referencing credential exposure), proving `--permission-mode auto` is active and not `--dangerously-skip-permissions`.
- [ ] **5. Existing behavior unchanged:** confirm the rest of the provisioning flow still works — signing key present, git configured, `gh` PAT prompt appears, repo clones, branch `agent/test-project` is created, and `pre-bash.sh`'s existing git-push/`gh` blocks still fire (spot-check one, e.g. `git push origin main` → `BLOCKED`).
- [ ] **6. Cleanup:** `lxc delete agent-test-project --force` and remove `/home/<user>/workspaces/test-project` once satisfied.
