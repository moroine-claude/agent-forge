# Supervised Git Mode — Design

**Date:** 2026-07-15
**Status:** Approved pending user review
**Sub-project:** 2 of 3 in the original agent-forge DX overhaul (see
`docs/superpowers/specs/2026-07-11-autonomous-git-mode-design.md`), picked up
now that sub-project 3 (the `forge` CLI) is built and already reserves a
`mode` slot per container for this.

## Context

Autonomous mode (sub-project 1) lets an agent push its own branch and open a
PR, authenticated as a GitHub bot via a fine-grained PAT pasted into the
container. That's the right trade-off for most repos, but wrong for
sensitive ones: it means a write-scoped credential exists inside the
container for the container's lifetime.

Supervised mode is the alternative for those repos: **the container never
holds any GitHub credential, read or write.** The agent commits locally
(signed as the bot, for provenance during the session), but has no way to
push or open a PR — there is nothing to authenticate with. Getting that work
published is entirely a human-run flow, outside the container, ending with
the user's own identity and YubiKey signature in the repo's history — the
bot never appears in these repos' commit log.

The `forge` CLI (sub-project 3) already stores `user.forge.mode` per
container and only ever sets it to `"autonomous"` today; this design is what
fills in `"supervised"` as a real second value.

## Decisions

| Decision | Choice |
|---|---|
| Invocation | `forge start <owner/repo> [task-name]` — unchanged surface. On first provisioning only (no container exists yet for the repo), it interactively prompts for mode: `[a]utonomous` (default) / `[s]upervised`. No CLI flag. Subsequent `forge start` calls on an existing container never prompt — mode is already fixed via `user.forge.mode`. |
| Container credential | None, ever. No PAT prompt, no `gh auth login`, no `gh auth setup-git`. `gh` stays installed (same `agent-base` image) but is never authenticated in supervised containers. |
| Repo seeding | Within the same `_forge_provision_container` step that autonomous mode uses for its container-side `gh`-authenticated clone, supervised mode instead clones **on the host**, as `moroine`, over SSH (`git@github.com:<owner/repo>.git`) into the workspace directory, then creates `agent/<task-name>` — before the directory is (or, timing aside, regardless of whether it's already) mounted into the container. This is a human-run script, not an agent tool call, so relying on the operator's forwarded SSH agent (YubiKey touch) for this is consistent with the existing commit-signing setup (README §7) — no standing credential is written anywhere on host or container disk. |
| Guardrails | New marker file `/home/aiuser/.claude/forge-mode` (plain text `autonomous` or `supervised`), pushed at provisioning time next to the other per-container config. `pre-bash.sh` reads it: supervised mode blocks **every** `git push` (no allowed-target carve-out — there is no legitimate target) and **every** `gh` subcommand (no auth exists, so no subcommand has a legitimate use, not just the merge/api/repo/alias/extension/token subset autonomous blocks). A missing marker file (pre-existing containers from before this change) defaults to autonomous behavior — no breakage. |
| `templates/CLAUDE.md` | Single file, unchanged mechanism (still one static template pushed at provisioning). Its Git section now branches on the same `forge-mode` marker: if `autonomous`, push and open a PR as today; if `supervised`, commit locally only (signed), never attempt to push or open a PR, and when the task is done say so clearly and stop — a human retrieves the branch from outside the container. Rejected alternative: two separate template files — duplicates the Contexte/Environnement/Périmètre sections and risks drift; reusing the marker file that already has to exist for the hook is free. |
| `next-task` (`config/next-task.sh`) | Also reads `/home/aiuser/.claude/forge-mode`. Autonomous: unchanged (dirty-tree check, unpushed-vs-`origin/<branch>` gate, `git fetch origin`, `checkout -b agent/<short-name> origin/main`). Supervised: dirty-tree check only (the unpushed gate assumes a credential that doesn't exist and would permanently block reuse); **skips** `git fetch origin` entirely (would fail with no credential); checks out the new branch from whatever `origin/main` is already cached locally, and prints a note telling the operator to `git fetch origin` from a **host** shell in the workspace directory first if they want an up-to-date `main` (the workspace dir is the same files the container sees, so that fetch is immediately visible). |
| `forge_check_wip` (`forge stop`/`forge delete`) | Becomes mode-aware the same way: supervised containers only fail the dirty-tree check. "Ahead of main with no `origin/<branch>`" is expected steady state in supervised mode, not a block — the workspace directory is host-mounted and survives `lxc delete` regardless, which is the existing rationale for why this check exists at all (surfacing forgotten WIP, not preventing data loss). |
| Retrieval to laptop | Manual, documented flow, no new tooling: from the laptop, `git remote add <name> ssh://moroine@<host>:2222/home/moroine/workspaces/<container>`, then `git fetch <name> agent/<task>:agent/<task>`. From there it's a normal local branch — rebase `--reset-author` onto the laptop's own up-to-date `main`, YubiKey-signs, push to GitHub under the user's identity. `forge start`'s supervised path prints this exact `git remote add` command (with the real container name filled in) at the end of provisioning, so the operator never has to reconstruct the path by hand. Explicitly rejected: a `forge publish` helper that automates rebase/sign/push from the host — this always happens on the laptop, not the host, per the operator's own working style; nothing on the host side needs to run it. |
| `forge list` | No change needed — it already reads and displays `user.forge.mode` generically; supervised containers just show a real value instead of the field never being set to anything but `autonomous`. |

## What stays identical to autonomous mode

Workspace mount (`raw.idmap`-based, no `shift=true`), signing key + git
config for `aiuser`, Claude Code credential reuse, onboarding pre-seed,
plugin install, and every other `pre-bash.sh` block (checkout main, merge,
rebase, `core.hooksPath`/`fsmonitor`/`sshCommand` tampering, `rm -rf`, sudo).
None of this is touched by this design.

## Design

### 1. Mode prompt in `_forge_provision_container`

Added near the top of the provisioning function, before any mode-dependent
step runs:

```bash
echo "Mode for this container?"
echo "  [a] autonomous — bot pushes commits and opens PRs itself"
echo "  [s] supervised — no credential; you retrieve and publish the work yourself"
read -r -p "Choice [a/s]: " MODE_CHOICE
case "$MODE_CHOICE" in
  s|S) MODE="supervised" ;;
  *) MODE="autonomous" ;;
esac
```

`$MODE` then gates the credential/clone section (§2) and is recorded via
`lxc config set "$container" user.forge.mode "$MODE"` in place of today's
hardcoded `"autonomous"`.

### 2. Host-side clone for supervised mode

Replaces the PAT-prompt-and-container-clone block, at the same point in the
sequence, when `$MODE = supervised`:

```bash
echo "Cloning $owner_repo on the host and creating branch agent/$task_name..."
git clone "git@github.com:$owner_repo.git" "$workspace_dir"
(cd "$workspace_dir" && git checkout -b "agent/$task_name")
```

No `lxc exec`, no `gh`, no token prompt. Relies on the operator's existing
forwarded SSH agent (README §7) — a YubiKey touch is expected here, which is
fine since this whole script is run interactively by a human.

### 3. Mode marker + `pre-bash.sh`

New step, alongside the existing hook/settings push:

```bash
lxc exec "$container" -- su - aiuser -c "echo '$MODE' > /home/aiuser/.claude/forge-mode"
```

`pre-bash.sh` reads it near the top:

```bash
FORGE_MODE=$(cat /home/aiuser/.claude/forge-mode 2>/dev/null || echo autonomous)
```

and branches its existing `git push` / `gh` sections on `$FORGE_MODE`:
supervised blocks any `git push` match unconditionally (dropping the
`origin agent/*` carve-out) and any `gh` invocation unconditionally
(dropping the current per-subcommand allowlist-by-exclusion).

### 4. `templates/CLAUDE.md` Git section

The Git section is rewritten to check the marker and present two short
branches — "if `forge-mode` is `autonomous`: <today's push/PR instructions>"
/ "if `forge-mode` is `supervised`: commit locally, signed, on
`agent/<task-name>`; never push, never open a PR — there is no credential to
do so; when the task is complete, state that clearly and stop." The
Contexte/Environnement/Périmètre sections are untouched.

### 5. `next-task` mode branch

```bash
FORGE_MODE=$(cat /home/aiuser/.claude/forge-mode 2>/dev/null || echo autonomous)
...
if [ "$FORGE_MODE" = "autonomous" ]; then
  # existing unpushed-vs-origin/<branch> gate, unchanged
  ...
  git fetch origin
else
  err "Supervised container: skipping unpushed check and git fetch (no credential)."
  err "If you want an up-to-date main, fetch it from a host shell first:"
  err "  cd ~/workspaces/$CONTAINER && git fetch origin"
fi
git checkout -b "agent/$SHORT_NAME" origin/main
```

(`$CONTAINER` isn't directly available inside `next-task` today — the
message can reference the workspace path pattern generically, or the
operator already knows which container they're attached to.)

### 6. `forge_check_wip` mode branch

```bash
mode=$(forge_container_mode "$container")
if [ "$mode" = "supervised" ]; then
  # dirty-tree check only, as above; return here
else
  # existing dirty-tree + unpushed-vs-origin/<branch> checks, unchanged
fi
```

### 7. Retrieval reminder

At the end of a supervised `_forge_provision_container` run:

```bash
echo "Retrieve this container's work from your laptop with:"
echo "  git remote add $container ssh://moroine@<host>:2222$workspace_dir"
```

(`<host>` left as a literal placeholder or the operator's own `ssh config`
alias — same pattern as README §7's `omen` example.)

## Verification checklist

Run on the server against a scratch repo the bot has no access to:

1. `forge start <owner>/<scratch-repo>`, choosing `s` at the prompt:
   provisions with no PAT prompt, no `gh auth` call; `git log` inside the
   container shows the cloned history; `user.forge.mode` reads
   `"supervised"`.
2. Inside the container: commit succeeds and shows **Verified** (signing
   still works); `git push origin agent/<task>` is blocked by `pre-bash.sh`;
   `gh pr create` (and any other `gh` subcommand) is blocked.
3. `!next-task foo` with a clean tree and commits ahead of main succeeds
   without attempting `git fetch origin` and without demanding an
   `origin/<branch>` ref.
4. `forge stop`/`forge delete` on a supervised container with commits ahead
   of main (but a clean tree) succeeds without `--force`; with a dirty tree,
   both still refuse.
5. From the laptop: the printed `git remote add` command works verbatim;
   `git fetch <name> agent/<task>:agent/<task>` retrieves the branch;
   `git rebase --reset-author origin/main` re-authors cleanly; the final
   push lands under the user's identity, YubiKey-signed, with no bot
   involvement anywhere in the pushed history.
6. An autonomous-mode container provisioned before this change (no
   `forge-mode` marker file) still behaves exactly as today — confirms the
   default-to-autonomous fallback in `pre-bash.sh` and `next-task`.

## Out of scope

- **`forge publish` or any host-side automation of the rebase/sign/push
  flow** — this always runs on the laptop, by design; nothing on the host
  needs to script it.
- **Agent-forwarding into the container** — deliberately not done; it would
  reintroduce exactly the standing-credential-adjacent exposure this mode
  exists to avoid.
- **Automating the "fetch fresh main before `next-task`" step** — stays a
  manual host-shell command; `next-task` only documents it.
- **Changing `forge list`'s output format** — already generic over mode.
- **A registry or config file for per-repo mode defaults** — mode is chosen
  once at provisioning time via the interactive prompt, same as the PAT
  paste is today; no persistence beyond the container's own
  `user.forge.mode`.
