# agent-forge CLI — Design

**Date:** 2026-07-14
**Status:** Approved pending user review
**Sub-project:** 3 of 3 in the agent-forge DX overhaul (repo registry + `forge` CLI + session visibility), as scoped in `docs/superpowers/specs/2026-07-11-autonomous-git-mode-design.md`

## Context

Container provisioning and session-start already work (`new-agent-container.sh`,
`start-agent.sh`), but day-to-day use has rough edges:

1. Two loose scripts, no single entry point, no bash completion.
2. `new-agent-container.sh <project-name> <owner/repo>` takes an arbitrary
   project name — nothing ties a container back to its repo except the name
   you happened to type. There is one container per invocation, so finishing
   a task and starting a new one on the same repo means recreating the whole
   container (idmap mount, credential push, onboarding pre-seed, plugin
   install, PAT paste) from scratch.
3. Reattaching to a running session requires remembering tmux prefix keys
   (`Ctrl+b d` to detach) — `claude`'s own keybindings, run nested inside the
   wrapping `tmux new-session`, can visually collide with tmux's, which is
   confusing but not a data-loss risk (tmux's server persists in the
   container independent of the SSH client, so closing the SSH connection
   outright doesn't kill the session either way).
4. No single place to see which containers exist, what repo they're on, or
   whether a session is alive.
5. Rebuilding the `agent-base` image is a copy-pasted sequence of manual
   `lxc exec` commands from the README (§5), not a runnable command.

## Decisions

| Decision | Choice |
|---|---|
| Container model | One LXD container per repo (not per arbitrary project name), reused sequentially across tasks. Only one task/branch active at a time — no git worktrees, no concurrent tasks in one container (deferred: real dev-server/port conflicts would result). |
| Container naming | Derived deterministically from `owner/repo`: `agent-<owner>-<repo>`, sanitized. No separate project name to choose or remember. |
| Registry | None — no separate state file. `forge` discovers containers via `lxc list -f json` filtered to the `agent-*` naming convention, and reads `owner/repo` + mode back from LXD container config keys (`user.forge.repo`, `user.forge.mode`) set at provisioning time. LXD's own state is the single source of truth. |
| PAT / credential storage | Unchanged: never written to host disk. Pasted once per repo, at first `forge start`, into that repo's now-long-lived container. Re-pasting is only needed if the container is later deleted and recreated — accepted as a rare manual step, same trust boundary as today. |
| CLI entry point | Single script `scripts/forge` with subcommand dispatch, shared helpers in `scripts/lib/forge-common.sh`. Replaces `new-agent-container.sh` and `start-agent.sh` entirely (both retired). |
| Provision-vs-start | Collapsed into one command, `forge start <owner/repo> [task-name]`: provisions if no container exists yet, otherwise starts/attaches. No separate `forge new`. |
| Initial branch name | `task-name` is an optional second argument to `forge start`, used only on first provisioning to create `agent/<task-name>`. Defaults to `main` (i.e. `agent/main`) if omitted — mirrors `next-task <short-name>`'s branch-naming pattern, and you can immediately `!next-task <real-name>` before starting work if you want a more specific name up front. |
| New-task-in-place | A human-invoked (not agent-invoked) script, `next-task`, baked into the `agent-base` image. Run via `!next-task <short-name>` inside a Claude session — outside the agent's own tool loop, so `pre-bash.sh`'s "the agent never switches branches" guarantee is untouched. |
| Image rebuild | `forge image build` (aliased `forge image update`) scripts the existing manual README build steps. Only affects containers created after the rebuild — already-running containers are not patched in place. |
| Session visibility | `forge list` shows repo, mode, LXD state, and (for running containers) whether a `claude` tmux session is alive inside. |
| Bash completion | `forge completion bash`, dynamically completing `<owner/repo>` from `forge list`, sourced via `eval "$(forge completion bash)"`. |

## Design

### 1. Container identity & discovery

Sanitization: lowercase `owner/repo`, collapse any character outside
`[a-z0-9-]` to `-`, join with `-agent-` prefix:
`agent-<owner>-<repo>`. This reuses the same character-class validation
already applied to project names in `new-agent-container.sh`, just applied to
`owner-repo` instead of a free-form string.

At provisioning time (inside `forge start`'s create-if-missing path):

```bash
lxc config set "$CONTAINER" user.forge.repo "$OWNER/$REPO"
lxc config set "$CONTAINER" user.forge.mode "autonomous"
```

Every other subcommand discovers containers with:

```bash
lxc list -f json | jq -r '.[] | select(.name | startswith("agent-")) | .name'
```

then reads `user.forge.repo` / `user.forge.mode` per container via
`lxc config get`. `mode` is stored now (even though only `"autonomous"`
exists) so supervised mode (sub-project 2, not yet built) can be added later
without a schema change.

**Collision handling:** before provisioning, `forge start` computes the
target container name and, if a container with that name already exists,
compares its stored `user.forge.repo` against the requested `owner/repo`. A
mismatch (two different repos sanitizing to the same container name) is
refused with an explicit error rather than silently reusing the wrong
container. This is expected to be vanishingly rare given the naming scheme.

### 2. `forge` command surface

`scripts/forge`, subcommand dispatch via `case "$1" in ... esac`, sourcing
`scripts/lib/forge-common.sh` for: `owner/repo` validation, name
sanitization, container-lookup-by-repo, and the shared precondition helpers.

| Command | Behavior |
|---|---|
| `forge start <owner/repo> [task-name]` | If no container exists for the repo: provisions one — idmap-shifted workspace mount, signing key + git config, Claude credential/onboarding push, plugin install, PAT prompt, clone, `agent/<task-name or "main">` branch creation. This is today's `new-agent-container.sh` body, unchanged in substance, minus the project-name argument (replaced by the derived container name plus this optional branch-name arg). `task-name` is ignored if the container already exists (a warning is printed if it was passed anyway). Then (both fresh and pre-existing cases): `lxc start` if stopped, then `tmux new-session -A -s claude 'claude --permission-mode auto --remote-control <container-name>'` inside via `lxc exec ... su - aiuser`. |
| `forge stop <owner/repo>` | `lxc stop <container>`. Workspace, gh auth, and tmux session state all persist (only the running VM state stops). |
| `forge delete <owner/repo> [--force]` | WIP pre-flight check (§3), then `lxc delete --force`. |
| `forge list` | One line per `agent-*` container: repo, mode, LXD state (RUNNING/STOPPED), and for running containers, whether `tmux has-session -t claude` succeeds inside. |
| `forge image build` / `forge image update` | Aliases of the same subcommand (§4). |
| `forge completion bash` | Prints a bash completion function to stdout; dynamic `<owner/repo>` completion sourced from `forge list`'s output. |

`new-agent-container.sh` and `start-agent.sh` are deleted (kept in git
history; no deprecation shim, per repo convention of not carrying dead code
forward).

### 3. Task reuse (`next-task`)

`next-task` is a script baked into the `agent-base` image (e.g.
`/home/aiuser/.local/bin/next-task`), installed during `forge image build`
alongside `gh`/Chrome/etc. — not pushed per-container by `forge start`. It is
invoked by the human operator from inside a live Claude Code session via the
`!` shell-escape (`!next-task <short-name>`), never by the agent itself.

Behavior:

1. Refuse if `/workspace` has a dirty tree (`git status --porcelain`
   non-empty) or the current branch has commits not present on its `origin`
   counterpart (unpushed work) — print what's at risk and stop.
2. `git fetch origin && git checkout -b agent/<short-name> origin/main`.
3. Print the new branch name so the operator can tell the agent to start
   fresh.

Because this runs as a plain shell command outside the agent's tool loop, no
change to `pre-bash.sh` or `templates/CLAUDE.md`'s "never switch branches"
rule for the agent is needed — the safety boundary that exists today for
agent-initiated git operations is untouched.

**Iteration note:** since `next-task` is baked into the image rather than
pushed per-container, changing it during this initial stabilization period
requires `forge image build` followed by deleting and recreating affected
containers. Accepted short-term cost; once stable it's a fixed part of the
base image like any other installed tool.

### 4. Image build/update

`forge image build` (== `forge image update`) scripts the existing manual
README §5 sequence: launch a scratch `agent-base-setup` container, install
packages (Node LTS, pnpm, Claude Code, `gh`, Chrome, `next-task`), create
`aiuser`, set up `/workspace`/`.ssh`/`.claude` ownership, then
`lxc publish --alias agent-base` and clean up the scratch container. If a
leftover `agent-base-setup` container already exists (e.g. a previous run
failed partway), it's deleted first so the command is safely re-runnable.

Only affects containers created after the rebuild. Already-running
containers are not touched — this was an explicit choice to avoid drift
tooling for now; if a running container needs the new image, delete and
`forge start` it again.

### 5. Safety checks & preconditions

Per repo convention, every subcommand checks preconditions before mutating
anything:

- `forge start` (provisioning path): valid `owner/repo` format, `agent-base`
  image exists, host `~/.claude/.credentials.json` exists.
- `forge stop` / `delete` / `list`: container-exists lookup via §1's
  discovery mechanism; errors clearly if the repo has no container.
- `forge delete`: WIP pre-flight — `git status --porcelain` (dirty tree) and
  a check for the current branch having commits absent from its `origin`
  counterpart (unpushed), both via `lxc exec ... su - aiuser`. Either
  non-empty blocks deletion unless `--force`. Note: the workspace directory
  itself is host-mounted (idmap-shifted) and survives `lxc delete`
  regardless — this check exists to surface *forgotten* WIP before you lose
  easy access to it (re-provisioning re-clones fresh), not to prevent actual
  data loss.
- `forge image build`: cleans up a leftover `agent-base-setup` container
  before starting.

### 6. Testing

Same pattern as the existing `tests/test-*.sh` suite: grep-based
structural/ordering assertions plus `bash -n`, no `lxc` calls (this repo is
edited from inside a container with no LXD access — see the prior
provisioning-DX plan's constraints). One test file per new `scripts/forge`
subcommand's logic, plus a test for `scripts/lib/forge-common.sh`'s naming/
sanitization function (pure bash string manipulation, directly testable by
sourcing the library and calling the function). Server-side end-to-end
verification (actually running `forge start`/`stop`/`delete`/`list` against
a scratch repo, testing `!next-task`, rebuilding the image) stays a manual
checklist task run on the server, not executed by the implementing agent.

### 7. Documentation

- `README.md`: Usage section rewritten around `forge` (replaces the
  `new-agent-container.sh`/`start-agent.sh` walkthrough); a bash-completion
  setup line; a short "reusing a container for a new task" subsection
  documenting `!next-task`; §5 (base image build) reframed as "run `forge
  image build`" with the manual command sequence kept as the reference
  implementation detail, not a copy-paste ritual.
- `templates/CLAUDE.md`: one-line, informational-only addition noting the
  operator may reuse this container for future tasks via `next-task` — does
  not change any agent-facing rule (still: stay on `agent/<project>`, never
  switch branches, never merge).

## Verification checklist

Run on the server against a scratch repo:

1. `forge start <owner>/<scratch-repo>` on a repo with no existing container:
   provisions end to end (same outcome as today's `new-agent-container.sh`),
   then starts a session with no onboarding questions.
2. `forge start <owner>/<scratch-repo>` again (container already exists,
   possibly stopped): starts/attaches without re-provisioning or re-prompting
   for the PAT.
3. `forge list` shows the container with correct repo, mode, state, and
   tmux-alive status.
4. `forge stop` then `forge list` reflects STOPPED; `forge start` again
   brings it back with the same gh auth and workspace state intact.
5. Inside a session: dirty/unpushed tree blocks `!next-task foo`; a clean,
   pushed tree lets it create `agent/foo` from fresh `origin/main`.
6. `forge delete` refuses on a dirty/unpushed tree without `--force`, and
   succeeds with `--force` or once the tree is clean/pushed.
7. `forge image build` produces a new `agent-base` publish and cleans up its
   scratch container; a subsequent `forge start` on a new repo picks up the
   new image (spot-check `next-task` is present).
8. `forge completion bash` sourced in `~/.bashrc`; tab-completing
   `forge start <TAB>` lists known repos.
9. Existing `pre-bash.sh` guardrails (branch/push restrictions, `gh`
   restrictions) still fire unchanged — this design doesn't touch that file.

## Out of scope

- **Supervised mode** (sub-project 2 of the original decomposition):
  fetch-only credential, user-side rebase/re-author/sign/push flow. `mode`
  is stored per container (§1) so it can be added later without a schema
  change, but no supervised-mode behavior is implemented here.
- **Git worktrees / concurrent tasks per container**: deliberately deferred
  given real port/dev-server conflict risk when multiple tasks run
  simultaneously in one container. `next-task` is sequential-only — the
  current task must be clean and pushed before starting the next.
- **In-place image patching of already-running containers**: `forge image
  update` only affects newly created containers. No drift-detection or
  in-place package-refresh tooling for long-lived containers.
- **Host-side PAT storage/reuse across container recreation**: explicitly
  rejected to preserve the existing "credentials never touch host disk"
  invariant. The container-per-repo reuse model was judged sufficient to
  solve the actual friction (re-pasting per *task*), leaving the rarer
  re-paste-after-recreation case as an accepted manual step.
- **`next-task` pushed per-container instead of baked into the image**:
  considered and rejected — baking it into `agent-base` was preferred despite
  requiring image rebuilds during this stabilization period, since it will
  be stable long-term and avoids a redundant push step in `forge start`.
