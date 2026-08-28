# Parallel features via git worktrees + container versioning — design

- **Date**: 2026-08-28
- **Status**: approved (brainstorming), ready for planning
- **Repo**: agent-forge
- **Follow-up split out**: host terminal garbles on resize → see `docs/superpowers/BACKLOG.md`

## Problem

The current model is **one container per repo, one working tree, one branch**:

- `/workspace` is a single git clone. `next-task` *switches* that one tree to a
  fresh branch. Two features therefore cannot exist side by side — you can't run
  several Claude sessions in parallel on the same repo.
- `main` goes stale: nothing fetches `origin` except `next-task` (autonomous) or a
  manual host-shell fetch (supervised), so the base a new task branches from is
  whatever was last pulled.
- The `agent-base` image lacks `git-lfs`.
- There is no way to tell which containers/images were built from an outdated
  agent-forge checkout and should be rebuilt.

## Goals

1. Run **multiple features in parallel** on one repo, each on its own
   `agent/<task>` branch, isolated from the others.
2. Clear verbs: **`start`** = new feature, **`resume`** = reprendre an existing one.
3. Keep the repo's `main` **fresh automatically**.
4. Ship **`git-lfs`** in the image.
5. **Version-stamp** the image at build time and each container with the build it
   was created from, so `forge list` flags **running containers built from an older
   image than the latest build**. (Deciding *when* to rebuild the image is the
   operator's call — the tool only surfaces stale running containers.)

## Non-goals

- Per-task security/resource isolation (rejected the container-per-feature model):
  parallel tasks share one container's CPU/RAM. Accepted trade-off.
- Fixing the terminal-resize garble — deferred to its own spec (needs host-side
  diagnosis first; see BACKLOG).
- Changing the autonomous/supervised auth model. Mode stays **per container**;
  all tasks in a repo share the same `gh` credential.

## Design

### 1. Worktree layout (model "A1": worktrees under the mount)

The host bind-mount is unchanged:

```
host: /home/moroine/workspaces/agent-<owner>-<repo>  ──(lxc disk device)──▶  container: /workspace
```

Inside it:

```
/workspace/                      the "main" clone, pinned to `main`, never checked out to a feature branch
  .git/                          shared object store + refs + .git/worktrees/*
  <main's files>
  .trees/
    feat-a/                      git worktree, branch agent/feat-a   ← claude session "feat-a"
    feat-b/                      git worktree, branch agent/feat-b   ← claude session "feat-b"
```

Key properties (why A1):

- **Durability preserved.** Working trees *and* uncommitted WIP live under the
  host mount, so they survive `lxc delete` exactly like today. This is the
  invariant `forge_check_wip` / `stop --force` / supervised retrieval rely on.
- **Shared `.git`.** A single `git fetch` updates `origin/*` for every worktree at
  once — this is what makes "keep main fresh" a one-liner (§3).
- **Supervised retrieval intact.** Branches live in the shared `.git` refs, not in
  the worktree directory, so `git fetch <container> agent/feat-a:agent/feat-a`
  and host-side `git log -p main..agent/feat-a` keep working without ever
  entering `.trees/`.
- **Worktree gitdir links store the container-absolute path** (`/workspace/...`).
  That's fine because git is only ever run **inside** the container, where the
  path is always `/workspace`. On the host those links are cosmetically dangling
  and never traversed.
- `.trees/` is excluded via **`.git/info/exclude`** (local, not the versioned
  `.gitignore`) so it never pollutes the target repo.

The main clone at `/workspace` is now a *reference*, kept on `main`. All work
happens in `.trees/<task>`.

### 2. Command surface

```
forge start  <owner/repo> <task>   Provision container if absent; fetch + ff main;
                                    create .trees/<task> on agent/<task> from origin/main;
                                    attach tmux session "<task>" running claude in that worktree.
                                    Error if the worktree already exists (→ resume).

forge resume <owner/repo> <task>    Re-attach the tmux session "<task>" (claude resumes).
                                    No fetch, no rebranch. Error if the worktree is absent.

forge finish <owner/repo> <task>    WIP check on THIS worktree (dirty; unpushed in autonomous),
                 [--force]          then `git worktree remove` and kill its tmux session.
                                    The branch ref is retained in .git.

forge stop   <owner/repo> [--force] Stop the whole container. WIP check across ALL worktrees.
forge delete <owner/repo> [--force] Delete the container (WIP check across ALL worktrees). Mount persists.
forge list                          Containers + their tasks (worktree, branch, session) + version status.
forge image build|update            Rebuild agent-base (now installs git-lfs; stamps its commit).
forge completion bash               Unchanged (now also completes resume/finish).
```

- `task` is **required** for `start`/`resume`/`finish` (the old default `init` is
  dropped — a parallel model needs a name).
- **`next-task` is removed.** Its only purpose was avoiding a re-provision by
  recycling the single tree; `forge start <repo> <other-task>` on an existing
  container now just adds a worktree, no re-provision. `config/next-task.sh`, its
  image install step, and `tests/test-next-task.sh` are deleted, and all
  references in `README.md` / `templates/CLAUDE.md` removed.

#### Provisioning (first `forge start` for a repo)

Same as today up to the clone, then:

- Clone into `/workspace` and **stay on `main`** (do not check out a feature
  branch there). Both modes.
- `git -C /workspace worktree add .trees/<task> -b agent/<task> origin/main`.
- Add `.trees/` to `/workspace/.git/info/exclude`.
- `git lfs install` for `aiuser` (§4).
- Stamp version keys (§5).

The tmux attach becomes per-task:

```sh
lxc exec "$container" -- su - aiuser -c "
  cd /workspace/.trees/<task>
  tmux new-session -A -s '<task>' 'claude --permission-mode auto --remote-control ${container}-<task>'
"
```

(`--remote-control` name made unique per task: `${container}-<task>`.)

### 3. Keeping `main` fresh

On every `forge start` (before creating the worktree):

```sh
git -C /workspace fetch origin
git -C /workspace merge --ff-only origin/main    # main is never committed to locally, so this always fast-forwards
```

Because the `.git` is shared, every existing worktree immediately sees the fresh
`origin/main` and can `git merge origin/main` (the one merge form pre-bash allows).
Supervised containers have no credential, so the fetch is skipped there with a
note — same policy as the retired `next-task`.

### 4. git-lfs

- **Image** (`forge-image.sh`): `apt install -y git-lfs`.
- **Provisioning**: `git lfs install` as `aiuser` after the clone, so LFS smudge/clean
  filters are configured globally (all worktrees inherit it via the shared config).
- `tests/test-forge-image.sh` asserts the package line is present.

### 5. Container versioning (running container vs. latest build)

The only question `forge` needs to answer: **is this running container built from the
current `agent-base` image, or an older one?** No comparison against the agent-forge
HEAD, no per-file filtering — the operator owns the "should I rebuild the image?"
decision.

Each build gets an identity, and each container remembers the build it came from:

| When                | Action                                                                            |
|---------------------|-----------------------------------------------------------------------------------|
| `forge image build` | Stamp the built image with its build commit: image property `user.forge.commit = git -C "$FORGE_REPO_DIR" rev-parse HEAD`. |
| provisioning        | Copy the *current* `agent-base` image's `user.forge.commit` onto the container as config key `user.forge.image_commit`. |

`forge list` then compares each container's `user.forge.image_commit` against the
**current** `agent-base` image's `user.forge.commit` — a plain equality check:

```
agent-owner-repo   autonomous   Running   2 tasks
  build @a1b2c3   (latest @e5f6a7)   ⚠ older than latest build — recreate to refresh
  tasks:
    feat-a   agent/feat-a   session attached
    feat-b   agent/feat-b   session detached
```

- Equal → no flag.
- Different → `⚠ older than latest build — recreate (delete + start)`.

`FORGE_REPO_DIR` (default `/home/moroine/agent-forge`, already used by
`forge-start.sh`) is needed only at **build** time, to read the commit to stamp.

Edge cases: a container with no `user.forge.image_commit` (legacy /
partially-provisioned) prints `@unknown → consider recreate`; if the `agent-base`
image is absent, `forge list` notes it can't determine the latest build rather than
flagging every container.

> Alternative considered: stamp the LXD **image fingerprint** instead of a git
> commit (git-free, changes on every rebuild). Rejected for display readability —
> a commit hash is meaningful to a human reading `forge list`; the equality check
> is identical either way.

### 6. Security

- **The "agent never switches branches" guarantee is unchanged.** Each session is
  pinned to its worktree's branch; `pre-bash.sh` still blocks `git checkout`/branch
  switches inside agent sessions. `git worktree add|remove` are run by `forge` on the
  **host**, never by the agent — no new agent capability, so `pre-bash.sh` needs no
  change. (A `test-pre-bash.sh` assertion documents that worktree commands are not
  expected from the agent.)
- No change to the mount, `raw.idmap`, or the disk device — worktrees are just
  subdirectories of the existing mount.

## Files touched

- `scripts/lib/forge-start.sh` — split provision vs. add-task; worktree add; fetch/ff main; lfs install; stamp `user.forge.image_commit` from the current image; per-task tmux.
- `scripts/lib/forge-resume.sh` — **new**.
- `scripts/lib/forge-finish.sh` — **new**.
- `scripts/lib/forge-common.sh` — `forge_check_wip` iterates all worktrees; worktree/path helpers; `FORGE_REPO_DIR`; helper to read the current image commit and compare it to a container's stamp.
- `scripts/lib/forge-list.sh` — per-task rows + build-vs-latest flag.
- `scripts/lib/forge-stop.sh`, `scripts/lib/forge-delete.sh` — WIP across all worktrees.
- `scripts/lib/forge-image.sh` — install git-lfs; stamp image commit (`user.forge.commit`); drop next-task push.
- `scripts/forge` — wire `resume`/`finish`; usage.
- `scripts/lib/forge-completion.sh` — complete `resume`/`finish`.
- `config/next-task.sh` — **deleted**.
- `templates/CLAUDE.md`, `README.md` — worktree model, new verbs, remove next-task, git-lfs, versioning.

## Testing

Plain-bash module tests, matching the existing `tests/` style:

- **Delete** `tests/test-next-task.sh`.
- **New** `tests/test-forge-resume.sh`, `tests/test-forge-finish.sh`.
- **Extend** `tests/test-forge-common.sh` — worktree path derivation, build-compare
  (equal = no flag; different = flag; missing stamp = unknown), multi-worktree WIP check.
- **Update** `tests/test-forge-start.sh` (worktree add, fetch/ff, `image_commit` stamp),
  `tests/test-forge-image.sh` (git-lfs line, image `commit` stamp),
  `tests/test-forge-dispatcher.sh` (resume/finish subcommands),
  `tests/test-readme-docs.sh` (no next-task references; new verbs documented).

## Deferred

- **Host terminal garbles on resize** (htop garbles too → layers 1–2, not the
  Claude TUI). First diagnostic in its own spec: attach, resize, run `stty size`
  — old size ⇒ `lxc exec` isn't forwarding SIGWINCH (fix via recent LXD or SSH
  attach); new size but still garbled ⇒ tmux redraw (`aggressive-resize`,
  `refresh-client -S`). Tracked in `docs/superpowers/BACKLOG.md`.
