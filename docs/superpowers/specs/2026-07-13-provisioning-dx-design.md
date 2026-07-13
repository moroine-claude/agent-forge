# Container Provisioning DX — Design

**Date:** 2026-07-13
**Status:** Approved pending user review

## Context

Creating a new agent container today has four rough edges, all surfacing at
or after `new-agent-container.sh` / `start-agent.sh`:

1. The script needs `sudo` to `mkdir`/`chown`/`chmod` the host-side workspace
   directory to the container's mapped UID (`aiuser` = 1001 in-container =
   1001001 on the host).
2. `claude plugin marketplace add` / `claude plugin install
   superpowers@claude-plugins-official`, run during provisioning, silently
   don't take effect — the user has to run `/plugin install
   superpowers@claude-plugins-official` by hand inside the first Claude
   session.
3. The first `claude` launch in a fresh container asks onboarding questions
   (theme, trust-this-folder) that are always answered the same way.
4. Claude itself is never authenticated during provisioning — only `gh` is.
   The user currently has to pair Remote Control (QR/URL flow) on first
   launch to get a working `~/.claude/.credentials.json`.

Inspecting this container's own `~/.claude/` and `~/.claude.json` (an
already-working instance) showed the root cause tying 2–4 together:
`new-agent-container.sh` runs the plugin-install commands **before** any
Claude credential exists in the container, so they run unauthenticated and
silently no-op. Fixing auth-at-provisioning-time is the fix for the plugin
problem too, not a separate one.

A fifth item was added during design: `start-agent.sh` launches Claude with
`--dangerously-skip-permissions` (`bypassPermissions` — no safety net at
all). Claude Code ships a distinct `--permission-mode auto`, which keeps the
same day-to-day autonomy but runs every action through a classifier (1
hard-deny rule on data exfiltration; ~65 soft-deny rules — credential
handling, irreversible deletion, push to default branch, security
weakening, etc. — that pause for confirmation instead of proceeding
silently). This is strictly additional defense-in-depth on top of
`pre-bash.sh`, which only sees the bash surface.

## Decisions

| Decision | Choice |
|---|---|
| Workspace mount ownership | LXD idmap shifting (`shift=true` on the disk device) instead of `sudo chown` to the mapped UID. The directory stays owned by the invoking host user; the container sees it as owned by `aiuser`. Scoped to that one mount — no broader host access is granted. |
| Claude auth | Copy the host's live `~/.claude/.credentials.json` into the container at creation time, same pattern as the SSH signing key: pushed at creation, never stored in `agent-base`. No new exposure vs. today — Remote Control pairing already puts an equivalent credential in the container, just later and manually. |
| Claude identity | Reuse the operator's personal claude.ai account (no scoping is available for OAuth/Remote-Control auth — that requires an API key, which drops Remote Control support). A dedicated "bot" claude.ai account was considered (mirroring the GitHub bot account) but explicitly deferred. |
| Plugin install | Stays a runtime step in `new-agent-container.sh` (not baked into `agent-base`), now run **after** the credential push so it's authenticated and reliable. Declarative backup: `enabledPlugins` is also set directly in the pushed `settings.json`. |
| Onboarding state | New static template `config/claude-onboarding-state.json`, pushed to `~/.claude.json` in the container. One static file is enough because every container clones to the same path (`/workspace`). |
| Permission mode | `start-agent.sh` switches from `--dangerously-skip-permissions` to `--permission-mode auto`. |

## Design

### 1. Workspace mount without `sudo`

Replace:

```bash
sudo mkdir -p "/home/moroine/workspaces/$PROJECT"
sudo chown 1001001:1001001 "/home/moroine/workspaces/$PROJECT"
sudo chmod 750 "/home/moroine/workspaces/$PROJECT"
lxc config device add "$CONTAINER" workspace disk \
  source="/home/moroine/workspaces/$PROJECT" \
  path=/workspace
```

with a plain `mkdir -p` (no `sudo`, owned by the invoking user) and
`shift=true` on the device:

```bash
mkdir -p "/home/moroine/workspaces/$PROJECT"
lxc config device add "$CONTAINER" workspace disk \
  source="/home/moroine/workspaces/$PROJECT" \
  path=/workspace \
  shift=true
```

**Implementation-time risk:** idmap shifting requires kernel/storage-backend
support for idmapped mounts (or LXD's `shiftfs` fallback on older kernels).
This needs to be verified on the actual server — if unsupported, LXD will
error clearly at `lxc config device add` time, and the fallback is the
previous `sudo chown` approach.

### 2. Claude credential reuse

New step in `new-agent-container.sh`, before any plugin-install command
runs:

```bash
if [ ! -f "$HOME/.claude/.credentials.json" ]; then
  echo "Error: $HOME/.claude/.credentials.json not found. Run 'claude auth login' on the host first."
  exit 1
fi
lxc exec "$CONTAINER" -- mkdir -p /home/aiuser/.claude
lxc file push "$HOME/.claude/.credentials.json" \
  "$CONTAINER"/home/aiuser/.claude/.credentials.json \
  --uid 1001 --gid 1001 --mode 600
```

Never written into `agent-base`; pushed fresh per container, same trust
boundary as the GitHub PAT and the SSH signing key.

### 3. Onboarding state pre-seed

New file `config/claude-onboarding-state.json`:

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

Pushed to `/home/aiuser/.claude.json` in the container, right after the
credential push:

```bash
lxc file push config/claude-onboarding-state.json \
  "$CONTAINER"/home/aiuser/.claude.json \
  --uid 1001 --gid 1001 --mode 600
```

### 4. Plugin install, now authenticated

No change to the install commands themselves — only their position in the
script, now after steps 2–3. Additionally, `config/claude-container-settings.json`
gains a declarative `enabledPlugins` entry so the desired state doesn't
depend solely on the CLI command succeeding:

```json
{
  "hooks": { "...": "unchanged" },
  "enabledPlugins": {
    "superpowers@claude-plugins-official": true
  }
}
```

### 5. Permission mode

`start-agent.sh`:

```bash
tmux new-session -A -s claude 'claude --permission-mode auto --remote-control ${PROJECT}'
```

replacing `--dangerously-skip-permissions`.

### Provisioning order (final)

```
1. lxc launch + remove cloud-init ubuntu backdoor
2. mkdir workspace (no sudo) + chmod 750 + shift=true device add
3. push signing key + configure git
4. push .claude/.credentials.json (NEW; existence precondition-checked up front)
5. push .claude.json onboarding state (NEW)
6. npm install -g @anthropic-ai/claude-code@latest
7. claude plugin marketplace add + install (now authenticated)
8. push .claude/hooks/pre-bash.sh + push claude-container-settings.json (extended: enabledPlugins)
9. gh auth (PAT) + clone repo + create branch
```

Note: `claude-container-settings.json` is pushed *after* plugin install, not
before — this is the pre-existing "Installing Claude security hooks" step,
which neither the credential/onboarding work nor the plugin-declaration
work moved. Pushing it last is actually safer: it guarantees the
`pre-bash.sh` hook wiring and `enabledPlugins` are the final authoritative
state even if `claude plugin install` itself rewrote `settings.json`.

## Verification checklist

Run on the server against a scratch project:

1. `new-agent-container.sh` completes with no `sudo` prompt.
2. `/home/moroine/workspaces/<project>` is owned by `moroine` on the host;
   readable/writable without `sudo`.
3. `start-agent.sh` launches `claude` with no onboarding questions (theme,
   trust dialog) and no Remote Control pairing prompt.
4. Superpowers is active immediately (`/plugin` or equivalent shows it
   installed) without running `/plugin install` manually.
5. A credential-exposure action (e.g. attempting to print
   `~/.claude/.credentials.json`) is stopped by the auto-mode classifier,
   confirming `--permission-mode auto` is in effect and not
   `bypassPermissions`.

## Out of scope

- Baking the superpowers plugin into the `agent-base` image (considered,
  explicitly deferred in favor of keeping plugin install as a per-container
  runtime step tied to fresh auth).
- A dedicated "bot" claude.ai account for agent identity (considered,
  deferred — no scoping benefit over the personal account while keeping
  Remote Control, only isolation of blast radius; can be revisited later).
- Token/credential rotation tooling for the copied Claude credential
  (relies on Claude Code's own OAuth refresh behavior, unchanged from
  today).
- The repo-registry / `forge` CLI work tracked separately under the
  autonomous-git-mode design's sub-project 3.
