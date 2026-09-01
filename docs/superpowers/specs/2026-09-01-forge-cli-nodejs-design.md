# Rewrite the forge CLI in TypeScript — design

- **Date**: 2026-09-01
- **Status**: approved (brainstorming), ready for planning
- **Repo**: agent-forge
- **Supersedes the implementation of**: `docs/superpowers/specs/2026-07-14-agent-forge-cli-design.md` (the command surface it defines stays; only the language changes)

## Problem

The forge CLI is ~1070 lines of bash across nine files, and it has outgrown the
language:

- **Data lives in strings.** `forge list` collects rows as tab-joined strings and
  re-splits them with `IFS=$'\t' read -r kind f1 f2 f3 f4` because bash has no
  record type. The column-width pass exists twice, once as arithmetic and once as
  `printf` format strings built at runtime.
- **Errors propagate by hand.** Every call site repeats
  `|| { echo "$usage" >&2; return 1; }`. There is no way to fail from three frames
  deep without every intermediate frame forwarding the failure explicitly.
- **Control flow hides in operators.** `[ -n "${seen[$name]:-}" ] && continue`,
  `|| true` swallowing exit codes, and `set -e` interacting with `&&` lists mean
  reading a function requires knowing several bash edge cases at once.
- **Quoting is load-bearing and invisible.** Task names and refs are interpolated
  into `su -c "…"` strings. The validation that keeps this safe is correct, but
  nothing in the syntax signals which strings are dangerous.
- **The tests could not test behaviour** until recently: they were `grep`
  assertions over the sources. The functional harness added in PR #14 needs a
  `lxc` stub on `PATH` and borrows a pty from `script(1)` to exercise prompts.

## Goals

1. Replace the CLI implementation with TypeScript that a reader can follow
   without bash expertise — real records, real exceptions, real arrays.
2. Keep the command surface **identical**: same commands, flags, optional
   arguments, interactive menus, and branch-resolution order as shipped in PR #14.
3. Make the interactive and LXD boundaries injectable, so tests stop needing a
   pty and a `PATH` stub for every case.
4. Add no runtime dependency: the host must keep running `./scripts/forge`
   with nothing installed beyond Node.

## Non-goals

- **Rewriting `forge-image.sh`.** It is a sequence of provisioning shell piped
  into a scratch container. In TypeScript that shell becomes template strings of
  the same shell: the risk is real and the readability gain is not.
- **Rewriting `.claude/hooks/pre-bash.sh`.** It is a container-side security
  control, currently auditable as a flat list of regexes. Rewriting it deserves
  its own security review, and it must stay executable independently of the
  container's Node install.
- **Revisiting the command surface.** PR #14 has just stabilised it; changing the
  language and the interface in one diff would make both unreviewable.
- **Adding CI.** The repo has none today; `npm test` and `npm run check` stay
  manual gates.

## Design

### 1. Runtime and language

TypeScript executed directly by Node's native type stripping — `.ts` files run
with no build step, no bundler, and no runtime dependency.

Consequences, all verified against Node 24.20 before writing this spec:

- **Host prerequisite becomes Node 24+.** Verified on Node 24.20: `.ts` files
  importing other `.ts` files run with no flag and no warning. Earlier release
  lines may still need `--experimental-strip-types` depending on the minor
  version, so the prerequisite is pinned at the current LTS rather than at the
  first version that happened to work. The README's Prerequisites section gains
  this entry (Node is currently installed *inside* the image, not on the host).
- **Only erasable syntax is allowed.** `enum`, `namespace`, and constructor
  parameter properties are rejected at parse time. Use `const` objects plus union
  types instead of enums.
- **Imports carry the `.ts` extension** (`import { pick } from "./prompt.ts"`).
- **Node does not type-check.** It erases types without verifying them, so
  TypeScript without `tsc` would be decorative annotations. Type safety comes from
  `npm run check` (`tsc --noEmit`), see §8.

`scripts/forge` stays as a three-line bash shim:

```bash
#!/bin/bash
exec node "$(dirname "${BASH_SOURCE[0]}")/forge.ts" "$@"
```

Stripping keys off the `.ts` extension, so a file named `forge` would not be
processed. The shim keeps the invocation `./scripts/forge` identical everywhere —
README, the `forge` alias, and the completion function all keep working unchanged.

### 2. Module layout

```
scripts/forge                 bash shim (3 lines)
scripts/forge.ts              entry: argv → command, error handling, exit code
scripts/lib/
  context.ts                  the injected seam: types + real implementation
  prompt.ts                   pick() / ask() over node:readline, TTY guard
  validate.ts                 owner/repo, task name, git ref
  table.ts                    dynamic-width column formatting
  lxd.ts                      transport: lxc list / config / exec / image, typed
  containers.ts               domain: container↔repo, mode, image stamp
  worktrees.ts                worktrees, agent/* branches, tmux sessions
  wip.ts                      dirty-tree / unpushed pre-flight
  commands/
    start.ts resume.ts finish.ts stop.ts delete.ts list.ts completion.ts image.ts
scripts/lib/forge-image.sh    unchanged (bash)
```

Three layers: `lxd.ts` knows how to talk to LXD and nothing about forge;
`containers.ts` / `worktrees.ts` / `wip.ts` hold the domain and know nothing about
argv or terminals; `commands/` orchestrates and is the only layer that prompts or
prints.

`commands/image.ts` shells out to `forge-image.sh`, so `forge image build|update`
keeps working through the new dispatcher.

### 3. The injected context

```ts
export type ExecResult = { code: number; stdout: string; stderr: string };

export type Context = {
  exec(argv: string[], opts?: { input?: string }): Promise<ExecResult>;
  attach(argv: string[]): Promise<number>;
  prompt: {
    pick(label: string, items: string[]): Promise<number | null>;
    ask(label: string): Promise<string | null>;
  };
  out(line: string): void;
  err(line: string): void;
};
```

Every command is `(ctx: Context, args: Args) => Promise<number>` returning its
exit code. `context.ts` exports both the type and the real implementation
(`spawn`, `node:readline`, `process.stdout`); tests pass a fake.

`exec` captures output for the caller to parse and never throws on a non-zero
exit — the caller decides whether that is a failure, since several probes
(`show-ref --verify`, `test -e`) use the exit code as their answer. `attach`
inherits the terminal instead of capturing, and resolves with the child's exit
code, which becomes the CLI's own.

`pick` and `ask` return `null` rather than throwing when they cannot ask — stdin
is not a TTY, the list is empty, or the user sent EOF. This preserves today's
contract exactly: **a scripted call never blocks on a prompt nobody will answer**,
it falls back to the caller's usage message and a non-zero exit. The TTY guard
must also not consume a stdin that was not meant for it; the bash test for this
originally passed for the wrong reason (EOF rather than the guard), so the
TypeScript test asserts against a stdin that carries a valid-looking answer.

### 4. `attach` is a separate operation

`attach` exists apart from `exec` because the tmux case must inherit the terminal
rather than capture its output:

```ts
spawn("lxc", ["exec", container, "--user", "1001", …, "--", "tmux", "new-session", …],
      { stdio: "inherit" })
```

Commit `c34a145` established that tmux must remain the **direct** target of
`lxc exec`: with an intermediate `su - aiuser -c "…"` shell, SIGWINCH never reaches
the tmux client on host-terminal resize and it keeps drawing into a stale grid.
Node makes this structurally safer than bash — `spawn` with an argv array inserts
no shell at all. A test asserts the exact argv, including `--user 1001 --group
1001`, `--cwd`, the forwarded `TERM`, and the `exec bash -lc` wrapper that restores
`DOCKER_HOST` below tmux.

### 5. Errors and exit codes

A `ForgeError` thrown at the point of failure and caught once in `forge.ts`,
which writes it to stderr and returns 1. This replaces the
`|| { echo … >&2; return 1; }` chain threaded through every call site.

Exit codes are unchanged: 0 on success, 1 on any error including usage. Nothing
downstream distinguishes further, and changing it could break a caller's script.

### 6. Command surface and behaviour deltas

The surface is unchanged: `start`, `resume`, `finish`, `stop`, `delete`, `list`,
`image`, `completion` (`bash` / `repos` / `tasks`), with the same optional
positionals, the same `--force` flag parsed positionally-independently, and the
same branch-resolution order in `start` (existing worktree → explicit ref → local
`agent/<task>` → `origin/agent/<task>` → new from `origin/main`).

Three deliberate cleanups, and nothing else changes observably:

1. **Menu labels move to English**, joining the rest of the user-facing strings:
   `new task`, `<name> (existing worktree — attach)`, `<name> (local branch)`,
   `<name> (branch on origin)`, `other branch…`, `other repo…`, `Invalid choice.`
   The French labels were introduced in PR #14 and were the only French strings
   users ever see; comments stay French, matching the repo.
2. **Error messages take one consistent shape**, `Error: <message>`, which most
   but not all of them already use.
3. `forge list` keeps the same columns and rendering; the width computation moves
   into `table.ts` and is unit-tested directly.

### 7. Security invariants that must survive the port

`lxc exec … -- su - aiuser -c "<string>"` remains the only way to run a command as
`aiuser` inside a container, so task names and refs are still interpolated into a
shell string. The port does not reduce this exposure and must not weaken it:

- `validate.ts` keeps the exact charsets: task names `^[A-Za-z0-9._-]+$`, refs
  `^[A-Za-z0-9._/-]+$` and no leading `-`, repos `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`.
- The defence-in-depth filter in `worktrees.ts` keeps dropping worktree basenames
  and branch names that fall outside that charset before they reach a further
  `su -c`, rather than erroring — one hostile entry must not abort the listing.
- These validators become directly unit-testable, which is a net gain over the
  current `grep`-based coverage.

### 8. Tooling

- `package.json`: `"type": "module"`, `typescript` as the only devDependency, and
  three scripts — `test:unit` (`node --test tests/*.test.ts`), `test:bash` (runs
  each retained `tests/test-*.sh`, failing on the first non-zero exit), and `test`
  running both. `check` is `tsc --noEmit`. Two runners coexist because the
  retained bash tests cover bash and config files that are staying.
- `tsconfig.json`: `erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`,
  `verbatimModuleSyntax`, `strict`.
- `node_modules/` is added to `.gitignore`.

The install is **development-only**. The host runs the CLI with Node alone; no
`npm install` is ever required there, which keeps the machine that handles the
bot PAT and the SSH signing key free of npm supply-chain surface.

## Files touched

**Added**: `scripts/forge.ts`, `scripts/lib/{context,prompt,validate,table,lxd,containers,worktrees,wip}.ts`, `scripts/lib/commands/*.ts` (8 files), `tests/*.test.ts`, `tests/lib/fake-context.ts`, `tests/lib/fake-lxc.ts`, `package.json`, `tsconfig.json`.

**Rewritten**: `scripts/forge` (becomes the shim), `README.md` (Node 24+ prerequisite, CLI section), `.gitignore`.

**Deleted**: `scripts/lib/forge-{common,completion,delete,finish,list,resume,start,stop}.sh` (~987 lines), `tests/test-forge-{common,completion,delete,dispatcher,finish,list,resume,start,stop}.sh` and `tests/lib/fake-lxc.sh` (~1547 lines).

**Unchanged**: `scripts/lib/forge-image.sh`, `.claude/hooks/pre-bash.sh`, `config/*`, `templates/*`, and the bash tests covering them (`test-pre-bash.sh`, `test-forge-image.sh`, `test-claude-*.sh`, `test-lxd-agent-profile.sh`, `test-readme-docs.sh`).

## Testing

`node --test` over `tests/*.test.ts`, with two harnesses:

- `fake-context.ts` — a `Context` whose `exec` matches argv against an ordered
  rule table returning `{ code, stdout }`, whose `prompt` serves a scripted queue
  of answers (and can be set to "no TTY" so `pick`/`ask` return `null`), and whose
  `out`/`err` accumulate lines for assertion. Commands are called directly.
- `fake-lxc.ts` — a small executable Node stub placed on `PATH` for the
  end-to-end tests that spawn the real `scripts/forge`.

Coverage carried over from the bash suite, expressed as behaviour rather than
`grep`:

- `table.ts`: columns align under their header and the output stays within 80
  columns when a repo name is long.
- `list`: `attached` / `detached` / `no session` are distinguished (the bug where
  `tmux has-session` reported an unopened session as attached), and a stopped
  container yields no task rows.
- `start`: each of the five branch-resolution cases issues the expected
  `git worktree add`, and an existing worktree attaches instead of failing.
- `prompt`: an invalid entry re-asks; with no TTY, `pick` returns `null` **and
  leaves a valid-looking stdin unconsumed**.
- `validate`: the charsets, including a leading `-` rejected in refs.
- `attach`: exact argv, asserted against the invariant in §4.
- End-to-end (3–4 tests): dispatch of an unknown command, `--force` accepted in
  any position, usage on a missing argument with no TTY, and exit codes.

## Delivery

One PR, six reviewable commits, so the repo never carries two live
implementations:

1. Foundation — `context`, `prompt`, `validate`, `table` + tests
2. LXD access and domain — `lxd`, `containers`, `worktrees`, `wip` + tests
3. Simple commands — `list`, `completion`, `stop`, `delete`
4. Worktree commands — `resume`, `finish`, `start`
5. Switch the shim; delete the bash CLI and its tests
6. README — Node 24+ prerequisite, CLI section

## Deferred

- `forge-image.sh` and `pre-bash.sh` stay bash (see Non-goals). If the image
  script is ever revisited, it should be for its own reasons, not for language
  consistency.
- Richer interactive menus (arrow-key selection, type-to-filter) were considered
  and rejected with the zero-dependency decision: they would require
  `@inquirer/prompts` on the host, or a bundling step. Numbered menus stay.
- Distinct exit codes per failure class (usage vs. runtime vs. pre-flight).
