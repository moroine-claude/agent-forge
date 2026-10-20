# agent-forge DX — Sub-project 4: Daily work loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the developer's own clone, `forge fetch` shows the agents' branches and `forge ship <task>` re-signs, pushes and opens the PR, for a single task or a chain of stacked tasks; then a spike settles how Git LFS objects travel, for a plan of their own.

**Architecture:**
- **The host records each task's base.** `forge start` stores the ref a task started from as an Incus config key on the container (the agent cannot change it), and a new host command, `forge task-base`, reads it back for the laptop.
- **The laptop works in the developer's clone.** `cli/lib/laptop/clone.ts` finds the repository and its forge remote; `forge fetch` (`cli/lib/commands/fetch.ts`) sets the remote up and fetches through v2's `forge upload-pack`.
- **Shipping is planned, then replayed.** `cli/lib/laptop/ship-plan.ts` turns the recorded bases into a chain and, per task, the commits not yet shipped, where they go and the PR's base; `cli/lib/laptop/replay.ts` replays them in a temporary worktree with the developer's signature and pushes fast-forward only; `cli/lib/laptop/pr.ts` opens or finds the PR with `gh`. `forge ship` (`cli/lib/commands/ship.ts`) runs the chain bottom-up.

**Tech Stack:** Node 24 (type stripping, `node --test`), TypeScript (`npm run check`), git 2.40 or newer, `gh`, OpenSSH.

**Spec:** `docs/superpowers/specs/2026-10-20-dx-chapter-design.md`, section "Sub-project 4: daily work loop" (with "Stacked tasks" and "Shipping twice") and "Decisions". Read it first. This plan builds on sub-project 3's plan (`docs/superpowers/plans/2026-10-20-dx-3-install.md`): `side.ts`, `laptop/state.ts`, `laptop/remote.ts`.

## Global Constraints

- **Never a force-push**, never a rewrite of a commit already on GitHub. The only pushes are fast-forwards of `agent/<task>` on `origin`.
- Signing happens on the laptop only, with the developer's own git configuration (`-S`); nothing is signed in a container or on the host.
- The developer's checkout (its working tree, its index, its current branch, its local branches) is never touched: replays run in a temporary worktree, removed afterwards, including after a failure.
- `forge fetch` and `forge ship` run inside the developer's clone; `origin` must be a GitHub URL (`git@github.com:o/r(.git)`, `ssh://git@github.com/o/r(.git)`, `https://github.com/o/r(.git)`).
- Merge commits among the commits to ship stop `ship` with a message: replaying merges is not supported in this sub-project.
- A task's own commits are those on its container branch and not on its base's container branch (for a stacked task) or not on `origin/<base>` (otherwise).
- No personal value in code, tests or docs.
- Commits: conventional messages. The maintainer signs with a YubiKey; if they are not present, stop before committing and ask.

## Review Focus

1. **Someone pushes to `agent/<task>` on GitHub between `ship`'s fetch and its push**: the push is rejected as non-fast-forward; `ship` must say "GitHub's agent/<task> moved: run forge ship again", never retry with force. → Task 5, test `a push rejected as non-fast-forward stops with the way forward`.
2. **A chain where the bottom task's PR is already merged and its branch deleted**: the next task's commits go onto the bottom task's base and its PR targets that base. → Task 4, test `a stacked task over a merged task targets the merged task's base`.
3. **A replay that conflicts halfway through a chain** (A pushed, B conflicts): A stays shipped, B is untouched on GitHub, the temporary worktree is gone, and the message names B's conflicting commit. → Task 7, test `a conflict in the second task leaves the first one shipped and cleans up`.
4. **A clone whose `origin` is not GitHub, or with no `origin`**: a clear error before any SSH or push. → Task 2, test `a non-GitHub origin is refused`.
5. **An agent-written base cannot steer `ship`**: the base comes from Incus config written by `forge start`, and a base value that is not a valid ref (`validateGitRef`) is treated as unknown. → Task 1, test `an invalid recorded base reads as unknown`.

---

### Task 1: The host records each task's base

**Files:**
- Modify: `cli/lib/commands/start.ts` (`addWorktree`)
- Create: `cli/lib/commands/task-base.ts`
- Modify: `cli/forge.ts` (dispatch, USAGE, `task-base` is a host command)
- Test: `tests/start.test.ts`, `tests/task-base.test.ts`

**Interfaces:**
- Produces:
  - `export const baseKey = (task: string) => \`user.forge.base.${task}\`` (in `cli/lib/containers.ts`), value: the ref the worktree was created from — `origin/main` for a new task, the ref typed in "other branch…" as typed. A task resumed from an existing branch records nothing new (an earlier record stays).
  - `forge task-base <container> [<task>]` — with a task: prints its base or nothing; without: one line per recorded task, `<task>\t<base>`, sorted by task. Validates both names (`validateContainerName`, `validateTaskName`); a recorded value that fails `validateGitRef` is printed as nothing (unknown). `forge finish` keeps the key (the branch survives the worktree).

- [ ] **Step 1: Write the failing tests**
  - `tests/start.test.ts`: `a new task records origin/main as its base`, `other branch… records the ref typed as the base` (asserts a `config set agent-alice-project user.forge.base.<task> <ref>` call after the worktree add), `a resumed branch records no base`.
  - `tests/task-base.test.ts`: one task; all tasks sorted; none recorded → empty output, exit 0; `an invalid recorded base reads as unknown` (value `main;rm`); invalid container name → `ForgeError`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/start.test.ts tests/task-base.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** The record goes through `mustSucceed` right after the `worktree add` that creates the branch. `task-base` lists keys with `incus config show <container>` (or `incus query`) and keeps the `user.forge.base.` ones.

- [ ] **Step 4: Run** `npm run test:unit && npm run check` — PASS.

- [ ] **Step 5: Commit** (`feat: forge start enregistre la base de chaque tâche, forge task-base la lit`)

### Task 2: The developer's clone

**Files:**
- Create: `cli/lib/laptop/clone.ts`
- Test: `tests/laptop-clone.test.ts`

**Interfaces:**
- Produces:
  - `parseGithubUrl(url: string): string | null` — `owner/repo` for the three GitHub URL forms (with or without `.git`, trailing slash tolerated), null otherwise.
  - `openClone(ctx: Context, cwd = process.cwd()): Promise<{ root: string; ownerRepo: string; container: string }>` — `git rev-parse --show-toplevel`, `git remote get-url origin`, `parseGithubUrl`, `validateRepo`, `sanitizeContainerName`. Not in a repository, no `origin`, or a non-GitHub origin → `ForgeError` saying what to do.
  - `forgeRemoteHost(ctx: Context, root: string, container: string): Promise<string | null>` — the alias in `remote.<container>.url` (`<alias>:<container>`), or null.
  - `ensureForgeRemote(ctx: Context, root: string, container: string, alias: string): Promise<"added" | "fixed" | "ok">` — adds `<container>` → `<alias>:<container>` with `remote.<container>.uploadpack = forge upload-pack <container>`, or fixes either value when it differs.

- [ ] **Step 1: Write the failing tests**: the URL forms (`git@github.com:o/r.git`, `ssh://git@github.com/o/r`, `https://github.com/o/r.git/`), `a non-GitHub origin is refused` (`git@gitlab.com:o/r.git`), outside a repository, `ensureForgeRemote` add / fix / ok against a real temporary repository (`createContext()`).

- [ ] **Step 2: Run** `node --test tests/laptop-clone.test.ts` — FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** (`feat(laptop): le clone du développeur et son remote forge`)

### Task 3: `forge fetch`

**Files:**
- Create: `cli/lib/commands/fetch.ts`
- Modify: `cli/forge.ts` (`fetch` is a laptop command; USAGE laptop section: `fetch [--host <name>]`)
- Test: `tests/fetch.test.ts`

**Interfaces:**
- Consumes: `openClone`, `forgeRemoteHost`, `ensureForgeRemote` (Task 2); `selectHost` (sub-project 3); `remoteExec` (sub-project 3).
- Produces:
  - `fetchAgents(ctx: Context, opts: { host?: string; cwd?: string }): Promise<{ root: string; ownerRepo: string; container: string; host: LaptopHost; bases: Map<string, string> }>` — the host is the one of the clone's forge remote when it is listed in `hosts.json`, else `selectHost(opts.host)`; `ensureForgeRemote`; `git fetch --prune <container>`; `git fetch --prune origin` (a merged and deleted branch must disappear); `bases` from `forge task-base <container>` over SSH.
  - `cmdFetch(ctx, opts): Promise<number>` — calls `fetchAgents`, then prints one line per `refs/remotes/<container>/agent/*`: `agent/<task>  <n> commits on <base>` and, when `origin/agent/<task>` exists, `, <m> not shipped` (`<m>` = `+` lines of `git cherry origin/agent/<task> <container>/agent/<task> <limit>`); `<base>` is `main (assumed)` when none is recorded.

- [ ] **Step 1: Write the failing tests** with a real temporary layout: a bare `github.git`, a `container` repository standing in for `/workspace` (its `agent/*` branches), the developer's clone with `origin` → `github.git`; fake only `ssh` (the `forge task-base` answer) and route the `<container>` remote to the local path by overriding its URL in the test (`remote.<c>.url` set to the path after `ensureForgeRemote`, `uploadpack` unset). Cases: first fetch adds the remote and lists two tasks with their counts; a task with one shipped and one new commit says `1 not shipped`; no recorded base says `main (assumed)`; the clone's remote names a host that `hosts.json` lists → no host question.

- [ ] **Step 2: Run** `node --test tests/fetch.test.ts` — FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** `npm run test:unit && npm run check` — PASS.

- [ ] **Step 5: Commit** (`feat: forge fetch`)

### Task 4: The ship plan

**Files:**
- Create: `cli/lib/laptop/ship-plan.ts`
- Test: `tests/laptop-ship-plan.test.ts`

**Interfaces:**
- Produces:
  - `export type Base = { kind: "task"; task: string } | { kind: "branch"; branch: string; assumed: boolean }`.
  - `resolveBase(recorded: string | undefined, tasks: Set<string>, onGithub: (branch: string) => boolean): Base` — undefined/empty → `main`, assumed; `origin/<b>` → `<b>`; `agent/<a>` with `a` in `tasks` → task `a`; `<b>` with `onGithub(b)` → `<b>`; anything else (tag, SHA, unknown) → `main`, assumed.
  - `chainFor(task: string, bases: Map<string, Base>): string[]` — bottom first, ending with `task`; a cycle → `ForgeError` naming the tasks.
  - `export type TaskPlan = { task: string; tip: string; limit: string; commits: string[]; onto: string; prBase: string; shipped: boolean }` — refs as names (`<c>/agent/<t>`, `origin/…`), `commits` oldest first.
  - `planTask(ctx: Context, root: string, container: string, task: string, base: Base, below?: { prBase: string; merged: boolean }): Promise<TaskPlan>`, where:
    - `tip` = `<container>/agent/<task>`; `limit` = `<container>/agent/<a>` (task base) or `origin/<branch>`;
    - `shipped` = `origin/agent/<task>` exists;
    - `commits` = the `+` lines of `git cherry <shipped ? origin/agent/<task> : limit> <tip> <limit>`; a merge commit among them → `ForgeError`;
    - `onto` = `origin/agent/<task>` when shipped; else for a task base: `origin/agent/<a>`, or `origin/<below.prBase>` when `below.merged`; else `git merge-base origin/<branch> <tip>` (the first ship signs in place: same parents, same content);
    - `prBase` = `agent/<a>` for a task base (`below.prBase` when `below.merged`), else `<branch>`.

- [ ] **Step 1: Write the failing tests** against real temporary repositories (same layout as Task 3, built by a shared helper `tests/lib/git-layout.ts` that Task 3 can reuse):
  - `resolveBase` table (each rule above);
  - `chainFor` for a three-task chain and a cycle;
  - first ship of a task on `main`: all own commits, `onto` = the merge base, `prBase` `main`;
  - `shipping twice signs only the new commits`: GitHub's `agent/t` holds signed copies of the first two (simulate with `cherry-pick` onto the merge base, committer changed), the container branch has a third → `commits` = the third, `onto` = `origin/agent/t`;
  - `outside commits on GitHub become the parent` (GitHub's `agent/t` has an extra commit): `onto` = `origin/agent/t`, `commits` = the agent's unshipped ones;
  - stacked: B over A, neither shipped → B's `commits` exclude A's, `onto` = `origin/agent/a`, `prBase` `agent/a`;
  - `a stacked task over a merged task targets the merged task's base` (`below = { prBase: "main", merged: true }`): `onto` = `origin/main`, `prBase` = `main`;
  - a merge commit among the commits → rejects with `merge commit`.

- [ ] **Step 2: Run** `node --test tests/laptop-ship-plan.test.ts` — FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** (`feat(laptop): plan d'envoi d'une tâche ou d'une chaîne`)

### Task 5: Replay and push

**Files:**
- Create: `cli/lib/laptop/replay.ts`
- Test: `tests/laptop-replay.test.ts`

**Interfaces:**
- Produces:
  - `replayAndPush(ctx: Context, root: string, plan: TaskPlan, opts: { sign: boolean }): Promise<"pushed" | "nothing">` — `"nothing"` when `plan.commits` is empty. Otherwise: `git worktree add --detach <tmp> <plan.onto>` (tmp under `os.tmpdir()`), `git -C <tmp> cherry-pick [-S] <commits…>` (authors kept), then `git -C <tmp> push origin HEAD:refs/heads/agent/<task>` with no force option of any kind, then `git worktree remove --force <tmp>` in a `finally` (the `--force` only discards the temporary worktree). A cherry-pick conflict → `git -C <tmp> cherry-pick --abort`, `ForgeError` naming the commit (`<short sha> <subject>`); a rejected push → `ForgeError("GitHub's agent/<task> moved since the fetch: run forge ship again.")`.

- [ ] **Step 1: Write the failing tests** (real repositories, `sign: false` except one test):
  - the first ship pushes commits whose trees equal the agent's and whose parents equal the agent's parents; the developer's checkout (`HEAD`, `git status --porcelain`, `git worktree list`) is unchanged after the run;
  - `shipping twice` pushes only the third commit, as a fast-forward of `origin/agent/t`;
  - a conflicting replay rejects, leaves `origin/agent/t` unchanged, and leaves no temporary worktree;
  - `a push rejected as non-fast-forward stops with the way forward` (advance `github.git`'s `agent/t` between the plan and the push);
  - with `ssh-keygen` present: a throwaway SSH signing key (`gpg.format=ssh`, `user.signingkey`) set in the test clone's config, `sign: true` → `git log --format=%G?` on the pushed commits is not `N`.

- [ ] **Step 2: Run** `node --test tests/laptop-replay.test.ts` — FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** (`feat(laptop): rejouer, signer et pousser sans jamais forcer`)

### Task 6: The PR

**Files:**
- Create: `cli/lib/laptop/pr.ts`
- Test: `tests/laptop-pr.test.ts`

**Interfaces:**
- Produces:
  - `prState(ctx: Context, root: string, branch: string): Promise<{ open?: string; merged: boolean }>` — `gh pr list --head <branch> --state all --json url,state` run in `root`; `open` = the URL of an open PR.
  - `ensurePr(ctx: Context, root: string, branch: string, base: string): Promise<{ url: string; created: boolean }>` — an open PR → its URL; none → `gh pr create --base <base> --head <branch> --fill`, the URL from its output.
  - `gh` missing or not logged in (`gh auth status` non-zero) → `ForgeError` saying to install it or run `gh auth login`.

- [ ] **Step 1: Write the failing tests** with fake `gh` rules: open PR found; none → create argv exact; merged only → `merged: true`, no `open`; `gh auth status` failing → error.

- [ ] **Step 2: Run** `node --test tests/laptop-pr.test.ts` — FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** (`feat(laptop): ouvrir ou retrouver la PR d'une tâche`)

### Task 7: `forge ship`

**Files:**
- Create: `cli/lib/commands/ship.ts`
- Modify: `cli/forge.ts` (`ship` is a laptop command; USAGE: `ship <task> [--host <name>]`)
- Test: `tests/ship.test.ts`

**Interfaces:**
- Consumes: `fetchAgents` (Task 3), `resolveBase`, `chainFor`, `planTask` (Task 4), `replayAndPush` (Task 5), `prState`, `ensurePr` (Task 6).
- Produces: `cmdShip(ctx: Context, task: string | undefined, opts: { host?: string; cwd?: string; sign?: boolean }): Promise<number>` (`sign` defaults to true; tests pass false).

The run:
1. `gh` check (Task 6), then `fetchAgents`.
2. The task: given, or `ctx.prompt.pick("Task", <tasks under refs/remotes/<c>/agent/>)`; unknown → `ForgeError` listing them.
3. Bases for every task (`resolveBase`); for an `assumed` base on a task of the chain, `ctx.prompt.pick(\`agent/<t> has no recorded base: open its PR against main?\`, ["yes", "no"])`, no/null → stop.
4. `chainFor(task)`; plan the whole chain bottom-up (`planTask`, passing `below` from the task underneath: its `prBase` and `prState(...).merged && !prState(...).open`), so the total is known before anything is signed.
5. Print `Signing <N> commits: <t1> (<n1>), <t2> (<n2>)` (or `Nothing new to sign.`).
6. For each task, bottom-up: `replayAndPush`, then `git fetch origin agent/<t>` so the next task's `onto` sees it, then `ensurePr(…, \`agent/<t>\`, plan.prBase)`; print `agent/<t>: <pushed n commits | nothing new>, <created|existing> PR <url>`. A failure stops the chain there; the lines printed so far say what was shipped.

- [ ] **Step 1: Write the failing tests** (real repositories as in Task 4, fake `ssh` and `gh`):
  - one task: pushed, PR created against `main`, output lines exact;
  - a chain A ← B ← C shipped from C: three pushes in order A, B, C; PRs against `main`, `agent/a`, `agent/b`;
  - re-running right after: `Nothing new to sign.`, existing PRs, no push;
  - `a conflict in the second task leaves the first one shipped and cleans up`;
  - an assumed base answered no → nothing pushed;
  - the task asked by a pick when left out.

- [ ] **Step 2: Run** `node --test tests/ship.test.ts` — FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run everything**

Run: `npm test && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit** (`feat: forge ship, une tâche ou toute sa chaîne`)

### Task 8: Docs and the agent's instructions

**Files:**
- Modify: `README.md` ("Get the work back" — step 7 of the local quick start, the remote section's mention, "Rules for getting work back")
- Modify: `container/CLAUDE.md` (supervised mode: the retrieval block)
- Modify: `tests/test-readme-docs.sh`, `tests/test-claude-template.sh`

- [ ] **Step 1: Update the doc tests first**: README must contain `forge fetch`, `forge ship <task>`, `stacked`, and no longer `git config remote.` nor `uploadpack` (the manual form moves to `ansible/README.md`'s "Installing by hand" section from sub-project 3, which keeps `uploadpack` and `forge upload-pack`); `container/CLAUDE.md` must contain `forge fetch` and `forge ship <task-name>` and no longer `git rebase --reset-author`. Run them: FAIL.
- [ ] **Step 2: Rewrite**
  - README "Get the work back": in your clone, `forge fetch` (what it lists), review the branch (`git log -p main..agent-<owner>-<repo>/agent/<task>`), then `forge ship <task>`: what it signs, that it never force-pushes, that a stacked task ships its whole chain, that each signature may need a key touch.
  - `container/CLAUDE.md`, supervised mode: when the task is done, the agent tells the human to run, in their clone, `forge fetch`, review, then `forge ship <task-name>`; it names its base when it started from another task's branch. The rest of the paragraph (no push, no `gh`, read-only `origin`) stays.
- [ ] **Step 3: Run** `npm run test:bash` — PASS.
- [ ] **Step 4: Commit** (`docs: récupération par forge fetch et forge ship`)

### Task 9: LFS spike

**Files:**
- Create: `docs/superpowers/spikes/2026-10-xx-lfs-transport-spike.md` (the day it runs)

The spec requires a spike before any LFS task. It runs on a disposable host (a Lima VM installed with `forge install`) with a test repository that tracks a few binary files with LFS.

- [ ] **Step 1: Read path.** In the host mirror, `git lfs fetch --all origin` with the forwarded agent; in a container, clone from the read-only `/forge/origin.git` without `GIT_LFS_SKIP_SMUDGE`, with git-lfs pointed at the mirror (`lfs.url` / `remote.origin.lfsurl` = `file:///forge/origin.git`, git-lfs's standalone file transfer). Record: does checkout fill the files? Does anything try to write to the read-only mount? Which git-lfs version does the image ship?
- [ ] **Step 2: Write path, candidate A.** A host command that runs `git-lfs-transfer` (git-lfs's SSH transfer protocol) inside the container, the way `forge upload-pack` runs `git-upload-pack`; from the laptop, can `git lfs fetch <container>` download the agent's new objects through it? What must the laptop's git config carry?
- [ ] **Step 3: Write path, candidate B.** The host copies the agent's new objects out of `/workspace/.git/lfs/objects` (`incus file pull`), checks each file's SHA-256 against its object id, and uploads them to GitHub from the mirror (`git lfs push --object-id origin <oid>…`) with the forwarded agent. Then a laptop `git push` of the branch: does GitHub accept it without the objects in the laptop's clone?
- [ ] **Step 4: Report** what worked, the commands, the failure modes, and a recommendation between A and B against the spec's constraints (no credential in the container, no host git in the workspace, every object checked against its id). The LFS implementation then gets its own plan from that report; it is not part of this one.

### Task 10: The maintainer's walk-through

- [ ] **Step 1:** On the Mac, in a real clone: a task done by an agent, `forge fetch`, review, `forge ship <task>` with the YubiKey; the PR opens with signed commits ("Verified" on GitHub).
- [ ] **Step 2:** The agent adds a commit; `forge ship <task>` again pushes only it.
- [ ] **Step 3:** A task B started from A's branch ("other branch…" → `agent/a`); `forge ship b` ships A then B, B's PR targets `agent/a`.
- [ ] **Step 4:** Report in the PR (`agent/dx-4-work-loop`, `--base main`).
