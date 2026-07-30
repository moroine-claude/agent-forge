# Chrome DevTools MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `chrome-devtools-mcp` MCP server into `agent-base` so every new agent container can drive its already-installed headless Chrome — navigate, screenshot, read console/network logs — without any per-repo `.mcp.json`.

**Architecture:** `chrome-devtools-mcp@latest` is installed globally via npm at image-build time (`scripts/lib/forge-image.sh`), and declared as a global MCP server in `config/claude-onboarding-state.json`, which gets pushed to `~/.claude.json` once, at initial container provisioning. `README.md` and `templates/CLAUDE.md` document the new capability. Each change is covered by extending the existing structural test in `tests/`.

**Tech Stack:** Bash (LXD provisioning scripts), JSON config, npm package `chrome-devtools-mcp`.

## Global Constraints

- Install `chrome-devtools-mcp@latest` — not pinned. This is the only package in the entire image that was briefly pinned to an exact version (`1.6.0`); every other package (`pnpm`, `@anthropic-ai/claude-code`, `gh`, Chrome, Docker/Compose) floats to whatever's current at build time, and `claude-code` is even force-updated to `@latest` again on every `forge start` (`forge-start.sh:99`). Pinning blocked automatic security updates on rebuild, which outweighs the reproducibility benefit for this tool. (Reversed via PR #10 review feedback after the initial pinned version shipped.)
- Chrome binary path is `/usr/bin/google-chrome-stable` (installed by the existing `.deb` step in `forge-image.sh`) — the MCP server must point at this exact path via `--executablePath`, not launch its own bundled browser.
- This feature reaches only *new* containers. Neither half (the npm binary baked into the image, nor the `mcpServers` key pushed to `~/.claude.json`) is ever refreshed on an already-provisioned container. `forge image build` must run before any container that references `chrome-devtools` in its `mcpServers` is provisioned, or the MCP server points at a missing binary.
- Every file this plan touches already has a structural test in `tests/` (`grep`/JSON assertions, no live LXD container) — extend those files via TDD; do not skip them.
- This agent session has no LXD/host access (confirmed: `lxc` is a non-functional stub here, per `agent-forge`'s own security model — agents never touch the host). Tasks 1–4 are plain file edits + `bash tests/test-*.sh` runs, fully executable in this environment. The final manual verification (image build, container provisioning, smoke test) requires the human operator on the real host and is called out separately, not as a subagent-dispatchable task.

---

### Task 1: Install `chrome-devtools-mcp` in the agent-base image

**Files:**
- Modify: `tests/test-forge-image.sh`
- Modify: `scripts/lib/forge-image.sh:43-44`

**Interfaces:**
- Produces: a `chrome-devtools-mcp` executable on `PATH` inside every new container, installed as root (same convention as `@anthropic-ai/claude-code` at `forge-image.sh:39`) — consumed by Task 2's `mcpServers.chrome-devtools.command`.

- [ ] **Step 1: Add failing assertions to `tests/test-forge-image.sh`**

Add these three lines after the existing `assert_line_before "$LIB" 'apt install -y docker-ce docker-ce-cli' 'systemctl disable --now docker.service docker.socket containerd.service'` line (around line 60), before the `chown -R aiuser:aiuser` assertion:

```bash
assert_contains "$LIB" 'npm install -g chrome-devtools-mcp@latest'
assert_line_before "$LIB" 'google-chrome-stable_current_amd64.deb' 'npm install -g chrome-devtools-mcp@latest'
assert_line_before "$LIB" 'npm install -g chrome-devtools-mcp@latest' 'Installing Docker (rootless)'
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bash tests/test-forge-image.sh`

Expected: three new FAIL lines, e.g.
```
FAIL (attendu présent dans /workspace/scripts/lib/forge-image.sh): npm install -g chrome-devtools-mcp@latest
FAIL (attendu 'google-chrome-stable_current_amd64.deb' avant 'npm install -g chrome-devtools-mcp@latest' dans /workspace/scripts/lib/forge-image.sh): l1=43 l2=?
FAIL (attendu 'npm install -g chrome-devtools-mcp@latest' avant 'Installing Docker (rootless)' dans /workspace/scripts/lib/forge-image.sh): l1=? l2=44
```
All previously-existing assertions still PASS.

- [ ] **Step 3: Implement — install the package in `forge-image.sh`**

In `scripts/lib/forge-image.sh`, insert immediately after the existing Chrome-install line (currently line 43: `lxc exec "$setup" -- bash -c "wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb && apt install -y --fix-missing /tmp/chrome.deb"`) and before `echo "Installing Docker (rootless)..."`:

```bash
  echo "Installing chrome-devtools-mcp..."
  lxc exec "$setup" -- npm install -g chrome-devtools-mcp@latest
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bash tests/test-forge-image.sh`

Expected: `PASS=<N> FAIL=0` (all assertions, old and new, pass).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/forge-image.sh tests/test-forge-image.sh
git commit -m "feat: install chrome-devtools-mcp in the agent-base image"
```

---

### Task 2: Declare the `chrome-devtools` MCP server globally

**Files:**
- Modify: `tests/test-claude-onboarding-state.sh`
- Modify: `config/claude-onboarding-state.json`

**Interfaces:**
- Consumes: the `chrome-devtools-mcp` executable from Task 1 (as `command`).
- Produces: an `mcpServers.chrome-devtools` entry in `~/.claude.json` for every newly-provisioned container (pushed once, at `_forge_provision_container` — `forge-start.sh:96`).

- [ ] **Step 1: Add failing checks to `tests/test-claude-onboarding-state.sh`**

Add these lines after the existing three `check` calls (before the final blank `echo ""`):

```bash
check "chrome-devtools MCP command" "d['mcpServers']['chrome-devtools']['command']" "chrome-devtools-mcp"
check "chrome-devtools MCP headless flag" "'--headless' in d['mcpServers']['chrome-devtools']['args']" "True"
check "chrome-devtools MCP executablePath flag" "'--executablePath=/usr/bin/google-chrome-stable' in d['mcpServers']['chrome-devtools']['args']" "True"
check "chrome-devtools MCP isolated flag" "'--isolated' in d['mcpServers']['chrome-devtools']['args']" "True"
check "chrome-devtools MCP no-usage-statistics flag" "'--no-usage-statistics' in d['mcpServers']['chrome-devtools']['args']" "True"
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bash tests/test-claude-onboarding-state.sh`

Expected: five new FAIL lines, e.g.
```
FAIL (chrome-devtools MCP command): got 'ERROR:KeyError', expected 'chrome-devtools-mcp'
FAIL (chrome-devtools MCP headless flag): got 'ERROR:KeyError', expected 'True'
FAIL (chrome-devtools MCP executablePath flag): got 'ERROR:KeyError', expected 'True'
FAIL (chrome-devtools MCP isolated flag): got 'ERROR:KeyError', expected 'True'
FAIL (chrome-devtools MCP no-usage-statistics flag): got 'ERROR:KeyError', expected 'True'
```
The three pre-existing checks still PASS.

- [ ] **Step 3: Implement — add `mcpServers` to `config/claude-onboarding-state.json`**

Replace the full file content with:

```json
{
  "hasCompletedOnboarding": true,
  "projects": {
    "/workspace": {
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true
    }
  },
  "mcpServers": {
    "chrome-devtools": {
      "command": "chrome-devtools-mcp",
      "args": [
        "--headless",
        "--executablePath=/usr/bin/google-chrome-stable",
        "--isolated",
        "--no-usage-statistics"
      ]
    }
  }
}
```

`--isolated` gives each launch a temporary, auto-cleaned Chrome profile (avoids
profile-lock conflicts). `--no-usage-statistics` opts the server out of
sending usage data to Google — this MCP server defaults that collection to
**on** (confirmed via `npx chrome-devtools-mcp@latest --help`), which doesn't
fit a project that otherwise scopes every credential and network path tightly.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bash tests/test-claude-onboarding-state.sh`

Expected: `PASS=<N> FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add config/claude-onboarding-state.json tests/test-claude-onboarding-state.sh
git commit -m "feat: declare chrome-devtools MCP server globally"
```

---

### Task 3: Document the capability in `README.md`

**Files:**
- Modify: `tests/test-readme-docs.sh`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing consumed by later tasks — purely descriptive.

- [ ] **Step 1: Add a failing assertion to `tests/test-readme-docs.sh`**

Add after the existing `assert_contains '--privileged'` line:

```bash
assert_contains 'chrome-devtools-mcp'
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bash tests/test-readme-docs.sh`

Expected: one new FAIL line:
```
FAIL (attendu présent): chrome-devtools-mcp
```

- [ ] **Step 3: Implement — update `README.md`**

In the paragraph describing what `forge image build` installs (currently:
`installs Node LTS, `pnpm`, Claude Code, `gh`, Chrome, Docker (rootless) and
Compose, and the `next-task` helper`), insert `chrome-devtools-mcp` right
after `Chrome`:

```
installs Node LTS, `pnpm`, Claude Code, `gh`, Chrome, `chrome-devtools-mcp`,
Docker (rootless) and Compose, and the `next-task` helper
```

Then add a new subsection right after the existing "### Docker/Compose
access" section (before "### Token renewal"):

```markdown
### Browser automation (Chrome DevTools MCP)

Every agent container gets `chrome-devtools-mcp` wired up globally as an MCP
server — no `.mcp.json` needed per repo. It drives the headless
`google-chrome-stable` already installed in the image, letting the agent
navigate to a locally running dev server, take screenshots, and read
console/network output — the tool needed to follow the "verify UI changes in
a browser before reporting done" guidance in a container with no display and
no `claude-in-chrome` extension pairing.

Only reaches *new* containers: the binary is baked into the image at `forge
image build` time, and the MCP server declaration is pushed to
`~/.claude.json` once, at initial provisioning — neither refreshes on an
already-existing container. Rebuild the image and recreate (`forge delete`
+ `forge start`) to pick it up on a container that predates this change.
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bash tests/test-readme-docs.sh`

Expected: `PASS=<N> FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add README.md tests/test-readme-docs.sh
git commit -m "docs: document Chrome DevTools MCP browser automation"
```

---

### Task 4: Tell agents about the tool in `templates/CLAUDE.md`

**Files:**
- Modify: `tests/test-claude-template.sh`
- Modify: `templates/CLAUDE.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks — purely instructional text read by the agent inside each container.

- [ ] **Step 1: Add failing assertions to `tests/test-claude-template.sh`**

Add after the existing `assert_line_before '## Docker' '## Périmètre'` line:

```bash
assert_contains '## Navigateur'
assert_contains 'chrome-devtools-mcp'
assert_line_before '## Docker' '## Navigateur'
assert_line_before '## Navigateur' '## Périmètre'
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bash tests/test-claude-template.sh`

Expected: four new FAIL lines (the two `assert_contains`, plus both new
`assert_line_before` reporting `l1=?` since neither pattern exists yet).

- [ ] **Step 3: Implement — add a Navigateur section to `templates/CLAUDE.md`**

Insert a new `## Navigateur` section right after the existing `## Docker`
section (after its last line, `- \`docker run --privileged\`, ...`) and
before `## Périmètre`:

```markdown

## Navigateur
- Un serveur MCP Chrome DevTools (`chrome-devtools-mcp`) est disponible pour piloter Chrome en headless — navigue vers ton dev server local, prends des captures d'écran, lis les logs console/réseau pour vérifier tes changements UI avant de dire que c'est fini
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bash tests/test-claude-template.sh`

Expected: `PASS=<N> FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add templates/CLAUDE.md tests/test-claude-template.sh
git commit -m "docs: tell agents about the Chrome DevTools MCP tool"
```

---

## Manual Verification (operator, on the host — not subagent-dispatchable)

This agent session has no LXD access, so the following cannot run inside a
sandboxed agent container — the human operator runs these on the real host
after Tasks 1–4 are merged:

- [ ] Run `./scripts/forge image build` (or `forge image update`) and confirm
      it completes without error, in particular the new
      `npm install -g chrome-devtools-mcp@latest` step.
- [ ] Provision a throwaway container: `./scripts/forge start <owner/repo> mcp-smoke-test`.
- [ ] Inside the session, run `claude mcp list` (or equivalent) and confirm
      `chrome-devtools` shows as connected, not erroring on startup.
- [ ] Functional check: start a trivial local HTTP server in the container
      (e.g. `python3 -m http.server 8000`), then ask the agent to navigate to
      `http://localhost:8000` via the MCP tool, take a screenshot, and read
      the console log — confirm the round trip works.
- [ ] **If Chrome fails to launch with a sandbox-related error** (e.g.
      `Failed to move to new namespace` or `No usable sandbox`): add
      `"--chromeArg=--no-sandbox"` to the `args` array in
      `config/claude-onboarding-state.json` (Task 2's file), re-run
      `tests/test-claude-onboarding-state.sh` with an added check for this
      flag, commit, and re-provision the smoke-test container to confirm the
      fix. Acceptable here because Chrome only ever loads the agent's own
      local dev server, never untrusted third-party content.
- [ ] Delete the throwaway container: `./scripts/forge delete <owner/repo> --force`.
