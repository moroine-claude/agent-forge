# Forge CLI in TypeScript — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ~1070-line bash forge CLI with TypeScript run directly by Node's type stripping, keeping the command surface identical.

**Architecture:** Three layers — `lxd.ts` talks to LXD and knows nothing about forge; `containers`/`worktrees`/`wip` hold the domain and know nothing about argv or terminals; `commands/` orchestrates and is the only layer that prompts or prints. Every command receives an injected `Context` (`exec`, `attach`, `prompt`, `out`, `err`), which is what makes the suite testable without a pty or a `PATH` stub.

**Tech Stack:** TypeScript executed by Node 24 native type stripping, zero runtime dependencies (`node:` builtins only), `node:test` as the test runner.

**Spec:** `docs/superpowers/specs/2026-09-01-forge-cli-nodejs-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 24+.** Type stripping must be on by default; no build step, no bundler.
- **Zero runtime dependencies.** Only `node:` builtins may be imported by anything under `scripts/`.
- **Erasable syntax only.** No `enum`, no `namespace`, no constructor parameter properties. Use `const` objects plus union types instead of enums. Non-erasable syntax is a parse error at run time, not a type error.
- **Imports carry the `.ts` extension**: `import { createPrompt } from "./prompt.ts"`.
- **User-facing strings are English. Comments are French**, matching the repo.
- **Error messages print as `Error: <message>`.** The `Error: ` prefix is added once, in `scripts/forge.ts`; a thrown `ForgeError` carries only the message.
- **Exit codes: 0 on success, 1 on any error, including usage errors.** Nothing distinguishes further.
- **`exec` never throws on a non-zero exit code.** Several probes (`show-ref --verify`, `test -e`, `tmux list-sessions`) use the exit code as their answer. Only the caller decides what counts as a failure.
- **Validation charsets, exactly:** task name `^[A-Za-z0-9._-]+$`; git ref `^[A-Za-z0-9._/-]+$` and no leading `-`; repo `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`. These are load-bearing: the values are interpolated into `su -c "…"` strings.
- **Two devDependencies**, `typescript` and `@types/node`. The spec says "typescript as the only devDependency"; `tsc` cannot type `process` or `node:` imports without `@types/node`. Both are development-only and never installed on the host, so the spec's security argument is unaffected.

## Operator probe — run before Task 15

Task 15 builds on `LXD_CONF`, the one mechanism in the spec that could not be verified from the agent container, for lack of any LXD. **Run this on the LXD host and report the output.** It creates one throwaway project and deletes it again.

```bash
# 1. Is an isolated client config dir honoured, and does it leave the real one alone?
lxc project list                       # note the current project, for comparison
mkdir -p /tmp/forge-lxdconf
LXD_CONF=/tmp/forge-lxdconf lxc project list
LXD_CONF=/tmp/forge-lxdconf lxc list
lxc project list                       # must be unchanged

# 2. Does a project created with inherited images see agent-base?
lxc project create forge-probe -c features.images=false -c features.profiles=false
lxc --project forge-probe image list | grep -c agent-base   # expect 1
lxc project delete forge-probe
```

If step 1 shows `LXD_CONF` being honoured and the real config untouched, Task 15 proceeds as written. If it is not honoured, Task 15 switches to its documented fallback: an explicit `--project` option threaded through `lxd.ts`.

## File structure

| File | Responsibility |
|---|---|
| `scripts/forge` | bash shim, 3 lines: `exec node …/forge.ts "$@"` |
| `scripts/forge.ts` | argv → command, catches `ForgeError`, returns the exit code |
| `scripts/lib/context.ts` | `Context` type, `ForgeError`, real implementation (`spawn`, stdout/stderr) |
| `scripts/lib/prompt.ts` | `pick()` / `ask()` over `node:readline`, TTY guard |
| `scripts/lib/validate.ts` | repo / task-name / git-ref charsets |
| `scripts/lib/table.ts` | column widths computed from data |
| `scripts/lib/lxd.ts` | transport: `lxc list/config/info/image/exec/start/stop/delete` |
| `scripts/lib/containers.ts` | domain: container↔repo, mode, image stamp, build status |
| `scripts/lib/worktrees.ts` | worktrees, `agent/*` branches, tmux session states |
| `scripts/lib/wip.ts` | dirty-tree / unpushed pre-flight |
| `scripts/lib/commands/resolve.ts` | resolves missing repo/task arguments via `prompt` |
| `scripts/lib/commands/*.ts` | one file per command: list, completion, stop, delete, resume, finish, start, image |
| `tests/lib/fake-context.ts` | scripted `Context` for unit tests |
| `tests/lib/fake-lxc.ts` | executable `lxc` stub on `PATH` for end-to-end tests |
| `tests/contract/*.test.ts` | real git and real tmux, no LXD |
| `tests/integration/lxd.test.ts` | real LXD, host-only, opt-in |

`commands/resolve.ts` is one file beyond the spec's list of eight command files. It exists so the prompting stays in the commands layer instead of leaking into `containers.ts`/`worktrees.ts`, which the spec requires to know nothing about terminals.

Tasks commit individually, which is finer-grained than the spec's seven review themes; the themes remain the shape of the final PR description.

---

### Task 1: Context, ForgeError, and the fake used by every later test

**Files:**
- Create: `package.json`, `tsconfig.json`, `scripts/lib/context.ts`, `scripts/lib/prompt.ts` (placeholder), `tests/lib/fake-context.ts`, `tests/context.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `type ExecResult = { code: number; stdout: string; stderr: string }`; `type ExecOptions = { input?: string }`; `type Prompt = { pick(label: string, items: string[]): Promise<number | null>; ask(label: string): Promise<string | null> }`; `type Context = { exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>; attach(argv: string[]): Promise<number>; prompt: Prompt; out(line: string): void; err(line: string): void }`; `class ForgeError extends Error`; `function createContext(): Context`; and from the test helper `function fakeContext(opts?: FakeOptions): FakeContext`.
- **Later extension:** Task 13 adds `askSecret(label: string): Promise<string | null>` to `Prompt`, for the bot PAT. Nothing before Task 13 uses it.

- [ ] **Step 1: Create the scaffolding**

`package.json`:

```json
{
  "name": "agent-forge",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "npm run test:unit && npm run test:contract && npm run test:bash",
    "test:unit": "node --test tests/*.test.ts",
    "test:contract": "node --test tests/contract/*.test.ts",
    "test:bash": "for t in tests/test-*.sh; do bash \"$t\" || exit 1; done",
    "test:integration": "node --test tests/integration/*.test.ts",
    "check": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^24.0.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "types": ["node"]
  },
  "include": ["scripts/**/*.ts", "tests/**/*.ts"]
}
```

Append to `.gitignore`:

```
node_modules/
```

- [ ] **Step 2: Write the failing test**

`tests/context.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, ForgeError } from "../scripts/lib/context.ts";

test("exec captures stdout and the exit code", async () => {
  const r = await createContext().exec(["printf", "hello"]);
  assert.equal(r.stdout, "hello");
  assert.equal(r.code, 0);
});

test("exec does not throw on a non-zero exit code", async () => {
  const r = await createContext().exec(["false"]);
  assert.equal(r.code, 1);
});

test("exec reports a missing binary as a non-zero code, not a crash", async () => {
  const r = await createContext().exec(["definitely-not-a-real-binary-xyz"]);
  assert.notEqual(r.code, 0);
});

test("exec passes input on stdin", async () => {
  const r = await createContext().exec(["cat"], { input: "piped" });
  assert.equal(r.stdout, "piped");
});

test("exec passes arguments without a shell in between", async () => {
  const r = await createContext().exec(["printf", "%s", "a b; echo pwned"]);
  assert.equal(r.stdout, "a b; echo pwned");
});

test("ForgeError carries only the message, without an Error: prefix", () => {
  const e = new ForgeError("no container found for x/y");
  assert.equal(e.message, "no container found for x/y");
  assert.ok(e instanceof Error);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/context.test.ts`
Expected: FAIL — cannot find module `../scripts/lib/context.ts`.

- [ ] **Step 4: Write the implementation**

`scripts/lib/context.ts`:

```ts
// Le seam injecté : tout ce que le CLI fait au monde extérieur passe par ici,
// ce qui permet aux tests de le remplacer sans pty ni stub sur le PATH.
import { spawn } from "node:child_process";
import { createPrompt } from "./prompt.ts";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecOptions = { input?: string };

export type Prompt = {
  pick(label: string, items: string[]): Promise<number | null>;
  ask(label: string): Promise<string | null>;
};

export type Context = {
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>;
  attach(argv: string[]): Promise<number>;
  prompt: Prompt;
  out(line: string): void;
  err(line: string): void;
};

// Erreur métier : le message est affiché tel quel par forge.ts, préfixé une
// seule fois par "Error: ".
export class ForgeError extends Error {}

// Ne rejette jamais sur un code non nul : plusieurs sondes (show-ref, test -e,
// tmux list-sessions) se servent du code de sortie comme réponse. Un binaire
// absent est rapporté de la même façon, par un code non nul.
function run(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

// Hérite du terminal au lieu de capturer : c'est le cas tmux. Voir §4 de la
// spec — tmux doit rester la cible directe de `lxc exec`, sinon SIGWINCH
// n'atteint jamais le client au redimensionnement.
function attach(argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 0));
  });
}

export function createContext(): Context {
  return {
    exec: run,
    attach,
    prompt: createPrompt(),
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
  };
}
```

Create a placeholder `scripts/lib/prompt.ts` so the import resolves; Task 2 replaces it:

```ts
import type { Prompt } from "./context.ts";

export function createPrompt(): Prompt {
  return {
    async pick() { return null; },
    async ask() { return null; },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/context.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Write the fake context used by every later task**

`tests/lib/fake-context.ts`:

```ts
// Contexte scripté pour les tests unitaires. `exec` répond selon une table de
// règles ordonnée (première correspondance gagnante, comme un routeur), et
// `prompt` sert une file de réponses préparées.
import type { Context, ExecOptions, ExecResult, Prompt } from "../../scripts/lib/context.ts";

export type ExecRule = { match: string; code?: number; stdout?: string; stderr?: string };

export type FakeOptions = {
  rules?: ExecRule[];
  answers?: (number | string | null)[];
  tty?: boolean;
};

export type FakeContext = Context & {
  calls: string[][];
  out_lines: string[];
  err_lines: string[];
};

export function fakeContext(opts: FakeOptions = {}): FakeContext {
  const rules = opts.rules ?? [];
  const answers = [...(opts.answers ?? [])];
  const tty = opts.tty ?? true;
  const calls: string[][] = [];
  const out_lines: string[] = [];
  const err_lines: string[] = [];

  const exec = async (argv: string[], _opts?: ExecOptions): Promise<ExecResult> => {
    calls.push(argv);
    const joined = argv.join(" ");
    for (const rule of rules) {
      if (joined.includes(rule.match)) {
        return { code: rule.code ?? 0, stdout: rule.stdout ?? "", stderr: rule.stderr ?? "" };
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const prompt: Prompt = {
    async pick(label, items) {
      err_lines.push(`${label}> [${items.join(" | ")}]`);
      if (!tty) return null;
      const a = answers.shift();
      return typeof a === "number" ? a : null;
    },
    async ask(label) {
      err_lines.push(`${label}> `);
      if (!tty) return null;
      const a = answers.shift();
      return typeof a === "string" ? a : null;
    },
  };

  return {
    exec,
    attach: async (argv) => { calls.push(argv); return 0; },
    prompt,
    out: (line) => out_lines.push(line),
    err: (line) => err_lines.push(line),
    calls,
    out_lines,
    err_lines,
  };
}
```

- [ ] **Step 7: Verify types and commit**

```bash
npm install
npm run check
node --test tests/context.test.ts
git add package.json package-lock.json tsconfig.json .gitignore scripts/lib/context.ts scripts/lib/prompt.ts tests/lib/fake-context.ts tests/context.test.ts
git commit -m "feat(cli): socle TypeScript — contexte injecté et ForgeError"
```

---

### Task 2: Prompt — numbered menus and the TTY guard

**Files:**
- Modify: `scripts/lib/prompt.ts` (replaces the Task 1 placeholder)
- Test: `tests/prompt.test.ts`

**Interfaces:**
- Consumes: `type Prompt` from `context.ts`.
- Produces: `function createPrompt(input?: NodeJS.ReadableStream & { isTTY?: boolean }, err?: (s: string) => void): Prompt`. `pick` returns a **1-based index** or `null`; `ask` returns the trimmed string or `null`.

The guard is the point of this module: a scripted call must never block on a prompt nobody will answer, **and must not consume a stdin that was not meant for it**. The bash test for this originally passed for the wrong reason — EOF rather than the guard — so the test below feeds a valid-looking answer and asserts it is left unread.

- [ ] **Step 1: Write the failing test**

`tests/prompt.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createPrompt } from "../scripts/lib/prompt.ts";

function stream(text: string, isTTY: boolean) {
  const s = Readable.from([text]) as Readable & { isTTY?: boolean };
  s.isTTY = isTTY;
  return s;
}
const tty = (t: string) => stream(t, true);
const notTty = (t: string) => stream(t, false);

test("pick returns the 1-based index of a valid choice", async () => {
  const p = createPrompt(tty("2\n"), () => {});
  assert.equal(await p.pick("Repo", ["alpha", "beta", "gamma"]), 2);
});

test("pick re-asks after an invalid entry", async () => {
  const errs: string[] = [];
  const p = createPrompt(tty("9\nzero\n1\n"), (s) => errs.push(s));
  assert.equal(await p.pick("Repo", ["alpha", "beta"]), 1);
  assert.ok(errs.join("").includes("Invalid choice."));
});

test("pick writes the list and the prompt to stderr", async () => {
  const errs: string[] = [];
  const p = createPrompt(tty("1\n"), (s) => errs.push(s));
  await p.pick("Repo", ["alpha", "gamma"]);
  const all = errs.join("");
  assert.ok(all.includes(" 1) alpha"));
  assert.ok(all.includes(" 2) gamma"));
  assert.ok(all.includes("Repo> "));
});

test("pick returns null on an empty list without asking anything", async () => {
  const errs: string[] = [];
  const p = createPrompt(tty("1\n"), (s) => errs.push(s));
  assert.equal(await p.pick("Repo", []), null);
  assert.equal(errs.length, 0);
});

test("pick returns null with no TTY and leaves a valid answer unconsumed", async () => {
  const stdin = notTty("1\n");
  const p = createPrompt(stdin, () => {});
  assert.equal(await p.pick("Repo", ["alpha", "beta"]), null);
  const rest = await new Promise<string>((r) => {
    let buf = "";
    stdin.on("data", (c) => (buf += c));
    stdin.on("end", () => r(buf));
  });
  assert.equal(rest, "1\n");
});

test("ask returns the typed value, and null on an empty line", async () => {
  assert.equal(await createPrompt(tty("my-task\n"), () => {}).ask("New task name"), "my-task");
  assert.equal(await createPrompt(tty("\n"), () => {}).ask("New task name"), null);
});

test("ask returns null with no TTY", async () => {
  assert.equal(await createPrompt(notTty("x\n"), () => {}).ask("Ref"), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/prompt.test.ts`
Expected: FAIL — `pick` returns `null` everywhere (the Task 1 placeholder).

- [ ] **Step 3: Write the implementation**

`scripts/lib/prompt.ts`:

```ts
// Menus numérotés sur node:readline. Contrat : la liste et l'invite vont sur
// stderr, la réponse est rendue à l'appelant, et rien n'est demandé quand on
// ne peut pas demander.
import { createInterface } from "node:readline";
import type { Prompt } from "./context.ts";

type MaybeTTY = NodeJS.ReadableStream & { isTTY?: boolean };

export function createPrompt(
  input: MaybeTTY = process.stdin,
  err: (s: string) => void = (s) => { process.stderr.write(s); },
): Prompt {
  // Une interface par question, fermée aussitôt : on ne retient pas stdin
  // entre deux invites.
  async function readLine(): Promise<string | null> {
    const rl = createInterface({ input, terminal: false });
    try {
      for await (const line of rl) return line;
      return null;
    } finally {
      rl.close();
    }
  }

  return {
    async pick(label, items) {
      // Rien à choisir, ou personne pour répondre : on ne touche pas à stdin.
      // Le lire ici consommerait une entrée destinée à quelqu'un d'autre.
      if (items.length === 0) return null;
      if (!input.isTTY) return null;

      for (;;) {
        items.forEach((item, i) => err(`${String(i + 1).padStart(2)}) ${item}\n`));
        err(`${label}> `);
        const answer = await readLine();
        if (answer === null) return null;
        const n = Number(answer.trim());
        if (Number.isInteger(n) && n >= 1 && n <= items.length) return n;
        err("Invalid choice.\n");
      }
    },

    async ask(label) {
      if (!input.isTTY) return null;
      err(`${label}> `);
      const answer = await readLine();
      if (answer === null) return null;
      const value = answer.trim();
      return value === "" ? null : value;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/prompt.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Prove the TTY guard is what makes the test pass**

Temporarily delete the line `if (!input.isTTY) return null;` from `pick`, re-run, and confirm the "leaves a valid answer unconsumed" test now **fails**. Restore the line and confirm the suite is green again. This is the mutation check the bash suite lacked.

- [ ] **Step 6: Commit**

```bash
npm run check
git add scripts/lib/prompt.ts tests/prompt.test.ts
git commit -m "feat(cli): menus numérotés et garde TTY"
```

---

### Task 3: Validation charsets

**Files:**
- Create: `scripts/lib/validate.ts`, `tests/validate.test.ts`

**Interfaces:**
- Consumes: `ForgeError` from `context.ts`.
- Produces: `function validateRepo(ownerRepo: string): void`, `function validateTaskName(name: string): void`, `function validateGitRef(ref: string): void`, `function sanitizeContainerName(ownerRepo: string): string`. Each validator throws `ForgeError` and returns nothing on success.

These are load-bearing, not cosmetic: the values reach a `su -c "…"` string inside the container. Moving to TypeScript does not reduce that exposure.

- [ ] **Step 1: Write the failing test**

`tests/validate.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ForgeError } from "../scripts/lib/context.ts";
import { validateRepo, validateTaskName, validateGitRef, sanitizeContainerName } from "../scripts/lib/validate.ts";

test("validateRepo accepts owner/repo and rejects anything else", () => {
  validateRepo("moroine/agent-forge");
  validateRepo("my.org/my_repo-2");
  for (const bad of ["noslash", "a/b/c", "a b/c", "owner/", "/repo", "a;id/b"]) {
    assert.throws(() => validateRepo(bad), ForgeError, `should reject: ${bad}`);
  }
});

test("validateTaskName allows [A-Za-z0-9._-] only", () => {
  validateTaskName("cli");
  validateTaskName("terminal-resize.fix_2");
  for (const bad of ["with space", "a/b", "semi;colon", "$(whoami)", "tick`x`", ""]) {
    assert.throws(() => validateTaskName(bad), ForgeError, `should reject: ${bad}`);
  }
});

test("validateGitRef allows slashes but refuses a leading dash", () => {
  validateGitRef("origin/feature/thing");
  validateGitRef("v1.2.3");
  for (const bad of ["--upload-pack=evil", "-x", "a b", "a;b", "$(id)"]) {
    assert.throws(() => validateGitRef(bad), ForgeError, `should reject: ${bad}`);
  }
});

test("the error message names the offending value", () => {
  assert.throws(() => validateTaskName("bad name"), /bad name/);
});

test("sanitizeContainerName lowercases and collapses non-charset runs", () => {
  assert.equal(sanitizeContainerName("moroine/agent-forge"), "agent-moroine-agent-forge");
  assert.equal(sanitizeContainerName("Moroine/Agent-Forge"), "agent-moroine-agent-forge");
  assert.equal(sanitizeContainerName("my.org/my.repo"), "agent-my-org-my-repo");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/validate.test.ts`
Expected: FAIL — cannot find module `../scripts/lib/validate.ts`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/validate.ts`:

```ts
// Ces jeux de caractères sont une frontière de sécurité, pas une politesse :
// les valeurs sont interpolées dans une chaîne `su -c "…"` exécutée dans le
// container. Voir §7 de la spec.
import { ForgeError } from "./context.ts";

const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const TASK = /^[A-Za-z0-9._-]+$/;
const REF = /^[A-Za-z0-9._/-]+$/;

export function validateRepo(ownerRepo: string): void {
  if (!REPO.test(ownerRepo)) {
    throw new ForgeError(`repo must be <owner>/<repo>, got: ${ownerRepo}`);
  }
}

export function validateTaskName(name: string): void {
  if (!TASK.test(name)) {
    throw new ForgeError(`task-name must only contain [A-Za-z0-9._-], got: ${name}`);
  }
}

// Le tiret initial est exclu à part : une ref commençant par "-" serait prise
// par git pour une option.
export function validateGitRef(ref: string): void {
  if (!REF.test(ref) || ref.startsWith("-")) {
    throw new ForgeError(`ref must only contain [A-Za-z0-9._/-] and must not start with '-', got: ${ref}`);
  }
}

// Nom de container déterministe : minuscules, puis toute suite de caractères
// hors [a-z0-9-] réduite à un seul "-".
export function sanitizeContainerName(ownerRepo: string): string {
  return `agent-${ownerRepo.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/validate.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
npm run check
git add scripts/lib/validate.ts tests/validate.test.ts
git commit -m "feat(cli): validation des repos, noms de tâche et refs"
```

---

### Task 4: Table — column widths computed from the data

**Files:**
- Create: `scripts/lib/table.ts`, `tests/table.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function columnWidths(rows: string[][]): number[]`, `function formatRow(cells: string[], widths: number[], indent?: string): string`.

The bug being fixed: widths were frozen (`%-28s %-26s`), so one long repo name shifted every column after it and pushed the line past 100 characters. The last column is never padded, so no line carries trailing whitespace.

- [ ] **Step 1: Write the failing test**

`tests/table.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { columnWidths, formatRow } from "../scripts/lib/table.ts";

test("columnWidths takes the longest cell of each column", () => {
  assert.deepEqual(columnWidths([["a", "bbb"], ["cccc", "d"]]), [4, 3]);
});

test("formatRow pads every column but the last", () => {
  assert.equal(formatRow(["REPO", "MODE"], [8, 4]), "REPO      MODE");
});

test("formatRow leaves no trailing whitespace", () => {
  const line = formatRow(["a", "b"], [10, 8]);
  assert.equal(line, "a           b");
  assert.ok(!line.endsWith(" "));
});

test("formatRow applies an indent for nested rows", () => {
  assert.equal(formatRow(["cli", "attached"], [5, 8], "  "), "  cli    attached");
});

test("a long value widens its own column instead of shifting the others", () => {
  const rows = [
    ["REPO", "MODE", "STATE", "BUILD"],
    ["moroine/agent-forge", "autonomous", "Running", "behind"],
    ["acme/super-long-repository-name", "supervised", "Stopped", "ok"],
  ];
  const w = columnWidths(rows);
  const lines = rows.map((r) => formatRow(r, w));
  // Chaque colonne commence à la même position sur toutes les lignes.
  for (const col of [1, 2, 3]) {
    const offset = w.slice(0, col).reduce((a, b) => a + b + 2, 0);
    for (const line of lines) {
      assert.notEqual(line[offset], " ", `colonne ${col} désalignée: ${line}`);
    }
  }
});

test("the widest realistic row stays within 80 columns", () => {
  const rows = [
    ["REPO", "MODE", "STATE", "BUILD"],
    ["acme/super-long-repository-name", "supervised", "Stopped", "behind"],
  ];
  const w = columnWidths(rows);
  for (const r of rows) assert.ok(formatRow(r, w).length <= 80);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/table.test.ts`
Expected: FAIL — cannot find module `../scripts/lib/table.ts`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/table.ts`:

```ts
// Largeurs calculées sur les données, jamais figées : un nom long élargit sa
// propre colonne au lieu de décaler toutes les suivantes.
const GAP = "  ";

export function columnWidths(rows: string[][]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return widths;
}

// La dernière colonne n'est pas complétée : cela laisserait des espaces en fin
// de ligne, invisibles et pénibles à comparer dans les tests.
export function formatRow(cells: string[], widths: number[], indent = ""): string {
  const padded = cells.map((cell, i) =>
    i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? cell.length),
  );
  return indent + padded.join(GAP);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/table.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
npm run check
git add scripts/lib/table.ts tests/table.test.ts
git commit -m "feat(cli): formatage de colonnes à largeurs dynamiques"
```

---

### Task 5: LXD transport

**Files:**
- Create: `scripts/lib/lxd.ts`, `tests/lxd.test.ts`

**Interfaces:**
- Consumes: `Context`, `ExecResult` from `context.ts`.
- Produces: `type Instance = { name: string; status: string }`; `listInstances(ctx): Promise<Instance[]>`; `instanceStatus(ctx, name): Promise<string | null>`; `instanceExists(ctx, name): Promise<boolean>`; `configGet(ctx, name, key): Promise<string>`; `configSet(ctx, name, key, value): Promise<void>`; `imageProperty(ctx, alias, key): Promise<string>`; `execAsAgent(ctx, name, script): Promise<ExecResult>`; `startInstance(ctx, name): Promise<void>`; `stopInstance(ctx, name): Promise<void>`; `deleteInstance(ctx, name): Promise<void>`; `attachArgv(container, task, term): string[]`.

This layer knows LXD and nothing about forge. Two things it buys us: `lxc list -f json` is parsed with `JSON.parse` instead of shelling out to `jq`, which removes `jq` from the CLI's host requirements entirely; and `execAsAgent` passes the script as **one argv element** with no outer shell, which is strictly safer than the bash original.

- [ ] **Step 1: Write the failing test**

`tests/lxd.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import {
  listInstances, instanceStatus, instanceExists, configGet, configSet,
  imageProperty, execAsAgent, deleteInstance, attachArgv,
} from "../scripts/lib/lxd.ts";

const LIST_JSON = JSON.stringify([
  { name: "agent-moroine-agent-forge", status: "Running" },
  { name: "agent-acme-widgets", status: "Stopped" },
]);

test("listInstances parses lxc list -f json without jq", async () => {
  const ctx = fakeContext({ rules: [{ match: "lxc list", stdout: LIST_JSON }] });
  assert.deepEqual(await listInstances(ctx), [
    { name: "agent-moroine-agent-forge", status: "Running" },
    { name: "agent-acme-widgets", status: "Stopped" },
  ]);
  assert.ok(!ctx.calls.some((c) => c.includes("jq")), "must not shell out to jq");
});

test("listInstances treats unparseable output as no instances", async () => {
  const ctx = fakeContext({ rules: [{ match: "lxc list", stdout: "not json" }] });
  assert.deepEqual(await listInstances(ctx), []);
});

test("instanceStatus returns the status, or null when absent", async () => {
  const ctx = fakeContext({ rules: [{ match: "lxc list", stdout: LIST_JSON }] });
  assert.equal(await instanceStatus(ctx, "agent-acme-widgets"), "Stopped");
  const empty = fakeContext({ rules: [{ match: "lxc list", stdout: "[]" }] });
  assert.equal(await instanceStatus(empty, "nope"), null);
});

test("instanceExists maps lxc info's exit code to a boolean", async () => {
  const yes = fakeContext({ rules: [{ match: "lxc info", code: 0 }] });
  const no = fakeContext({ rules: [{ match: "lxc info", code: 1 }] });
  assert.equal(await instanceExists(yes, "c"), true);
  assert.equal(await instanceExists(no, "c"), false);
});

test("configGet trims and returns empty for an unset key", async () => {
  const set = fakeContext({ rules: [{ match: "config get", stdout: "moroine/agent-forge\n" }] });
  assert.equal(await configGet(set, "c", "user.forge.repo"), "moroine/agent-forge");
  const unset = fakeContext({ rules: [{ match: "config get", stdout: "\n" }] });
  assert.equal(await configGet(unset, "c", "user.forge.repo"), "");
});

test("configSet issues the expected argv", async () => {
  const ctx = fakeContext();
  await configSet(ctx, "agent-x", "user.forge.mode", "autonomous");
  assert.deepEqual(ctx.calls[0], ["lxc", "config", "set", "agent-x", "user.forge.mode", "autonomous"]);
});

test("imageProperty returns empty when the image is unstamped", async () => {
  const ctx = fakeContext({ rules: [{ match: "image get-property", code: 1, stdout: "" }] });
  assert.equal(await imageProperty(ctx, "agent-base", "user.forge.commit"), "");
});

test("execAsAgent passes the script as one argv element, with no outer shell", async () => {
  const ctx = fakeContext();
  await execAsAgent(ctx, "agent-x", "git -C /workspace status --porcelain");
  assert.deepEqual(ctx.calls[0], [
    "lxc", "exec", "agent-x", "--",
    "su", "-", "aiuser", "-c", "git -C /workspace status --porcelain",
  ]);
});

test("deleteInstance always forces, since the caller has already decided", async () => {
  const ctx = fakeContext();
  await deleteInstance(ctx, "agent-x");
  assert.deepEqual(ctx.calls[0], ["lxc", "delete", "agent-x", "--force"]);
});

test("attachArgv keeps tmux the direct target of lxc exec", () => {
  const argv = attachArgv("agent-x", "cli", "xterm-256color");
  assert.deepEqual(argv, [
    "lxc", "exec", "agent-x",
    "--user", "1001", "--group", "1001",
    "--cwd", "/workspace/.trees/cli",
    "--env", "TERM=xterm-256color",
    "--", "tmux", "new-session", "-A", "-s", "cli",
    "exec bash -lc 'claude --permission-mode auto --remote-control agent-x-cli'",
  ]);
  // Invariant du commit c34a145 : aucun `su` entre lxc exec et tmux, sinon
  // SIGWINCH n'atteint jamais le client tmux au redimensionnement.
  assert.ok(!argv.includes("su"));
  assert.equal(argv[argv.indexOf("--", 3) + 1], "tmux");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/lxd.test.ts`
Expected: FAIL — cannot find module `../scripts/lib/lxd.ts`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/lxd.ts`:

```ts
// Couche transport : parle à LXD, ne sait rien de forge. Tout ce qui est
// spécifique au domaine vit dans containers.ts / worktrees.ts.
import type { Context, ExecResult } from "./context.ts";

export type Instance = { name: string; status: string };

// `lxc list -f json` est analysé par JSON.parse : le CLI n'a plus besoin de jq
// sur l'hôte.
export async function listInstances(ctx: Context): Promise<Instance[]> {
  const r = await ctx.exec(["lxc", "list", "-f", "json"]);
  if (r.code !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((i): i is Instance =>
        typeof i === "object" && i !== null &&
        typeof (i as Instance).name === "string" &&
        typeof (i as Instance).status === "string")
      .map((i) => ({ name: i.name, status: i.status }));
  } catch {
    return [];
  }
}

export async function instanceStatus(ctx: Context, name: string): Promise<string | null> {
  const found = (await listInstances(ctx)).find((i) => i.name === name);
  return found ? found.status : null;
}

export async function instanceExists(ctx: Context, name: string): Promise<boolean> {
  return (await ctx.exec(["lxc", "info", name])).code === 0;
}

export async function configGet(ctx: Context, name: string, key: string): Promise<string> {
  const r = await ctx.exec(["lxc", "config", "get", name, key]);
  return r.code === 0 ? r.stdout.trim() : "";
}

export async function configSet(ctx: Context, name: string, key: string, value: string): Promise<void> {
  await ctx.exec(["lxc", "config", "set", name, key, value]);
}

export async function imageProperty(ctx: Context, alias: string, key: string): Promise<string> {
  const r = await ctx.exec(["lxc", "image", "get-property", alias, key]);
  return r.code === 0 ? r.stdout.trim() : "";
}

// Le script est un seul élément d'argv : aucun shell hôte ne le réinterprète
// avant `su`. C'est plus sûr que l'original bash, mais la validation des noms
// interpolés dedans reste indispensable (validate.ts).
export function execAsAgent(ctx: Context, name: string, script: string): Promise<ExecResult> {
  return ctx.exec(["lxc", "exec", name, "--", "su", "-", "aiuser", "-c", script]);
}

export async function startInstance(ctx: Context, name: string): Promise<void> {
  await ctx.exec(["lxc", "start", name]);
}

export async function stopInstance(ctx: Context, name: string): Promise<void> {
  await ctx.exec(["lxc", "stop", name]);
}

export async function deleteInstance(ctx: Context, name: string): Promise<void> {
  await ctx.exec(["lxc", "delete", name, "--force"]);
}

// tmux DOIT rester la cible directe de `lxc exec` : avec un `su - aiuser -c`
// intermédiaire, SIGWINCH n'atteint jamais le client tmux quand le terminal
// hôte est redimensionné (diagnostiqué le 2026-08-31, commit c34a145).
// --user/--group/--cwd remplacent `su - aiuser` + `cd`. HOME vient du profil
// LXD, mais pas TERM : plus aucun shell de login ne le pose, on le transmet.
// `exec bash -lc` sous tmux restaure DOCKER_HOST, exporté depuis .bashrc.
export function attachArgv(container: string, task: string, term: string): string[] {
  return [
    "lxc", "exec", container,
    "--user", "1001", "--group", "1001",
    "--cwd", `/workspace/.trees/${task}`,
    "--env", `TERM=${term}`,
    "--", "tmux", "new-session", "-A", "-s", task,
    `exec bash -lc 'claude --permission-mode auto --remote-control ${container}-${task}'`,
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/lxd.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
npm run check
git add scripts/lib/lxd.ts tests/lxd.test.ts
git commit -m "feat(cli): couche transport LXD, sans dépendance à jq"
```

---

### Task 6: Container domain

**Files:**
- Create: `scripts/lib/containers.ts`, `tests/containers.test.ts`

**Interfaces:**
- Consumes: `Context`, `ForgeError` from `context.ts`; `sanitizeContainerName` from `validate.ts`; `listInstances`, `instanceStatus`, `instanceExists`, `configGet`, `imageProperty` from `lxd.ts`.
- Produces: `listForgeContainers(ctx): Promise<string[]>`; `containerRepo(ctx, name): Promise<string>`; `containerMode(ctx, name): Promise<string>`; `forgeRepos(ctx): Promise<string[]>`; `containerForRepo(ctx, ownerRepo): Promise<string | null>`; `requireContainerForRepo(ctx, ownerRepo): Promise<string>`; `checkNameCollision(ctx, container, ownerRepo): Promise<void>`; `isRunning(ctx, name): Promise<boolean>`; `currentImageCommit(ctx): Promise<string>`; `containerImageCommit(ctx, name): Promise<string>`; `type BuildStatus = "unknown" | "up-to-date" | "behind"`; `buildStatus(containerCommit, latest): BuildStatus`.

`BuildStatus` is a union type, not an `enum` — enums are non-erasable and would fail to parse at run time.

- [ ] **Step 1: Write the failing test**

`tests/containers.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { ForgeError } from "../scripts/lib/context.ts";
import {
  listForgeContainers, forgeRepos, containerForRepo, requireContainerForRepo,
  checkNameCollision, isRunning, buildStatus,
} from "../scripts/lib/containers.ts";

const LIST = JSON.stringify([
  { name: "agent-moroine-agent-forge", status: "Running" },
  { name: "agent-acme-widgets", status: "Stopped" },
  { name: "unrelated-container", status: "Running" },
]);

function ctxWith(repos: Record<string, string>) {
  return fakeContext({
    rules: [
      { match: "lxc list", stdout: LIST },
      ...Object.entries(repos).map(([name, repo]) => ({
        match: `config get ${name} user.forge.repo`,
        stdout: repo,
      })),
    ],
  });
}

test("listForgeContainers keeps only agent-* names", async () => {
  const ctx = fakeContext({ rules: [{ match: "lxc list", stdout: LIST }] });
  assert.deepEqual(await listForgeContainers(ctx), [
    "agent-moroine-agent-forge",
    "agent-acme-widgets",
  ]);
});

test("forgeRepos reads config keys only, never lxc exec", async () => {
  const ctx = ctxWith({
    "agent-moroine-agent-forge": "moroine/agent-forge",
    "agent-acme-widgets": "acme/widgets",
  });
  assert.deepEqual(await forgeRepos(ctx), ["moroine/agent-forge", "acme/widgets"]);
  assert.ok(!ctx.calls.some((c) => c[1] === "exec"), "un TAB doit rester rapide");
});

test("forgeRepos skips a container with no repo metadata", async () => {
  const ctx = ctxWith({ "agent-moroine-agent-forge": "moroine/agent-forge" });
  assert.deepEqual(await forgeRepos(ctx), ["moroine/agent-forge"]);
});

test("containerForRepo matches case-insensitively", async () => {
  const ctx = ctxWith({ "agent-moroine-agent-forge": "moroine/agent-forge" });
  assert.equal(await containerForRepo(ctx, "Moroine/Agent-Forge"), "agent-moroine-agent-forge");
});

test("requireContainerForRepo throws a ForgeError naming the repo", async () => {
  const ctx = ctxWith({});
  await assert.rejects(() => requireContainerForRepo(ctx, "nobody/nothing"), ForgeError);
  await assert.rejects(() => requireContainerForRepo(ctx, "nobody/nothing"), /nobody\/nothing/);
});

test("checkNameCollision refuses a container with no forge metadata", async () => {
  const ctx = fakeContext({
    rules: [{ match: "lxc info", code: 0 }, { match: "config get", stdout: "" }],
  });
  await assert.rejects(() => checkNameCollision(ctx, "agent-x", "o/r"), /no user.forge.repo metadata/);
});

test("checkNameCollision refuses a container belonging to another repo", async () => {
  const ctx = fakeContext({
    rules: [{ match: "lxc info", code: 0 }, { match: "config get", stdout: "other/repo" }],
  });
  await assert.rejects(() => checkNameCollision(ctx, "agent-x", "o/r"), /different repo/);
});

test("checkNameCollision accepts a not-yet-existing container", async () => {
  const ctx = fakeContext({ rules: [{ match: "lxc info", code: 1 }] });
  await checkNameCollision(ctx, "agent-x", "o/r");
});

test("isRunning is true only for Running", async () => {
  const ctx = fakeContext({ rules: [{ match: "lxc list", stdout: LIST }] });
  assert.equal(await isRunning(ctx, "agent-moroine-agent-forge"), true);
  assert.equal(await isRunning(ctx, "agent-acme-widgets"), false);
  assert.equal(await isRunning(ctx, "absent"), false);
});

test("buildStatus compares the two stamps", () => {
  assert.equal(buildStatus("aaa", "aaa"), "up-to-date");
  assert.equal(buildStatus("aaa", "bbb"), "behind");
  assert.equal(buildStatus("", "bbb"), "unknown");
  assert.equal(buildStatus("aaa", ""), "unknown");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/containers.test.ts`
Expected: FAIL — cannot find module `../scripts/lib/containers.ts`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/containers.ts`:

```ts
// Domaine : la correspondance container ↔ repo, le mode, et le tampon d'image.
// Ne sait rien d'argv ni des terminaux.
import type { Context } from "./context.ts";
import { ForgeError } from "./context.ts";
import { configGet, imageProperty, instanceExists, instanceStatus, listInstances } from "./lxd.ts";

export type BuildStatus = "unknown" | "up-to-date" | "behind";

export async function listForgeContainers(ctx: Context): Promise<string[]> {
  return (await listInstances(ctx))
    .map((i) => i.name)
    .filter((n) => n.startsWith("agent-"));
}

export function containerRepo(ctx: Context, name: string): Promise<string> {
  return configGet(ctx, name, "user.forge.repo");
}

export function containerMode(ctx: Context, name: string): Promise<string> {
  return configGet(ctx, name, "user.forge.mode");
}

// Ne lit que des clés de config : aucun `lxc exec`, pour rester assez rapide
// à alimenter une complétion sous TAB ou un menu interactif.
export async function forgeRepos(ctx: Context): Promise<string[]> {
  const repos: string[] = [];
  for (const name of await listForgeContainers(ctx)) {
    const repo = await containerRepo(ctx, name);
    if (repo) repos.push(repo);
  }
  return repos;
}

export async function containerForRepo(ctx: Context, ownerRepo: string): Promise<string | null> {
  const wanted = ownerRepo.toLowerCase();
  for (const name of await listForgeContainers(ctx)) {
    const repo = await containerRepo(ctx, name);
    if (repo.toLowerCase() === wanted) return name;
  }
  return null;
}

export async function requireContainerForRepo(ctx: Context, ownerRepo: string): Promise<string> {
  const container = await containerForRepo(ctx, ownerRepo);
  if (!container) {
    throw new ForgeError(`no container found for ${ownerRepo}. Run 'forge start ${ownerRepo}' first.`);
  }
  return container;
}

// Échoue bruyamment si un container existe déjà sous le nom dérivé mais pour
// un *autre* repo, ou sans métadonnée forge du tout (container hérité, ou
// laissé par un provisioning interrompu avant l'enregistrement) — plutôt que
// de le réutiliser silencieusement.
export async function checkNameCollision(ctx: Context, container: string, ownerRepo: string): Promise<void> {
  if (!(await instanceExists(ctx, container))) return;
  const existing = await containerRepo(ctx, container);
  if (!existing) {
    throw new ForgeError(
      `container ${container} already exists but has no user.forge.repo metadata (a legacy or partially-provisioned container). ` +
      `Refusing to reuse it — delete it first, or set the metadata manually: lxc config set ${container} user.forge.repo ${ownerRepo}`,
    );
  }
  if (existing.toLowerCase() !== ownerRepo.toLowerCase()) {
    throw new ForgeError(
      `container ${container} already exists for a different repo (${existing}), refusing to reuse it for ${ownerRepo}.`,
    );
  }
}

export async function isRunning(ctx: Context, name: string): Promise<boolean> {
  return (await instanceStatus(ctx, name)) === "Running";
}

export function currentImageCommit(ctx: Context): Promise<string> {
  return imageProperty(ctx, "agent-base", "user.forge.commit");
}

export function containerImageCommit(ctx: Context, name: string): Promise<string> {
  return configGet(ctx, name, "user.forge.image_commit");
}

export function buildStatus(containerCommit: string, latest: string): BuildStatus {
  if (!containerCommit || !latest) return "unknown";
  return containerCommit === latest ? "up-to-date" : "behind";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/containers.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
npm run check
git add scripts/lib/containers.ts tests/containers.test.ts
git commit -m "feat(cli): domaine container — découverte, mode, tampon d'image"
```

---

### Task 7: Worktrees, branches, tmux sessions — plus the real git/tmux contract tests

**Files:**
- Create: `scripts/lib/worktrees.ts`, `tests/worktrees.test.ts`, `tests/contract/git.test.ts`, `tests/contract/tmux.test.ts`

**Interfaces:**
- Consumes: `Context` from `context.ts`; `execAsAgent` from `lxd.ts`.
- Produces: pure parsers `parseWorktreeDirs(porcelain: string): string[]`, `parseAgentBranches(refs: string): string[]`, `parseSessionStates(output: string): Map<string, boolean>`; path helpers `worktreeRelPath(task): string`, `worktreeAbsPath(task): string`; and the container-facing `worktreeDirs(ctx, container)`, `taskNames(ctx, container)`, `agentBranches(ctx, container, refspace)`, `branchExists(ctx, container, ref)`, `sessionStates(ctx, container)`.

**The parsers are exported separately on purpose.** They are what the Layer 2 contract tests feed with output from a *real* git and a *real* tmux, with no LXD involved. That is where the parsing bugs live, so that is what gets pinned to reality.

- [ ] **Step 1: Write the failing unit test**

`tests/worktrees.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import {
  parseWorktreeDirs, parseAgentBranches, parseSessionStates,
  taskNames, branchExists, sessionStates, worktreeAbsPath,
} from "../scripts/lib/worktrees.ts";

test("parseWorktreeDirs drops the main clone and keeps the features", () => {
  const porcelain = [
    "worktree /workspace",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /workspace/.trees/cli",
    "HEAD def",
    "branch refs/heads/agent/cli",
    "",
  ].join("\n");
  assert.deepEqual(parseWorktreeDirs(porcelain), ["/workspace/.trees/cli"]);
});

test("parseWorktreeDirs drops a basename outside the charset, without failing", () => {
  const porcelain = [
    "worktree /workspace/.trees/ok",
    "worktree /workspace/.trees/bad;name",
    "worktree /workspace/.trees/also-ok",
  ].join("\n");
  // Défense en profondeur : ces basenames repartent dans un `su -c`. Une
  // entrée hostile est filtrée, elle n'interrompt pas le reste.
  assert.deepEqual(parseWorktreeDirs(porcelain), [
    "/workspace/.trees/ok",
    "/workspace/.trees/also-ok",
  ]);
});

test("parseAgentBranches strips both agent/ and origin/agent/", () => {
  assert.deepEqual(parseAgentBranches("agent/cli\nagent/docs\n"), ["cli", "docs"]);
  assert.deepEqual(parseAgentBranches("origin/agent/api\n"), ["api"]);
});

test("parseSessionStates maps the attached flag", () => {
  const m = parseSessionStates("cli 1\ndocs 0\n");
  assert.equal(m.get("cli"), true);
  assert.equal(m.get("docs"), false);
  assert.equal(m.has("api"), false);
});

test("parseSessionStates returns an empty map when no server is running", () => {
  assert.equal(parseSessionStates("").size, 0);
  assert.equal(parseSessionStates("no server running on /tmp/tmux-1001/default").size, 0);
});

test("taskNames returns the basenames of the feature worktrees", async () => {
  const ctx = fakeContext({
    rules: [{ match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\n" }],
  });
  assert.deepEqual(await taskNames(ctx, "agent-x"), ["cli"]);
});

test("branchExists uses show-ref's exit code as the answer", async () => {
  const yes = fakeContext({ rules: [{ match: "show-ref", code: 0 }] });
  const no = fakeContext({ rules: [{ match: "show-ref", code: 1 }] });
  assert.equal(await branchExists(yes, "agent-x", "refs/heads/agent/cli"), true);
  assert.equal(await branchExists(no, "agent-x", "refs/heads/agent/cli"), false);
});

test("sessionStates survives tmux exiting non-zero", async () => {
  const ctx = fakeContext({
    rules: [{ match: "list-sessions", code: 1, stderr: "no server running" }],
  });
  assert.equal((await sessionStates(ctx, "agent-x")).size, 0);
});

test("worktreeAbsPath is the session's cwd", () => {
  assert.equal(worktreeAbsPath("cli"), "/workspace/.trees/cli");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/worktrees.test.ts`
Expected: FAIL — cannot find module `../scripts/lib/worktrees.ts`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/worktrees.ts`:

```ts
// Worktrees, branches agent/*, et sessions tmux d'un container.
//
// Les fonctions parse* sont pures et exportées à part : ce sont elles que les
// tests de contrat (couche 2) alimentent avec la sortie d'un *vrai* git et
// d'un *vrai* tmux, sans LXD.
import type { Context } from "./context.ts";
import { execAsAgent } from "./lxd.ts";

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export function worktreeRelPath(task: string): string { return `.trees/${task}`; }
export function worktreeAbsPath(task: string): string { return `/workspace/.trees/${task}`; }

// `git worktree list --porcelain` sort des strophes séparées par une ligne
// vide ; seule la ligne "worktree <path>" nous intéresse. Le clone principal
// (/workspace) est exclu.
//
// Défense en profondeur : on écarte aussi tout basename hors du charset imposé
// aux noms de branche, avant qu'il ne reparte dans un `su -c`. Un worktree ne
// peut être créé que via validate.ts, donc cela ne devrait jamais se
// déclencher — c'est un filtre, pas une erreur fatale, pour qu'une entrée
// hostile n'interrompe pas le reste.
export function parseWorktreeDirs(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim())
    .filter((dir) => dir !== "/workspace")
    .filter((dir) => SAFE_NAME.test(dir.split("/").pop() ?? ""));
}

// `for-each-ref --format='%(refname:short)'` rend déjà `agent/cli` (et
// `origin/agent/api`), pas `refs/heads/agent/cli` : on ne retire donc que le
// préfixe court. Vérifié contre un vrai git dans tests/contract/git.test.ts.
export function parseAgentBranches(refs: string): string[] {
  return refs
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^(origin\/)?agent\//, ""))
    .filter((name) => SAFE_NAME.test(name));
}

// `tmux has-session` ne disait que « la session existe », donc une session que
// personne n'a ouverte était rapportée attachée. #{session_attached} distingue
// vraiment les deux. Sans serveur, tmux sort en 1 avec un message sur stderr :
// stdout est vide, la map l'est aussi.
export function parseSessionStates(output: string): Map<string, boolean> {
  const states = new Map<string, boolean>();
  for (const line of output.split("\n")) {
    const [name, flag] = line.trim().split(/\s+/);
    if (name && (flag === "0" || flag === "1")) states.set(name, flag === "1");
  }
  return states;
}

export async function worktreeDirs(ctx: Context, container: string): Promise<string[]> {
  const r = await execAsAgent(ctx, container, "cd /workspace && git worktree list --porcelain");
  return r.code === 0 ? parseWorktreeDirs(r.stdout) : [];
}

export async function taskNames(ctx: Context, container: string): Promise<string[]> {
  return (await worktreeDirs(ctx, container)).map((d) => d.split("/").pop() as string);
}

export async function agentBranches(ctx: Context, container: string, refspace: string): Promise<string[]> {
  const r = await execAsAgent(
    ctx, container,
    `git -C /workspace for-each-ref --format='%(refname:short)' ${refspace}`,
  );
  return r.code === 0 ? parseAgentBranches(r.stdout) : [];
}

export async function branchExists(ctx: Context, container: string, ref: string): Promise<boolean> {
  const r = await execAsAgent(ctx, container, `git -C /workspace show-ref --verify --quiet ${ref}`);
  return r.code === 0;
}

export async function sessionStates(ctx: Context, container: string): Promise<Map<string, boolean>> {
  const r = await execAsAgent(
    ctx, container,
    "tmux list-sessions -F '#{session_name} #{session_attached}'",
  );
  return parseSessionStates(r.code === 0 ? r.stdout : "");
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `node --test tests/worktrees.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the real-git contract test**

`tests/contract/git.test.ts`:

```ts
// Couche 2 : les parsers tournent sur la sortie d'un VRAI git. C'est ici que
// se détecte une dérive entre ce que le code croit et ce que git fait.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorktreeDirs, parseAgentBranches } from "../../scripts/lib/worktrees.ts";

let repo: string;
const git = (args: string[], cwd = repo) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

before(() => {
  repo = mkdtempSync(join(tmpdir(), "forge-contract-"));
  git(["init", "-q", "-b", "main", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
  git(["branch", "agent/docs"]);
  git(["worktree", "add", "-q", ".trees/cli", "-b", "agent/cli"]);
});

after(() => rmSync(repo, { recursive: true, force: true }));

test("parseWorktreeDirs handles real porcelain stanzas", () => {
  const dirs = parseWorktreeDirs(git(["worktree", "list", "--porcelain"]));
  assert.equal(dirs.length, 1);
  assert.ok(dirs[0].endsWith("/.trees/cli"), `got ${dirs[0]}`);
});

test("for-each-ref yields short names, so the strip is correct", () => {
  const raw = git(["for-each-ref", "--format=%(refname:short)", "refs/heads/agent"]);
  // Le contrat exact : `agent/cli`, pas `refs/heads/agent/cli`.
  assert.ok(raw.includes("agent/cli"), `got: ${raw}`);
  assert.ok(!raw.includes("refs/heads/"), `got: ${raw}`);
  assert.deepEqual(parseAgentBranches(raw).sort(), ["cli", "docs"]);
});

test("show-ref --verify --quiet is a usable boolean probe", () => {
  const exists = (ref: string) => {
    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: repo });
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(exists("refs/heads/agent/cli"), true);
  assert.equal(exists("refs/heads/agent/nope"), false);
});
```

- [ ] **Step 6: Write the real-tmux contract test**

`tests/contract/tmux.test.ts`:

```ts
// Couche 2 : parseSessionStates contre un VRAI serveur tmux, sur une socket
// privée (-L) pour ne jamais toucher aux sessions de l'utilisateur.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { parseSessionStates } from "../../scripts/lib/worktrees.ts";

const SOCKET = "forge-contract-test";
const tmux = (args: string[]) =>
  spawnSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8" });

after(() => { tmux(["kill-server"]); });

test("a detached session really reports 0", () => {
  tmux(["kill-server"]);
  execFileSync("tmux", ["-L", SOCKET, "new-session", "-d", "-s", "cli"]);
  execFileSync("tmux", ["-L", SOCKET, "new-session", "-d", "-s", "docs"]);
  const raw = execFileSync(
    "tmux", ["-L", SOCKET, "list-sessions", "-F", "#{session_name} #{session_attached}"],
    { encoding: "utf8" },
  );
  const states = parseSessionStates(raw);
  assert.equal(states.get("cli"), false, `raw was: ${raw}`);
  assert.equal(states.get("docs"), false);
});

test("no server exits non-zero with a message on stderr, and stdout empty", () => {
  tmux(["kill-server"]);
  const r = tmux(["list-sessions", "-F", "#{session_name} #{session_attached}"]);
  // C'est la raison pour laquelle `exec` ne doit jamais lever sur un code non
  // nul : ce cas est une réponse normale, pas une panne.
  assert.notEqual(r.status, 0);
  assert.equal(parseSessionStates(r.stdout).size, 0);
});
```

- [ ] **Step 7: Run both contract tests**

Run: `node --test tests/contract/git.test.ts tests/contract/tmux.test.ts`
Expected: PASS, 5 tests. If `parseAgentBranches` disagrees with real git here, the parser is wrong — fix the parser, not the test.

- [ ] **Step 8: Commit**

```bash
npm run check
git add scripts/lib/worktrees.ts tests/worktrees.test.ts tests/contract/
git commit -m "feat(cli): worktrees, branches et sessions, avec tests de contrat git/tmux réels"
```

---

### Task 8: WIP pre-flight

**Files:**
- Create: `scripts/lib/wip.ts`, `tests/wip.test.ts`

**Interfaces:**
- Consumes: `Context`, `ForgeError`; `execAsAgent` from `lxd.ts`; `containerMode` from `containers.ts`; `worktreeDirs` from `worktrees.ts`.
- Produces: `checkWorktree(ctx, container, dir): Promise<void>`, `checkAllWorktrees(ctx, container): Promise<void>`. Both throw `ForgeError` when work would be lost.

A supervised container has no credential to have pushed with, so only the dirty-tree check applies there.

- [ ] **Step 1: Write the failing test**

`tests/wip.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { checkWorktree } from "../scripts/lib/wip.ts";

const clean = { match: "status --porcelain", stdout: "" };
const onBranch = { match: "rev-parse --abbrev-ref HEAD", stdout: "agent/cli\n" };

test("a dirty tree is refused, and the diff is shown", async () => {
  const ctx = fakeContext({
    rules: [{ match: "status --porcelain", stdout: " M scripts/forge\n" }],
  });
  await assert.rejects(
    () => checkWorktree(ctx, "agent-x", "/workspace/.trees/cli"),
    /uncommitted changes[\s\S]*scripts\/forge/,
  );
});

test("a supervised container is only checked for dirtiness", async () => {
  const ctx = fakeContext({
    rules: [clean, { match: "user.forge.mode", stdout: "supervised" }],
  });
  await checkWorktree(ctx, "agent-x", "/workspace/.trees/cli");
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes("origin/main..")));
});

test("an unexpected branch name is refused", async () => {
  const ctx = fakeContext({
    rules: [
      clean,
      { match: "user.forge.mode", stdout: "autonomous" },
      { match: "rev-parse --abbrev-ref HEAD", stdout: "main\n" },
    ],
  });
  await assert.rejects(() => checkWorktree(ctx, "agent-x", "/workspace/.trees/cli"), /unexpected branch name/);
});

test("commits ahead of main with no origin branch are refused", async () => {
  const ctx = fakeContext({
    rules: [
      clean,
      { match: "user.forge.mode", stdout: "autonomous" },
      onBranch,
      { match: "origin/main..", stdout: "abc feat: x\n" },
      { match: "rev-parse --verify origin/", code: 1 },
    ],
  });
  await assert.rejects(() => checkWorktree(ctx, "agent-x", "/workspace/.trees/cli"), /never been pushed/);
});

test("unpushed commits are refused and listed", async () => {
  const ctx = fakeContext({
    rules: [
      clean,
      { match: "user.forge.mode", stdout: "autonomous" },
      onBranch,
      { match: "origin/main..", stdout: "abc feat: x\n" },
      { match: "rev-parse --verify origin/", code: 0 },
      { match: "origin/agent/cli..", stdout: "abc feat: x\n" },
    ],
  });
  await assert.rejects(() => checkWorktree(ctx, "agent-x", "/workspace/.trees/cli"), /unpushed commits[\s\S]*feat: x/);
});

test("a clean, fully pushed worktree passes", async () => {
  const ctx = fakeContext({
    rules: [
      clean,
      { match: "user.forge.mode", stdout: "autonomous" },
      onBranch,
      { match: "origin/main..", stdout: "" },
    ],
  });
  await checkWorktree(ctx, "agent-x", "/workspace/.trees/cli");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/wip.test.ts`
Expected: FAIL — cannot find module `../scripts/lib/wip.ts`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/wip.ts`:

```ts
// Pré-vol avant toute opération destructrice. Le but est de faire apparaître
// du travail *oublié*, pas d'empêcher une perte de données : le workspace est
// monté depuis l'hôte et survit de toute façon.
import type { Context } from "./context.ts";
import { ForgeError } from "./context.ts";
import { execAsAgent } from "./lxd.ts";
import { containerMode } from "./containers.ts";
import { worktreeDirs } from "./worktrees.ts";

const BRANCH = /^agent\/[A-Za-z0-9._-]+$/;

export async function checkWorktree(ctx: Context, container: string, dir: string): Promise<void> {
  const dirty = await execAsAgent(ctx, container, `cd ${dir} && git status --porcelain`);
  if (dirty.stdout.trim()) {
    throw new ForgeError(
      `${container} has uncommitted changes in ${dir}:\n${dirty.stdout.trimEnd()}\n` +
      `Commit/discard them, or pass --force.`,
    );
  }

  // Un container supervised n'a aucune credential pour avoir poussé : seule la
  // vérification de propreté s'y applique.
  if ((await containerMode(ctx, container)) === "supervised") return;

  const head = await execAsAgent(ctx, container, `cd ${dir} && git rev-parse --abbrev-ref HEAD`);
  const branch = head.stdout.trim();
  if (!BRANCH.test(branch)) {
    throw new ForgeError(`unexpected branch name '${branch}' in ${dir} (${container}); refusing to proceed.`);
  }

  const ahead = await execAsAgent(ctx, container, `cd ${dir} && git log --oneline origin/main..${branch}`);
  if (!ahead.stdout.trim()) return;

  const remote = await execAsAgent(ctx, container, `cd ${dir} && git rev-parse --verify origin/${branch}`);
  if (remote.code !== 0) {
    throw new ForgeError(
      `${container}'s branch ${branch} has no origin/${branch} — it has never been pushed.\n` +
      `Push it, or pass --force.`,
    );
  }

  const unpushed = await execAsAgent(ctx, container, `cd ${dir} && git log --oneline origin/${branch}..${branch}`);
  if (unpushed.stdout.trim()) {
    throw new ForgeError(
      `${container} has unpushed commits on ${branch}:\n${unpushed.stdout.trimEnd()}\n` +
      `Push them, or pass --force.`,
    );
  }
}

// Le clone principal (/workspace, sur main) ne reçoit jamais de commit : seuls
// les worktrees .trees/* sont vérifiés.
export async function checkAllWorktrees(ctx: Context, container: string): Promise<void> {
  for (const dir of await worktreeDirs(ctx, container)) {
    await checkWorktree(ctx, container, dir);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/wip.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
npm run check
git add scripts/lib/wip.ts tests/wip.test.ts
git commit -m "feat(cli): pré-vol WIP (arbre sale, commits non poussés)"
```

---

### Task 9: `forge list`

**Files:**
- Create: `scripts/lib/commands/list.ts`, `tests/list.test.ts`

**Interfaces:**
- Consumes: `Context`; `columnWidths`, `formatRow` from `table.ts`; `listForgeContainers`, `containerRepo`, `containerMode`, `currentImageCommit`, `containerImageCommit`, `buildStatus` from `containers.ts`; `instanceStatus` from `lxd.ts`; `taskNames`, `sessionStates` from `worktrees.ts`.
- Produces: `cmdList(ctx: Context): Promise<number>`.

Columns are `REPO MODE STATE BUILD`, with an indented `<task> <session>` row per worktree. The container name and the task's branch are deliberately absent: both are derivable (`agent-` plus the sanitized repo; `agent/<task>`) and were what pushed the line past 80 columns.

- [ ] **Step 1: Write the failing test**

`tests/list.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdList } from "../scripts/lib/commands/list.ts";

const LIST = JSON.stringify([
  { name: "agent-moroine-agent-forge", status: "Running" },
  { name: "agent-acme-super-long-repository-name", status: "Stopped" },
]);

function ctx() {
  return fakeContext({
    rules: [
      { match: "image get-property", stdout: "bbbb2222" },
      { match: "agent-moroine-agent-forge user.forge.image_commit", stdout: "aaaa1111" },
      { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
      { match: "agent-moroine-agent-forge user.forge.mode", stdout: "autonomous" },
      { match: "agent-acme-super-long-repository-name user.forge.image_commit", stdout: "bbbb2222" },
      { match: "agent-acme-super-long-repository-name user.forge.repo", stdout: "acme/super-long-repository-name" },
      { match: "agent-acme-super-long-repository-name user.forge.mode", stdout: "supervised" },
      { match: "lxc list", stdout: LIST },
      { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\nworktree /workspace/.trees/docs\nworktree /workspace/.trees/api\n" },
      { match: "list-sessions", stdout: "cli 1\ndocs 0\n" },
    ],
  });
}

test("the header names the four columns, repo first", async () => {
  const c = ctx();
  await cmdList(c);
  assert.match(c.out_lines[0], /^REPO\s+MODE\s+STATE\s+BUILD$/);
});

test("a behind container is reported without the two sha", async () => {
  const c = ctx();
  await cmdList(c);
  assert.match(c.out_lines[1], /^moroine\/agent-forge\s+autonomous\s+Running\s+behind$/);
});

test("the three session states are distinguished", async () => {
  const c = ctx();
  await cmdList(c);
  assert.match(c.out_lines[2], /^ {2}cli\s+attached$/);
  assert.match(c.out_lines[3], /^ {2}docs\s+detached$/);
  assert.match(c.out_lines[4], /^ {2}api\s+no session$/);
});

test("a stopped container yields no task rows and is not inspected", async () => {
  const c = ctx();
  await cmdList(c);
  assert.match(c.out_lines[5], /^acme\/super-long-repository-name\s+supervised\s+Stopped\s+ok$/);
  assert.equal(c.out_lines.length, 6);
});

test("a long repo name widens its column instead of shifting the others", async () => {
  const c = ctx();
  await cmdList(c);
  const modeAt = c.out_lines[0].indexOf("MODE");
  for (const line of c.out_lines.filter((l) => !l.startsWith(" "))) {
    assert.notEqual(line[modeAt], " ", `misaligned: ${line}`);
  }
});

test("no line wraps an 80-column terminal", async () => {
  const c = ctx();
  await cmdList(c);
  for (const line of c.out_lines) assert.ok(line.length <= 80, `too long: ${line}`);
});

test("a container with no repo metadata falls back to its name", async () => {
  const c = fakeContext({
    rules: [
      { match: "lxc list", stdout: JSON.stringify([{ name: "agent-orphan", status: "Stopped" }]) },
      { match: "image get-property", stdout: "" },
    ],
  });
  await cmdList(c);
  assert.match(c.out_lines[1], /^agent-orphan\s+-\s+Stopped\s+unknown$/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/list.test.ts`
Expected: FAIL — cannot find module `../scripts/lib/commands/list.ts`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/commands/list.ts`:

```ts
// Une ligne par container, suivie d'une ligne indentée par worktree.
//
// Deux colonnes ont disparu parce qu'elles étaient déductibles et faisaient
// wrapper la sortie : le nom du container (toujours agent-<repo assaini>) et
// la branche d'une tâche (toujours agent/<task>).
import type { Context } from "../context.ts";
import { columnWidths, formatRow } from "../table.ts";
import { instanceStatus } from "../lxd.ts";
import {
  buildStatus, containerImageCommit, containerMode, containerRepo,
  currentImageCommit, listForgeContainers,
} from "../containers.ts";
import { sessionStates, taskNames } from "../worktrees.ts";

const HEADER = ["REPO", "MODE", "STATE", "BUILD"];

type Entry = { cells: string[]; tasks: string[][] };

function buildLabel(status: string): string {
  if (status === "up-to-date") return "ok";
  if (status === "behind") return "behind";
  return "unknown";
}

export async function cmdList(ctx: Context): Promise<number> {
  const latest = await currentImageCommit(ctx);
  const entries: Entry[] = [];

  for (const name of await listForgeContainers(ctx)) {
    const repo = await containerRepo(ctx, name);
    const mode = await containerMode(ctx, name);
    const status = (await instanceStatus(ctx, name)) ?? "Unknown";
    const stamp = await containerImageCommit(ctx, name);

    const entry: Entry = {
      // Un container sans métadonnée repo n'a que son nom comme identifiant.
      cells: [repo || name, mode || "-", status, buildLabel(buildStatus(stamp, latest))],
      tasks: [],
    };

    // Un container arrêté ne peut pas être inspecté.
    if (status === "Running") {
      const sessions = await sessionStates(ctx, name);
      for (const task of await taskNames(ctx, name)) {
        const attached = sessions.get(task);
        const state = attached === undefined ? "no session" : attached ? "attached" : "detached";
        entry.tasks.push([task, state]);
      }
    }
    entries.push(entry);
  }

  const widths = columnWidths([HEADER, ...entries.map((e) => e.cells)]);
  const taskWidths = columnWidths(entries.flatMap((e) => e.tasks));

  ctx.out(formatRow(HEADER, widths));
  for (const entry of entries) {
    ctx.out(formatRow(entry.cells, widths));
    for (const task of entry.tasks) ctx.out(formatRow(task, taskWidths, "  "));
  }
  return 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/list.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
npm run check
git add scripts/lib/commands/list.ts tests/list.test.ts
git commit -m "feat(cli): forge list"
```

---

### Task 10: `forge completion`

**Files:**
- Create: `scripts/lib/commands/completion.ts`, `tests/completion.test.ts`

**Interfaces:**
- Consumes: `Context`, `ForgeError`; `validateRepo` from `validate.ts`; `forgeRepos`, `requireContainerForRepo`, `isRunning` from `containers.ts`; `taskNames` from `worktrees.ts`.
- Produces: `cmdCompletion(ctx, sub: string | undefined, repo: string | undefined): Promise<number>`; `COMPLETION_SCRIPT: string`.

The bash function used to parse the human `forge list` table (`awk '{print $2}'`), so any formatting fix broke it. It now reads two machine-readable subcommands, which also feed the interactive menus — one source for both.

- [ ] **Step 1: Write the failing test**

`tests/completion.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { ForgeError } from "../scripts/lib/context.ts";
import { cmdCompletion, COMPLETION_SCRIPT } from "../scripts/lib/commands/completion.ts";

const LIST = JSON.stringify([
  { name: "agent-moroine-agent-forge", status: "Running" },
  { name: "agent-acme-widgets", status: "Stopped" },
]);

function ctx() {
  return fakeContext({
    rules: [
      { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
      { match: "agent-acme-widgets user.forge.repo", stdout: "acme/widgets" },
      { match: "lxc list", stdout: LIST },
      { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\nworktree /workspace/.trees/docs\n" },
    ],
  });
}

test("repos prints one owner/repo per line", async () => {
  const c = ctx();
  await cmdCompletion(c, "repos", undefined);
  assert.deepEqual(c.out_lines, ["moroine/agent-forge", "acme/widgets"]);
});

test("repos never shells into a container, so TAB stays fast", async () => {
  const c = ctx();
  await cmdCompletion(c, "repos", undefined);
  assert.ok(!c.calls.some((call) => call[1] === "exec"));
});

test("tasks prints one task per line for a running container", async () => {
  const c = ctx();
  await cmdCompletion(c, "tasks", "moroine/agent-forge");
  assert.deepEqual(c.out_lines, ["cli", "docs"]);
});

test("tasks on a stopped container prints nothing and succeeds", async () => {
  const c = ctx();
  assert.equal(await cmdCompletion(c, "tasks", "acme/widgets"), 0);
  assert.deepEqual(c.out_lines, []);
});

test("tasks on an unknown repo fails", async () => {
  await assert.rejects(() => cmdCompletion(ctx(), "tasks", "nobody/nothing"), ForgeError);
});

test("tasks without a repo argument fails with usage", async () => {
  await assert.rejects(() => cmdCompletion(ctx(), "tasks", undefined), /Usage: forge completion/);
});

test("an unknown subcommand fails with usage", async () => {
  await assert.rejects(() => cmdCompletion(ctx(), "zsh", undefined), /Usage: forge completion/);
});

test("the emitted bash script reads the machine subcommands, not the table", async () => {
  const c = ctx();
  await cmdCompletion(c, "bash", undefined);
  const script = c.out_lines.join("\n");
  assert.ok(script.includes("forge completion repos"));
  assert.ok(script.includes("forge completion tasks"));
  assert.ok(!script.includes("awk"));
  assert.ok(script.includes("complete -F _forge_completions forge"));
});

test("the completion script offers tasks in third position and --force where it applies", () => {
  assert.ok(COMPLETION_SCRIPT.includes("start|resume|finish"));
  assert.ok(COMPLETION_SCRIPT.includes("--force"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/completion.test.ts`
Expected: FAIL — cannot find module `../scripts/lib/commands/completion.ts`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/commands/completion.ts`:

```ts
// La fonction bash à évaluer, plus les deux sous-commandes à sortie machine
// qui l'alimentent — et qui servent aussi de source aux menus interactifs.
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { validateRepo } from "../validate.ts";
import { forgeRepos, isRunning, requireContainerForRepo } from "../containers.ts";
import { taskNames } from "../worktrees.ts";

const USAGE = "Usage: forge completion bash|repos|tasks <owner/repo>";

export const COMPLETION_SCRIPT = `_forge_completions() {
  local cur cmd
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmd="\${COMP_WORDS[1]}"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "start resume finish stop delete list image completion" -- "$cur"))
    return
  fi

  case "$cmd" in
    start|resume|finish|stop|delete)
      case "$COMP_CWORD" in
        2) COMPREPLY=($(compgen -W "$(forge completion repos 2>/dev/null)" -- "$cur")) ;;
        3)
          case "$cmd" in
            start|resume|finish)
              COMPREPLY=($(compgen -W "$(forge completion tasks "\${COMP_WORDS[2]}" 2>/dev/null)" -- "$cur")) ;;
            stop|delete)
              COMPREPLY=($(compgen -W "--force" -- "$cur")) ;;
          esac
          ;;
        4) [ "$cmd" = "finish" ] && COMPREPLY=($(compgen -W "--force" -- "$cur")) ;;
      esac
      ;;
    image)      [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "build update" -- "$cur")) ;;
    completion) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "bash repos tasks" -- "$cur")) ;;
  esac
  return 0
}
complete -F _forge_completions forge`;

export async function cmdCompletion(
  ctx: Context,
  sub: string | undefined,
  repo: string | undefined,
): Promise<number> {
  if (sub === "bash") {
    ctx.out(COMPLETION_SCRIPT);
    return 0;
  }

  if (sub === "repos") {
    for (const r of await forgeRepos(ctx)) ctx.out(r);
    return 0;
  }

  if (sub === "tasks") {
    if (!repo) throw new ForgeError(USAGE);
    validateRepo(repo);
    const container = await requireContainerForRepo(ctx, repo);
    // Container arrêté : rien à lister, mais ce n'est pas une erreur — on ne
    // peut simplement pas l'inspecter.
    if (!(await isRunning(ctx, container))) return 0;
    for (const t of await taskNames(ctx, container)) ctx.out(t);
    return 0;
  }

  throw new ForgeError(USAGE);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/completion.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Verify the emitted script is valid bash**

```bash
node -e 'import("./scripts/lib/commands/completion.ts").then(m => console.log(m.COMPLETION_SCRIPT))' > /tmp/completion.bash
bash -n /tmp/completion.bash && echo "syntaxe bash OK"
```

- [ ] **Step 6: Commit**

```bash
npm run check
git add scripts/lib/commands/completion.ts tests/completion.test.ts
git commit -m "feat(cli): forge completion, avec sorties machine repos/tasks"
```

---

### Task 11: Argument resolution, `forge stop`, `forge delete`

**Files:**
- Create: `scripts/lib/commands/resolve.ts`, `scripts/lib/commands/stop.ts`, `scripts/lib/commands/delete.ts`, `tests/resolve.test.ts`, `tests/stop-delete.test.ts`

**Interfaces:**
- Consumes: `Context`, `ForgeError`; `forgeRepos`, `isRunning`, `requireContainerForRepo` from `containers.ts`; `taskNames` from `worktrees.ts`; `checkAllWorktrees` from `wip.ts`; `stopInstance`, `deleteInstance`, `instanceStatus` from `lxd.ts`; `validateRepo` from `validate.ts`.
- Produces: `resolveRepo(ctx, repo: string | undefined, usage: string): Promise<string>`; `resolveTask(ctx, container: string, task: string | undefined, usage: string): Promise<string>`; `cmdStop(ctx, repo: string | undefined, force: boolean): Promise<number>`; `cmdDelete(ctx, repo: string | undefined, force: boolean): Promise<number>`.

Prompting lives here, in the commands layer, so `containers.ts` and `worktrees.ts` stay free of terminal knowledge. When a resolver cannot ask — no TTY, empty list, EOF — it throws `ForgeError(usage)`, which is how a scripted call gets a usage message and exit 1 instead of hanging.

- [ ] **Step 1: Write the failing tests**

`tests/resolve.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { resolveRepo, resolveTask } from "../scripts/lib/commands/resolve.ts";

const LIST = JSON.stringify([
  { name: "agent-moroine-agent-forge", status: "Running" },
  { name: "agent-acme-widgets", status: "Running" },
]);
const RULES = [
  { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
  { match: "agent-acme-widgets user.forge.repo", stdout: "acme/widgets" },
  { match: "lxc list", stdout: LIST },
  { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\nworktree /workspace/.trees/docs\n" },
];

test("a provided repo is returned untouched, with no prompt", async () => {
  const c = fakeContext({ rules: RULES });
  assert.equal(await resolveRepo(c, "given/repo", "usage"), "given/repo");
  assert.equal(c.err_lines.length, 0);
});

test("a missing repo is picked from the managed repos", async () => {
  const c = fakeContext({ rules: RULES, answers: [2] });
  assert.equal(await resolveRepo(c, undefined, "usage"), "acme/widgets");
});

test("resolveRepo throws the usage when it cannot ask", async () => {
  const c = fakeContext({ rules: RULES, tty: false });
  await assert.rejects(() => resolveRepo(c, undefined, "Usage: forge stop <owner/repo>"), /Usage: forge stop/);
});

test("resolveRepo explains when no container exists at all", async () => {
  const c = fakeContext({ rules: [{ match: "lxc list", stdout: "[]" }] });
  await assert.rejects(() => resolveRepo(c, undefined, "usage"), /no forge container yet/);
});

test("a missing task is picked from the existing worktrees", async () => {
  const c = fakeContext({ rules: RULES, answers: [1] });
  assert.equal(await resolveTask(c, "agent-moroine-agent-forge", undefined, "usage"), "cli");
});

test("resolveTask refuses on a stopped container with a clear reason", async () => {
  const c = fakeContext({
    rules: [{ match: "lxc list", stdout: JSON.stringify([{ name: "agent-x", status: "Stopped" }]) }],
  });
  await assert.rejects(() => resolveTask(c, "agent-x", undefined, "usage"), /stopped/);
});

test("resolveTask explains when the container has no worktree", async () => {
  const c = fakeContext({
    rules: [
      { match: "lxc list", stdout: JSON.stringify([{ name: "agent-x", status: "Running" }]) },
      { match: "git worktree list", stdout: "worktree /workspace\n" },
    ],
  });
  await assert.rejects(() => resolveTask(c, "agent-x", undefined, "usage"), /no task worktree/);
});
```

`tests/stop-delete.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdStop } from "../scripts/lib/commands/stop.ts";
import { cmdDelete } from "../scripts/lib/commands/delete.ts";

const RULES = [
  { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
  { match: "lxc list", stdout: JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Running" }]) },
  { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\n" },
  { match: "status --porcelain", stdout: " M scripts/forge\n" },
];

test("stop runs the WIP pre-flight and refuses a dirty worktree", async () => {
  const c = fakeContext({ rules: RULES });
  await assert.rejects(() => cmdStop(c, "moroine/agent-forge", false), /uncommitted changes/);
  assert.ok(!c.calls.some((call) => call[1] === "stop"));
});

test("stop --force skips the pre-flight and stops the container", async () => {
  const c = fakeContext({ rules: RULES });
  assert.equal(await cmdStop(c, "moroine/agent-forge", true), 0);
  assert.ok(c.calls.some((call) => call.join(" ") === "lxc stop agent-moroine-agent-forge"));
  assert.ok(!c.calls.some((call) => call.join(" ").includes("status --porcelain")));
});

test("stop asks for the repo when it is missing", async () => {
  const c = fakeContext({ rules: RULES, answers: [1] });
  await cmdStop(c, undefined, true);
  assert.ok(c.calls.some((call) => call.join(" ") === "lxc stop agent-moroine-agent-forge"));
});

test("delete skips the pre-flight on an already stopped container", async () => {
  const c = fakeContext({
    rules: [
      { match: "agent-x user.forge.repo", stdout: "o/r" },
      { match: "lxc list", stdout: JSON.stringify([{ name: "agent-x", status: "Stopped" }]) },
    ],
  });
  assert.equal(await cmdDelete(c, "o/r", false), 0);
  assert.ok(!c.calls.some((call) => call.join(" ").includes("status --porcelain")));
  assert.ok(c.calls.some((call) => call.join(" ") === "lxc delete agent-x --force"));
});

test("delete runs the pre-flight on a running container", async () => {
  const c = fakeContext({ rules: RULES });
  await assert.rejects(() => cmdDelete(c, "moroine/agent-forge", false), /uncommitted changes/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/resolve.test.ts tests/stop-delete.test.ts`
Expected: FAIL — the three modules do not exist.

- [ ] **Step 3: Write the implementations**

`scripts/lib/commands/resolve.ts`:

```ts
// Résolution des arguments manquants. Le prompting vit dans la couche des
// commandes : containers.ts et worktrees.ts ne doivent rien savoir des
// terminaux.
//
// Quand on ne peut pas demander — pas de TTY, liste vide, saisie interrompue —
// on lève l'usage de l'appelant : un appel scripté obtient un message et un
// code 1, jamais un blocage sur une invite que personne ne lira.
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { forgeRepos, isRunning } from "../containers.ts";
import { taskNames } from "../worktrees.ts";

export async function resolveRepo(
  ctx: Context,
  repo: string | undefined,
  usage: string,
): Promise<string> {
  if (repo) return repo;

  const repos = await forgeRepos(ctx);
  if (repos.length === 0) {
    throw new ForgeError("no forge container yet. Run 'forge start <owner/repo> <task>' first.");
  }

  const idx = await ctx.prompt.pick("Repo", repos);
  if (idx === null) throw new ForgeError(usage);
  return repos[idx - 1];
}

// Ne sert qu'aux commandes qui agissent sur une tâche *déjà là* (resume,
// finish) ; `forge start` a son propre menu, qui propose aussi de créer.
export async function resolveTask(
  ctx: Context,
  container: string,
  task: string | undefined,
  usage: string,
): Promise<string> {
  if (task) return task;

  if (!(await isRunning(ctx, container))) {
    throw new ForgeError(
      `container ${container} is stopped, so its tasks can't be listed. Name the task explicitly, or start it.`,
    );
  }

  const tasks = await taskNames(ctx, container);
  if (tasks.length === 0) {
    throw new ForgeError(`no task worktree in ${container}. Create one with 'forge start'.`);
  }

  const idx = await ctx.prompt.pick("Task", tasks);
  if (idx === null) throw new ForgeError(usage);
  return tasks[idx - 1];
}
```

`scripts/lib/commands/stop.ts`:

```ts
// forge stop [<owner/repo>] [--force]
// Pré-vol WIP (arbre sale / commits non poussés) sauf --force.
import type { Context } from "../context.ts";
import { validateRepo } from "../validate.ts";
import { requireContainerForRepo } from "../containers.ts";
import { stopInstance } from "../lxd.ts";
import { checkAllWorktrees } from "../wip.ts";
import { resolveRepo } from "./resolve.ts";

const USAGE = "Usage: forge stop <owner/repo> [--force]";

export async function cmdStop(ctx: Context, repo: string | undefined, force: boolean): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);
  const container = await requireContainerForRepo(ctx, ownerRepo);

  if (!force) await checkAllWorktrees(ctx, container);

  ctx.out(`Stopping container ${container}...`);
  await stopInstance(ctx, container);
  return 0;
}
```

`scripts/lib/commands/delete.ts`:

```ts
// forge delete [<owner/repo>] [--force]
// Pré-vol WIP sauf --force ou container déjà arrêté (stop l'a déjà fait). Le
// workspace est monté depuis l'hôte et survit de toute façon : ce contrôle
// existe pour révéler du travail *oublié* avant qu'un re-provisioning ne
// reclone à neuf, pas pour empêcher une perte de données.
import type { Context } from "../context.ts";
import { validateRepo } from "../validate.ts";
import { requireContainerForRepo } from "../containers.ts";
import { deleteInstance, instanceStatus } from "../lxd.ts";
import { checkAllWorktrees } from "../wip.ts";
import { resolveRepo } from "./resolve.ts";

const USAGE = "Usage: forge delete <owner/repo> [--force]";

export async function cmdDelete(ctx: Context, repo: string | undefined, force: boolean): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);
  const container = await requireContainerForRepo(ctx, ownerRepo);

  if (!force && (await instanceStatus(ctx, container)) === "Running") {
    await checkAllWorktrees(ctx, container);
  }

  ctx.out(`Deleting container ${container}...`);
  await deleteInstance(ctx, container);
  return 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/resolve.test.ts tests/stop-delete.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
npm run check
git add scripts/lib/commands/resolve.ts scripts/lib/commands/stop.ts scripts/lib/commands/delete.ts tests/resolve.test.ts tests/stop-delete.test.ts
git commit -m "feat(cli): résolution interactive des arguments, forge stop et delete"
```

---

### Task 12: `forge resume` and `forge finish`

**Files:**
- Create: `scripts/lib/commands/resume.ts`, `scripts/lib/commands/finish.ts`, `tests/resume-finish.test.ts`

**Interfaces:**
- Consumes: `Context`, `ForgeError`; `validateRepo`, `validateTaskName`; `requireContainerForRepo`, `isRunning`; `startInstance`, `execAsAgent`, `attachArgv`; `worktreeAbsPath`; `checkWorktree`; `resolveRepo`, `resolveTask`.
- Produces: `cmdResume(ctx, repo?: string, task?: string): Promise<number>`; `cmdFinish(ctx, repo: string | undefined, task: string | undefined, force: boolean): Promise<number>`.

`resume` does no fetch and no rebranch — that is `start`'s job. `finish` keeps the `agent/<task>` branch: only the worktree goes, so a merged or abandoned task can still be inspected later.

- [ ] **Step 1: Write the failing test**

`tests/resume-finish.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdResume } from "../scripts/lib/commands/resume.ts";
import { cmdFinish } from "../scripts/lib/commands/finish.ts";

const BASE = [
  { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
  { match: "lxc list", stdout: JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Running" }]) },
  { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\nworktree /workspace/.trees/docs\n" },
];

test("resume attaches the task's tmux session", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 0 }] });
  assert.equal(await cmdResume(c, "moroine/agent-forge", "cli"), 0);
  const attach = c.calls.find((call) => call.includes("tmux"));
  assert.ok(attach, "no attach happened");
  assert.ok(attach.includes("new-session") && attach.includes("cli"));
});

test("resume never creates a worktree", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 0 }] });
  await cmdResume(c, "moroine/agent-forge", "cli");
  assert.ok(!c.calls.some((call) => call.join(" ").includes("worktree add")));
});

test("resume errors when the worktree is absent, pointing at start", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 1 }] });
  await assert.rejects(() => cmdResume(c, "moroine/agent-forge", "nope"), /forge start/);
});

test("resume asks for repo then task when both are missing", async () => {
  const c = fakeContext({ rules: [...BASE, { match: "test -e", code: 0 }], answers: [1, 2] });
  await cmdResume(c, undefined, undefined);
  const attach = c.calls.find((call) => call.includes("tmux"));
  assert.ok(attach?.includes("docs"), `attached to the wrong session: ${attach?.join(" ")}`);
});

test("finish removes the worktree after the pre-flight", async () => {
  const c = fakeContext({
    rules: [
      ...BASE,
      { match: "test -e", code: 0 },
      { match: "status --porcelain", stdout: "" },
      { match: "user.forge.mode", stdout: "supervised" },
    ],
  });
  assert.equal(await cmdFinish(c, "moroine/agent-forge", "cli", false), 0);
  assert.ok(c.calls.some((call) => call.join(" ").includes("worktree remove .trees/cli")));
});

test("finish --force skips the pre-flight and forces the removal", async () => {
  const c = fakeContext({
    rules: [...BASE, { match: "test -e", code: 0 }, { match: "status --porcelain", stdout: " M x\n" }],
  });
  assert.equal(await cmdFinish(c, "moroine/agent-forge", "cli", true), 0);
  assert.ok(c.calls.some((call) => call.join(" ").includes("worktree remove --force .trees/cli")));
});

test("finish keeps the branch and kills the session", async () => {
  const c = fakeContext({
    rules: [...BASE, { match: "test -e", code: 0 }, { match: "status --porcelain", stdout: "" }, { match: "user.forge.mode", stdout: "supervised" }],
  });
  await cmdFinish(c, "moroine/agent-forge", "cli", false);
  assert.ok(!c.calls.some((call) => call.join(" ").includes("branch -D")));
  assert.ok(c.calls.some((call) => call.join(" ").includes("kill-session -t cli")));
  assert.ok(c.out_lines.some((l) => l.includes("branch agent/cli retained")));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/resume-finish.test.ts`
Expected: FAIL — the two modules do not exist.

- [ ] **Step 3: Write the implementations**

`scripts/lib/commands/resume.ts`:

```ts
// forge resume [<owner/repo>] [<task>]
// Rattache la session tmux d'une tâche existante. Ni fetch ni rebranch —
// c'est le rôle de `forge start`.
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { validateRepo, validateTaskName } from "../validate.ts";
import { isRunning, requireContainerForRepo } from "../containers.ts";
import { attachArgv, execAsAgent, startInstance } from "../lxd.ts";
import { resolveRepo, resolveTask } from "./resolve.ts";

const USAGE = "Usage: forge resume <owner/repo> <task>";

export async function cmdResume(ctx: Context, repo?: string, task?: string): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);
  const container = await requireContainerForRepo(ctx, ownerRepo);

  ctx.out(`Starting container ${container}...`);
  if (!(await isRunning(ctx, container))) await startInstance(ctx, container);

  const taskName = await resolveTask(ctx, container, task, USAGE);
  validateTaskName(taskName);

  const present = await execAsAgent(ctx, container, `test -e /workspace/.trees/${taskName}`);
  if (present.code !== 0) {
    throw new ForgeError(
      `no worktree .trees/${taskName} in ${container}. Start it with 'forge start ${ownerRepo} ${taskName}'.`,
    );
  }

  ctx.out(`Attaching to ${container} session '${taskName}' as aiuser...`);
  return ctx.attach(attachArgv(container, taskName, process.env.TERM ?? "xterm-256color"));
}
```

`scripts/lib/commands/finish.ts`:

```ts
// forge finish [<owner/repo>] [<task>] [--force]
// Retire le worktree d'une tâche terminée. La ref agent/<task> reste dans
// .git : une branche mergée ou abandonnée peut encore être inspectée.
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { validateRepo, validateTaskName } from "../validate.ts";
import { requireContainerForRepo } from "../containers.ts";
import { execAsAgent } from "../lxd.ts";
import { worktreeAbsPath } from "../worktrees.ts";
import { checkWorktree } from "../wip.ts";
import { resolveRepo, resolveTask } from "./resolve.ts";

const USAGE = "Usage: forge finish <owner/repo> <task> [--force]";

export async function cmdFinish(
  ctx: Context,
  repo: string | undefined,
  task: string | undefined,
  force: boolean,
): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);
  const container = await requireContainerForRepo(ctx, ownerRepo);

  const taskName = await resolveTask(ctx, container, task, USAGE);
  validateTaskName(taskName);

  const dir = worktreeAbsPath(taskName);
  if ((await execAsAgent(ctx, container, `test -e ${dir}`)).code !== 0) {
    throw new ForgeError(`no worktree .trees/${taskName} in ${container}.`);
  }

  if (!force) await checkWorktree(ctx, container, dir);

  ctx.out(`Removing worktree .trees/${taskName}...`);
  const flag = force ? "--force " : "";
  await execAsAgent(ctx, container, `git -C /workspace worktree remove ${flag}.trees/${taskName}`);

  // Au mieux : on démonte la session si elle traîne encore.
  await execAsAgent(ctx, container, `tmux kill-session -t ${taskName} 2>/dev/null || true`);

  ctx.out(`Finished task ${taskName} (branch agent/${taskName} retained).`);
  return 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/resume-finish.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
npm run check
git add scripts/lib/commands/resume.ts scripts/lib/commands/finish.ts tests/resume-finish.test.ts
git commit -m "feat(cli): forge resume et forge finish"
```

---

### Task 13: Container provisioning

**Files:**
- Create: `scripts/lib/commands/provision.ts`, `tests/provision.test.ts`
- Modify: `scripts/lib/context.ts`, `scripts/lib/prompt.ts`, `tests/lib/fake-context.ts` (all three gain `askSecret`)

**Interfaces:**
- Consumes: `Context`, `ForgeError`; `configSet`, `execAsAgent` from `lxd.ts`; `currentImageCommit` from `containers.ts`.
- Produces: `provisionContainer(ctx, container: string, ownerRepo: string): Promise<void>`; and the `Prompt` type gains `askSecret(label: string): Promise<string | null>`.

**This task extends the `Prompt` interface defined in Task 1.** The bot PAT is read with `read -r -s` in bash; the TypeScript equivalent needs stdin in raw mode, because `node:readline` echoes by default. Add `askSecret` to the `Prompt` type in `context.ts`, implement it in `prompt.ts`, and add it to `fakeContext`.

This is the one command that mutates the host: it creates `~/workspaces/<container>`, and in supervised mode clones over SSH there. Host paths stay overridable by environment variable so the tests never touch a real home directory.

- [ ] **Step 1: Extend the Prompt interface**

In `scripts/lib/context.ts`, add to `type Prompt`:

```ts
  askSecret(label: string): Promise<string | null>;
```

In `scripts/lib/prompt.ts`, add this to the returned object:

```ts
    // Le PAT ne doit pas s'afficher : node:readline échoue par défaut, il faut
    // passer stdin en raw et consommer les octets à la main.
    async askSecret(label) {
      const stdin = input as NodeJS.ReadStream;
      if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return null;
      err(`${label}: `);
      return new Promise<string | null>((resolve) => {
        let buf = "";
        const cleanup = () => {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          err("\n");
        };
        const onData = (chunk: Buffer) => {
          for (const ch of chunk.toString("utf8")) {
            if (ch === "\r" || ch === "\n") { cleanup(); resolve(buf === "" ? null : buf); return; }
            if (ch === "\u0003") { cleanup(); resolve(null); return; }   // Ctrl-C
            if (ch === "\u007f") { buf = buf.slice(0, -1); continue; }   // backspace
            buf += ch;
          }
        };
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", onData);
      });
    },
```

In `tests/lib/fake-context.ts`, add to the `prompt` object:

```ts
    async askSecret(label) {
      err_lines.push(`${label}: `);
      if (!tty) return null;
      const a = answers.shift();
      return typeof a === "string" ? a : null;
    },
```

- [ ] **Step 2: Write the failing test**

`tests/provision.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { provisionContainer } from "../scripts/lib/commands/provision.ts";

let home: string;

function setup() {
  home = mkdtempSync(join(tmpdir(), "forge-prov-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
  writeFileSync(join(home, ".ssh", "github_agents_signing"), "key");
  process.env.FORGE_HOME = home;
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
}

function teardown() {
  rmSync(home, { recursive: true, force: true });
  delete process.env.FORGE_HOME;
  delete process.env.FORGE_REPO_DIR;
  delete process.env.FORGE_WORKSPACES;
}

const IMAGE_OK = { match: "image info", code: 0 };

test("provisioning refuses without host Claude credentials", async () => {
  setup();
  rmSync(join(home, ".claude", ".credentials.json"));
  try {
    await assert.rejects(
      () => provisionContainer(fakeContext({ rules: [IMAGE_OK], answers: ["a"] }), "agent-x", "o/r"),
      /credentials.json not found/,
    );
  } finally { teardown(); }
});

test("provisioning refuses when agent-base is missing", async () => {
  setup();
  try {
    await assert.rejects(
      () => provisionContainer(fakeContext({ rules: [{ match: "image info", code: 1 }] }), "agent-x", "o/r"),
      /image agent-base not found/,
    );
  } finally { teardown(); }
});

test("autonomous mode reads the token without echoing and never puts it in argv", async () => {
  setup();
  try {
    const c = fakeContext({ rules: [IMAGE_OK], answers: ["a", "ghp_secret"] });
    await provisionContainer(c, "agent-x", "o/r");
    // Le token part sur stdin de `gh auth login`, jamais en argv : argv est
    // visible dans ps.
    assert.ok(!c.calls.some((call) => call.join(" ").includes("ghp_secret")));
    assert.ok(c.calls.some((call) => call.join(" ").includes("gh auth login")));
    assert.ok(c.calls.some((call) => call.join(" ").includes("git clone https://github.com/o/r.git")));
  } finally { teardown(); }
});

test("autonomous mode refuses an empty token", async () => {
  setup();
  try {
    await assert.rejects(
      () => provisionContainer(fakeContext({ rules: [IMAGE_OK], answers: ["a", null] }), "agent-x", "o/r"),
      /empty token/,
    );
  } finally { teardown(); }
});

test("supervised mode never asks for a token and clones on the host", async () => {
  setup();
  try {
    const c = fakeContext({ rules: [IMAGE_OK], answers: ["s"] });
    await provisionContainer(c, "agent-x", "o/r");
    assert.ok(!c.calls.some((call) => call.join(" ").includes("gh auth")));
    assert.ok(c.calls.some((call) => call.join(" ").includes("git@github.com:o/r.git")));
    assert.ok(c.err_lines.some((l) => l.includes("git remote add agent-x")));
  } finally { teardown(); }
});

test("forge metadata is recorded after the clone, not before", async () => {
  setup();
  try {
    const c = fakeContext({ rules: [IMAGE_OK], answers: ["s"] });
    await provisionContainer(c, "agent-x", "o/r");
    const flat = c.calls.map((call) => call.join(" "));
    const clone = flat.findIndex((l) => l.includes("git clone"));
    const meta = flat.findIndex((l) => l.includes("user.forge.repo"));
    assert.ok(clone >= 0 && meta > clone, "les métadonnées doivent suivre le clone");
  } finally { teardown(); }
});

test("git-lfs failure aborts provisioning", async () => {
  setup();
  try {
    const c = fakeContext({ rules: [IMAGE_OK, { match: "git lfs install", code: 1 }], answers: ["s"] });
    await assert.rejects(() => provisionContainer(c, "agent-x", "o/r"), /git-lfs setup failed/);
  } finally { teardown(); }
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/provision.test.ts`
Expected: FAIL — cannot find module `../scripts/lib/commands/provision.ts`.

- [ ] **Step 4: Write the implementation**

`scripts/lib/commands/provision.ts`:

```ts
// Provisioning d'un container neuf. C'est la seule commande qui modifie
// l'hôte : elle crée ~/workspaces/<container>, et en mode supervised y clone
// par SSH. Les chemins hôte restent surchargeables par variable
// d'environnement pour que les tests ne touchent jamais un vrai home.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { configSet, execAsAgent } from "../lxd.ts";
import { currentImageCommit } from "../containers.ts";

const home = () => process.env.FORGE_HOME ?? "/home/<user>";
const repoDir = () => process.env.FORGE_REPO_DIR ?? join(home(), "agent-forge");
const workspaces = () => process.env.FORGE_WORKSPACES ?? join(home(), "workspaces");

export async function provisionContainer(ctx: Context, container: string, ownerRepo: string): Promise<void> {
  const credentials = join(home(), ".claude", ".credentials.json");
  if (!existsSync(credentials)) {
    throw new ForgeError(`${credentials} not found. Run 'claude auth login' on the host first.`);
  }
  if ((await ctx.exec(["lxc", "image", "info", "agent-base"])).code !== 0) {
    throw new ForgeError("image agent-base not found. Run 'forge image build' first.");
  }

  ctx.err("Mode for this container?");
  ctx.err("  [a] autonomous — bot pushes commits and opens PRs itself");
  ctx.err("  [s] supervised — no credential; you retrieve and publish the work yourself");
  const choice = (await ctx.prompt.ask("Choice [a/s]")) ?? "a";
  const mode = choice.toLowerCase().startsWith("s") ? "supervised" : "autonomous";

  ctx.out(`Creating container ${container}...`);
  await ctx.exec(["lxc", "launch", "agent-base", container, "--profile", "agent"]);

  // Supprime le compte ubuntu laissé par cloud-init, qui peut avoir un sudo
  // NOPASSWD:ALL.
  ctx.out("Removing cloud-init ubuntu backdoor...");
  await ctx.exec(["lxc", "exec", container, "--", "deluser", "--remove-home", "ubuntu"]);
  await ctx.exec(["lxc", "exec", container, "--", "rm", "-f", "/etc/sudoers.d/90-cloud-init-users"]);

  ctx.out("Mounting workspace...");
  const workspaceDir = join(workspaces(), container);
  mkdirSync(workspaceDir, { recursive: true });
  // raw.idmap dans le profil mappe <user> (1000) vers aiuser (1001) et gère
  // aussi root : pas besoin d'idmap shifting sur ce device.
  await ctx.exec(["lxc", "config", "device", "add", container, "workspace", "disk",
    `source=${workspaceDir}`, "path=/workspace"]);

  ctx.out("Copying signing key...");
  await ctx.exec(["lxc", "file", "push", join(home(), ".ssh", "github_agents_signing"),
    `${container}/home/aiuser/.ssh/id_ed25519_signing`, "--uid", "1001", "--gid", "1001", "--mode", "600"]);

  ctx.out("Configuring git...");
  await execAsAgent(ctx, container, [
    "git config --global user.name 'Claude Agent'",
    "git config --global user.email '<bot>@users.noreply.github.com'",
    "git config --global gpg.format ssh",
    "git config --global user.signingkey /home/aiuser/.ssh/id_ed25519_signing",
    "git config --global commit.gpgsign true",
  ].join(" && "));

  ctx.out("Reusing Claude Code credentials from host...");
  await execAsAgent(ctx, container, "mkdir -p /home/aiuser/.claude");
  await ctx.exec(["lxc", "file", "push", credentials, `${container}/home/aiuser/.claude/.credentials.json`,
    "--uid", "1001", "--gid", "1001", "--mode", "600"]);

  ctx.out("Pre-accepting Claude Code onboarding...");
  await ctx.exec(["lxc", "file", "push", join(repoDir(), "config", "claude-onboarding-state.json"),
    `${container}/home/aiuser/.claude.json`, "--uid", "1001", "--gid", "1001", "--mode", "600"]);

  ctx.out("Updating Claude Code to latest...");
  await ctx.exec(["lxc", "exec", container, "--", "npm", "install", "-g", "@anthropic-ai/claude-code@latest"]);

  ctx.out("Installing Claude plugins...");
  await execAsAgent(ctx, container,
    "claude plugin marketplace add anthropics/claude-plugins-official && claude plugin install superpowers@claude-plugins-official");

  ctx.out("Installing Claude global instructions...");
  await ctx.exec(["lxc", "file", "push", join(repoDir(), "templates", "CLAUDE.md"),
    `${container}/home/aiuser/.claude/CLAUDE.md`, "--uid", "1001", "--gid", "1001", "--mode", "644"]);

  ctx.out("Installing Claude security hooks...");
  await ctx.exec(["lxc", "exec", container, "--", "mkdir", "-p", "/home/aiuser/.claude/hooks"]);
  await ctx.exec(["lxc", "file", "push", join(repoDir(), ".claude", "hooks", "pre-bash.sh"),
    `${container}/home/aiuser/.claude/hooks/pre-bash.sh`, "--uid", "0", "--gid", "0", "--mode", "755"]);
  await ctx.exec(["lxc", "file", "push", join(repoDir(), "config", "claude-container-settings.json"),
    `${container}/home/aiuser/.claude/settings.json`, "--uid", "0", "--gid", "0", "--mode", "644"]);

  ctx.out("Recording forge mode marker...");
  await execAsAgent(ctx, container, `echo '${mode}' > /home/aiuser/.claude/forge-mode`);

  if (mode === "supervised") {
    ctx.out(`Cloning ${ownerRepo} on the host (branch main)...`);
    await ctx.exec(["git", "clone", `git@github.com:${ownerRepo}.git`, workspaceDir]);
  } else {
    ctx.err("");
    ctx.err("==============================================================");
    ctx.err("  GitHub token required (BOT account, fine-grained PAT)");
    ctx.err(`  Scoped to: ${ownerRepo} only`);
    ctx.err("  Permissions: Contents RW, Pull requests RW, Metadata R");
    ctx.err("  The token is piped into the container and never written");
    ctx.err("  to host disk.");
    ctx.err("==============================================================");
    const token = await ctx.prompt.askSecret("Paste the token (input hidden)");
    if (!token) throw new ForgeError("empty token.");

    ctx.out("Authenticating gh inside the container...");
    // Le token passe par stdin, jamais par argv : argv est visible dans ps.
    await ctx.exec(
      ["lxc", "exec", container, "--", "su", "-", "aiuser", "-c", "gh auth login --hostname github.com --with-token"],
      { input: token },
    );
    const status = await execAsAgent(ctx, container, "gh auth status --hostname github.com");
    if (status.code !== 0) throw new ForgeError("the pasted token was rejected by GitHub.");
    await execAsAgent(ctx, container, "gh auth setup-git");

    ctx.out(`Cloning ${ownerRepo} (branch main)...`);
    await execAsAgent(ctx, container, `git clone https://github.com/${ownerRepo}.git /workspace`);
  }

  ctx.out("Configuring git-lfs and ignoring worktrees...");
  const lfs = await execAsAgent(ctx, container,
    "cd /workspace && git lfs install && { grep -qxF '.trees/' .git/info/exclude || echo '.trees/' >> .git/info/exclude; }");
  if (lfs.code !== 0) throw new ForgeError(`git-lfs setup failed in ${container}.`);

  ctx.out("Stamping the image build this container came from...");
  await configSet(ctx, container, "user.forge.image_commit", await currentImageCommit(ctx));

  ctx.out("Recording forge metadata...");
  await configSet(ctx, container, "user.forge.repo", ownerRepo);
  await configSet(ctx, container, "user.forge.mode", mode);

  if (mode === "supervised") {
    ctx.err("");
    ctx.err("Retrieve this container's work from your laptop with:");
    ctx.err(`  git remote add ${container} ssh://<user>@<host>:2222${workspaceDir}`);
  }

  ctx.out(`Container ${container} provisioned.`);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/provision.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
npm run check
git add scripts/lib/context.ts scripts/lib/prompt.ts scripts/lib/commands/provision.ts tests/lib/fake-context.ts tests/provision.test.ts
git commit -m "feat(cli): provisioning d'un container, avec saisie masquée du PAT"
```

---

### Task 14: `forge start` — branch resolution and the task menu

**Files:**
- Create: `scripts/lib/commands/start.ts`, `tests/start.test.ts`

**Interfaces:**
- Consumes: `Context`, `ForgeError`; `sanitizeContainerName`, `validateRepo`, `validateTaskName`, `validateGitRef`; `checkNameCollision`, `containerMode`, `forgeRepos`, `isRunning`; `attachArgv`, `execAsAgent`, `instanceExists`, `startInstance`; `agentBranches`, `branchExists`, `taskNames`; `provisionContainer`.
- Produces: `cmdStart(ctx, repo?: string, task?: string): Promise<number>`.

Resolution order, each case announced so the operator knows what they landed on:

| Situation | Result |
|---|---|
| `.trees/<task>` exists | attach to it — `start` is idempotent |
| a ref was named via `other branch…` | new `agent/<task>` from that ref |
| local `agent/<task>` exists | worktree on it (the case `forge finish` leaves behind) |
| `origin/agent/<task>` exists | new local `agent/<task>` tracking it (an open PR elsewhere) |
| nothing exists | new `agent/<task>` from `origin/main` |

`other branch…` always branches `agent/<task>` from the named ref, never checks the ref out directly: `pre-bash.sh` only lets the agent push to `origin agent/*`, so a worktree on any other branch could commit but never publish.

- [ ] **Step 1: Write the failing test**

`tests/start.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdStart } from "../scripts/lib/commands/start.ts";

const RUNNING = JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Running" }]);

function rules(extra: { match: string; code?: number; stdout?: string }[] = []) {
  return [
    ...extra,
    { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
    { match: "user.forge.mode", stdout: "autonomous" },
    { match: "lxc list", stdout: RUNNING },
    { match: "lxc info", code: 0 },
    { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\n" },
    { match: "test -e /workspace/.trees/", code: 1 },
    { match: "show-ref", code: 1 },
  ];
}
const added = (c: ReturnType<typeof fakeContext>) =>
  c.calls.map((x) => x.join(" ")).find((l) => l.includes("worktree add")) ?? "";

test("an existing worktree is attached, not refused", async () => {
  const c = fakeContext({ rules: rules([{ match: "test -e /workspace/.trees/cli", code: 0 }]) });
  assert.equal(await cmdStart(c, "moroine/agent-forge", "cli"), 0);
  assert.equal(added(c), "", "aucun worktree ne doit être créé");
  assert.ok(c.calls.some((call) => call.includes("tmux")));
});

test("an existing local branch is resumed in a new worktree", async () => {
  const c = fakeContext({ rules: rules([{ match: "show-ref --verify --quiet refs/heads/agent/docs", code: 0 }]) });
  await cmdStart(c, "moroine/agent-forge", "docs");
  assert.ok(added(c).includes("worktree add .trees/docs agent/docs"), added(c));
});

test("a branch that exists only on origin is picked up", async () => {
  const c = fakeContext({ rules: rules([{ match: "show-ref --verify --quiet refs/remotes/origin/agent/api", code: 0 }]) });
  await cmdStart(c, "moroine/agent-forge", "api");
  assert.ok(added(c).includes("worktree add .trees/api -b agent/api origin/agent/api"), added(c));
});

test("with nothing existing, the branch starts from origin/main", async () => {
  const c = fakeContext({ rules: rules() });
  await cmdStart(c, "moroine/agent-forge", "fresh");
  assert.ok(added(c).includes("worktree add .trees/fresh -b agent/fresh origin/main"), added(c));
});

test("main is refreshed before the worktree is created", async () => {
  const c = fakeContext({ rules: rules() });
  await cmdStart(c, "moroine/agent-forge", "fresh");
  const flat = c.calls.map((x) => x.join(" "));
  const fetch = flat.findIndex((l) => l.includes("fetch origin"));
  const add = flat.findIndex((l) => l.includes("worktree add"));
  assert.ok(fetch >= 0 && fetch < add, "le fetch doit précéder la création");
});

test("a supervised container skips the fetch", async () => {
  const c = fakeContext({
    rules: rules().map((r) => (r.match === "user.forge.mode" ? { ...r, stdout: "supervised" } : r)),
  });
  await cmdStart(c, "moroine/agent-forge", "fresh");
  assert.ok(!c.calls.some((call) => call.join(" ").includes("fetch origin")));
});

test("the task menu mixes worktrees, local branches and origin branches", async () => {
  const c = fakeContext({
    rules: rules([
      { match: "for-each-ref --format='%(refname:short)' refs/heads/agent", stdout: "agent/cli\nagent/docs\n" },
      { match: "for-each-ref --format='%(refname:short)' refs/remotes/origin/agent", stdout: "origin/agent/api\n" },
      { match: "show-ref --verify --quiet refs/remotes/origin/agent/api", code: 0 },
    ]),
    answers: [4],
  });
  await cmdStart(c, "moroine/agent-forge", undefined);
  const menu = c.err_lines.join("\n");
  assert.ok(menu.includes("new task"), menu);
  assert.ok(menu.includes("cli (existing worktree — attach)"), menu);
  assert.ok(menu.includes("docs (local branch)"), menu);
  assert.ok(menu.includes("api (branch on origin)"), menu);
  assert.ok(menu.includes("other branch…"), menu);
  assert.ok(added(c).includes("-b agent/api origin/agent/api"), added(c));
});

test("other branch… branches agent/<task> from the named ref", async () => {
  const c = fakeContext({ rules: rules(), answers: [3, "origin/feature/thing", "thing"] });
  await cmdStart(c, "moroine/agent-forge", undefined);
  assert.ok(added(c).includes("worktree add .trees/thing -b agent/thing origin/feature/thing"), added(c));
});

test("other branch… refuses to overwrite an existing agent branch", async () => {
  const c = fakeContext({
    rules: rules([{ match: "show-ref --verify --quiet refs/heads/agent/thing", code: 0 }]),
    answers: [3, "origin/feature/thing", "thing"],
  });
  await assert.rejects(() => cmdStart(c, "moroine/agent-forge", undefined), /already exists/);
});

test("with no TTY, a missing task is a usage error rather than a hang", async () => {
  const c = fakeContext({ rules: rules(), tty: false });
  await assert.rejects(() => cmdStart(c, "moroine/agent-forge", undefined), /Usage: forge start/);
});

test("an invalid ref from the menu is rejected before reaching su -c", async () => {
  const c = fakeContext({ rules: rules(), answers: [3, "--upload-pack=evil", "x"] });
  await assert.rejects(() => cmdStart(c, "moroine/agent-forge", undefined), /must not start with/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/start.test.ts`
Expected: FAIL — cannot find module `../scripts/lib/commands/start.ts`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/commands/start.ts`:

```ts
// forge start [<owner/repo>] [<task>]
//
// La branche de la tâche est *résolue* au lieu de partir systématiquement de
// origin/main : c'est ce qui permet de reprendre une tâche existante — branche
// laissée par `forge finish`, ou branche déjà poussée depuis un autre
// container, typiquement une PR ouverte.
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { sanitizeContainerName, validateGitRef, validateRepo, validateTaskName } from "../validate.ts";
import { checkNameCollision, containerMode, forgeRepos, isRunning } from "../containers.ts";
import { attachArgv, execAsAgent, instanceExists, startInstance } from "../lxd.ts";
import { agentBranches, branchExists, taskNames } from "../worktrees.ts";
import { provisionContainer } from "./provision.ts";

const USAGE = "Usage: forge start <owner/repo> [<task>]";

type Choice = { task: string; ref: string };

export async function cmdStart(ctx: Context, repo?: string, task?: string): Promise<number> {
  const ownerRepo = await startResolveRepo(ctx, repo);
  validateRepo(ownerRepo);

  const container = sanitizeContainerName(ownerRepo);
  await checkNameCollision(ctx, container, ownerRepo);

  let taskName = task ?? "";
  let ref = "";

  if (!(await instanceExists(ctx, container))) {
    // Un container neuf n'a ni worktree ni branche à proposer : le menu
    // n'aurait rien à montrer, on demande simplement un nom.
    if (!taskName) {
      const asked = await ctx.prompt.ask("New task name");
      if (!asked) throw new ForgeError(USAGE);
      taskName = asked;
    }
    validateTaskName(taskName);
    await provisionContainer(ctx, container, ownerRepo);
  }

  ctx.out(`Starting container ${container}...`);
  if (!(await isRunning(ctx, container))) await startInstance(ctx, container);

  // Avant le menu, pas après : les branches d'origin qu'il propose doivent
  // être à jour.
  await refreshMain(ctx, container);

  if (!taskName) {
    const choice = await pickStartTask(ctx, container);
    taskName = choice.task;
    ref = choice.ref;
  }

  validateTaskName(taskName);
  if (ref) validateGitRef(ref);

  await addWorktree(ctx, container, taskName, ref);

  ctx.out(`Attaching to ${container} session '${taskName}' as aiuser...`);
  return ctx.attach(attachArgv(container, taskName, process.env.TERM ?? "xterm-256color"));
}

// Comme resolveRepo, mais avec une entrée de plus : `forge start` est la seule
// commande qui peut travailler sur un repo pas encore provisionné.
async function startResolveRepo(ctx: Context, repo?: string): Promise<string> {
  if (repo) return repo;
  const repos = await forgeRepos(ctx);
  if (repos.length === 0) {
    throw new ForgeError("no forge container yet. Name the repo: forge start <owner/repo> <task>.");
  }
  const idx = await ctx.prompt.pick("Repo", [...repos, "other repo…"]);
  if (idx === null) throw new ForgeError(USAGE);
  if (idx > repos.length) {
    const typed = await ctx.prompt.ask("owner/repo");
    if (!typed) throw new ForgeError(USAGE);
    return typed;
  }
  return repos[idx - 1];
}

// Un container supervised n'a aucune credential pour joindre origin : on reste
// sur les refs déjà connues localement.
async function refreshMain(ctx: Context, container: string): Promise<void> {
  if ((await containerMode(ctx, container)) === "supervised") {
    ctx.err("Supervised container: skipping origin fetch (no credential); working from the last-known origin refs.");
    return;
  }
  ctx.out("Refreshing main...");
  await execAsAgent(ctx, container,
    "git -C /workspace fetch origin && git -C /workspace merge --ff-only origin/main");
}

// Menu mélangeant worktrees déjà là, branches agent/* sans worktree (locales
// ou seulement sur origin), plus "new task" et "other branch…".
async function pickStartTask(ctx: Context, container: string): Promise<Choice> {
  const labels: string[] = ["new task"];
  const values: string[] = ["new"];
  const seen = new Set<string>();

  for (const name of await taskNames(ctx, container)) {
    seen.add(name);
    labels.push(`${name} (existing worktree — attach)`);
    values.push(`task:${name}`);
  }
  for (const name of await agentBranches(ctx, container, "refs/heads/agent")) {
    if (seen.has(name)) continue;
    seen.add(name);
    labels.push(`${name} (local branch)`);
    values.push(`task:${name}`);
  }
  for (const name of await agentBranches(ctx, container, "refs/remotes/origin/agent")) {
    if (seen.has(name)) continue;
    seen.add(name);
    labels.push(`${name} (branch on origin)`);
    values.push(`task:${name}`);
  }
  labels.push("other branch…");
  values.push("other");

  const idx = await ctx.prompt.pick("Task", labels);
  if (idx === null) throw new ForgeError(USAGE);
  const value = values[idx - 1];

  if (value === "new") {
    const name = await ctx.prompt.ask("New task name");
    if (!name) throw new ForgeError(USAGE);
    return { task: name, ref: "" };
  }
  if (value === "other") {
    // La branche de départ peut être quelconque, mais on travaille toujours
    // sur agent/<task> : le hook pre-bash.sh n'autorise le push que là.
    const namedRef = await ctx.prompt.ask("Ref");
    if (!namedRef) throw new ForgeError(USAGE);
    const name = await ctx.prompt.ask("New task name");
    if (!name) throw new ForgeError(USAGE);
    return { task: name, ref: namedRef };
  }
  return { task: value.slice("task:".length), ref: "" };
}

async function addWorktree(ctx: Context, container: string, task: string, ref: string): Promise<void> {
  if ((await execAsAgent(ctx, container, `test -e /workspace/.trees/${task}`)).code === 0) {
    ctx.out(`Worktree .trees/${task} is already there — attaching to it.`);
    return;
  }

  if (ref) {
    if (await branchExists(ctx, container, `refs/heads/agent/${task}`)) {
      throw new ForgeError(
        `branch agent/${task} already exists; pick another task name so its history isn't overwritten.`,
      );
    }
    ctx.out(`Creating worktree .trees/${task} on a new agent/${task} from ${ref}...`);
    await execAsAgent(ctx, container, `git -C /workspace worktree add .trees/${task} -b agent/${task} ${ref}`);
    return;
  }

  if (await branchExists(ctx, container, `refs/heads/agent/${task}`)) {
    ctx.out(`Resuming the existing local branch agent/${task} in .trees/${task}...`);
    await execAsAgent(ctx, container, `git -C /workspace worktree add .trees/${task} agent/${task}`);
    return;
  }

  if (await branchExists(ctx, container, `refs/remotes/origin/agent/${task}`)) {
    ctx.out(`Resuming agent/${task} from origin in .trees/${task}...`);
    await execAsAgent(ctx, container,
      `git -C /workspace worktree add .trees/${task} -b agent/${task} origin/agent/${task}`);
    return;
  }

  ctx.out(`Creating worktree .trees/${task} on a new agent/${task} from origin/main...`);
  await execAsAgent(ctx, container,
    `git -C /workspace worktree add .trees/${task} -b agent/${task} origin/main`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/start.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
npm run check
git add scripts/lib/commands/start.ts tests/start.test.ts
git commit -m "feat(cli): forge start, avec résolution de branche et menu de tâches"
```

---

### Task 15: Entry point, `forge image`, and the end-to-end harness

**Files:**
- Create: `scripts/forge.ts`, `scripts/lib/commands/image.ts`, `tests/lib/fake-lxc.ts`, `tests/e2e.test.ts`
- Modify: `scripts/lib/forge-image.sh` (make it standalone)

**Interfaces:**
- Consumes: every `cmd*` function from Tasks 9–14.
- Produces: `cmdImage(ctx, sub: string | undefined): Promise<number>`; the executable entry `scripts/forge.ts`.

`forge-image.sh` stays bash but was *sourced* alongside `forge-common.sh`, which is about to be deleted. It uses exactly one thing from it — `FORGE_REPO_DIR` — so making it standalone means adding a shebang, a default for that variable, and a call to its own dispatch at the bottom. The retained `tests/test-forge-image.sh` must still pass afterwards.

- [ ] **Step 1: Make `forge-image.sh` standalone**

Add at the top of `scripts/lib/forge-image.sh`, before `cmd_forge_image()`:

```bash
#!/bin/bash
set -e

# Ce script reste en bash (voir la spec, Non-goals) mais n'est plus sourcé par
# un dispatcher bash : il s'exécute seul, appelé par commands/image.ts.
# FORGE_REPO_DIR était sa seule dépendance à forge-common.sh.
FORGE_REPO_DIR="${FORGE_REPO_DIR:-/home/moroine/agent-forge}"
```

And at the very bottom of the file:

```bash
cmd_forge_image "$@"
```

Then: `chmod +x scripts/lib/forge-image.sh`

- [ ] **Step 2: Write the failing test**

`tests/e2e.test.ts`:

```ts
// Bout-en-bout : le VRAI binaire, avec un faux lxc sur le PATH. Prouve le
// câblage que les tests unitaires ne voient pas — parsing d'argv, dispatch,
// codes de sortie, et la séparation stdout/stderr.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let bin: string;
const ENTRY = resolve("scripts/forge.ts");

before(() => {
  bin = mkdtempSync(join(tmpdir(), "forge-e2e-bin-"));
  const stub = resolve("tests/lib/fake-lxc.ts");
  writeFileSync(join(bin, "lxc"), `#!/bin/sh\nexec node ${stub} "$@"\n`);
  chmodSync(join(bin, "lxc"), 0o755);
});

after(() => rmSync(bin, { recursive: true, force: true }));

function forge(args: string[], input = "") {
  return spawnSync("node", [ENTRY, ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

test("no argument prints the usage and exits 0", () => {
  const r = forge([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: forge <command>/);
});

test("an unknown command exits 1 with Error: on stderr", () => {
  const r = forge(["frobnicate"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: unknown command 'frobnicate'/m);
  assert.equal(r.stdout, "");
});

test("list renders the table on stdout", () => {
  const r = forge(["list"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^REPO\s+MODE\s+STATE\s+BUILD$/m);
  assert.match(r.stdout, /moroine\/agent-forge/);
});

test("completion repos is machine-readable, one per line", () => {
  const r = forge(["completion", "repos"]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.trim().split("\n"), ["moroine/agent-forge", "acme/widgets"]);
});

test("--force is accepted in any position", () => {
  const first = forge(["stop", "--force", "moroine/agent-forge"]);
  const last = forge(["stop", "moroine/agent-forge", "--force"]);
  assert.equal(first.status, 0);
  assert.equal(last.status, 0);
});

test("a missing argument with no TTY prints the usage instead of hanging", () => {
  const r = forge(["resume"], "1\n");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: forge resume/);
});

test("an unknown option fails cleanly rather than crashing", () => {
  const r = forge(["list", "--nope"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: /m);
});

test("image without a subcommand fails with its usage", () => {
  const r = forge(["image"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: forge image build\|update/);
});
```

`tests/lib/fake-lxc.ts` — plain JS with a shebang, because a file named `lxc` on the `PATH` gets no `.ts` extension and so would not be type-stripped:

```js
// Faux `lxc` pour les tests bout-en-bout. Les réponses de `list` et de
// `config get` viennent de tests/fixtures/ quand le fichier existe : ce sont
// des captures d'un vrai LXD (voir Task 17, mode --capture), pas du JSON
// inventé.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");

const DEFAULT_LIST = [
  { name: "agent-moroine-agent-forge", status: "Running" },
  { name: "agent-acme-widgets", status: "Stopped" },
];

function listJson() {
  const f = join(fixtures, "lxc-list.json");
  return existsSync(f) ? readFileSync(f, "utf8") : JSON.stringify(DEFAULT_LIST);
}

const REPOS = {
  "agent-moroine-agent-forge": "moroine/agent-forge",
  "agent-acme-widgets": "acme/widgets",
};
const MODES = {
  "agent-moroine-agent-forge": "autonomous",
  "agent-acme-widgets": "supervised",
};

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;

if (cmd === "list") {
  process.stdout.write(listJson());
  process.exit(0);
}

if (cmd === "config" && rest[0] === "get") {
  const [, name, key] = rest;
  if (key === "user.forge.repo") process.stdout.write((REPOS[name] ?? "") + "\n");
  else if (key === "user.forge.mode") process.stdout.write((MODES[name] ?? "") + "\n");
  else process.stdout.write("\n");
  process.exit(0);
}

if (cmd === "info") process.exit(REPOS[rest[0]] ? 0 : 1);
if (cmd === "image") { process.stdout.write("aaaa1111\n"); process.exit(0); }

// exec : les sondes répondent « rien à signaler », ce qui suffit au câblage.
if (cmd === "exec") {
  const script = argv[argv.indexOf("--") + 5] ?? "";   // exec name -- su - aiuser -c <script>
  if (script.includes("worktree list")) {
    process.stdout.write("worktree /workspace\nworktree /workspace/.trees/cli\n");
  }
  process.exit(0);
}

process.exit(0);
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/e2e.test.ts`
Expected: FAIL — `scripts/forge.ts` does not exist.

- [ ] **Step 4: Write the implementation**

`scripts/lib/commands/image.ts`:

```ts
// forge image build|update — délègue au script bash conservé. Voir les
// Non-goals de la spec : forge-image.sh est une séquence de provisioning shell
// envoyée dans un container ; en TypeScript elle deviendrait des template
// strings du même shell, sans gain de lisibilité.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";

export async function cmdImage(ctx: Context, sub: string | undefined): Promise<number> {
  if (sub !== "build" && sub !== "update") {
    throw new ForgeError("Usage: forge image build|update");
  }
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "forge-image.sh");
  // attach, pas exec : le build est long et sa sortie doit défiler en direct.
  return ctx.attach(["bash", script, sub]);
}
```

`scripts/forge.ts`:

```ts
// Point d'entrée : argv vers une commande, et une seule place où les erreurs
// deviennent un message et un code de sortie.
import { parseArgs } from "node:util";
import type { Context } from "./lib/context.ts";
import { createContext, ForgeError } from "./lib/context.ts";
import { cmdStart } from "./lib/commands/start.ts";
import { cmdResume } from "./lib/commands/resume.ts";
import { cmdFinish } from "./lib/commands/finish.ts";
import { cmdStop } from "./lib/commands/stop.ts";
import { cmdDelete } from "./lib/commands/delete.ts";
import { cmdList } from "./lib/commands/list.ts";
import { cmdImage } from "./lib/commands/image.ts";
import { cmdCompletion } from "./lib/commands/completion.ts";

const USAGE = `Usage: forge <command> [args]

Commands:
  start [<owner/repo>] [<task>]     Provision (if needed) and start/attach a task session
  resume [<owner/repo>] [<task>]    Re-attach an existing task's session
  finish [<owner/repo>] [<task>]    Remove a finished task's worktree
  stop [<owner/repo>] [--force]     Stop a container (blocked on dirty/unpushed WIP unless --force)
  delete [<owner/repo>] [--force]   Delete a container (blocked on dirty/unpushed WIP unless --force)
  list                              Show all containers: repo, mode, state, build
  image build|update                Rebuild the agent-base image (only affects new containers)
  completion bash                   Print a bash completion function (eval it in ~/.bashrc)
  completion repos                  List managed owner/repo, one per line (machine-readable)
  completion tasks <owner/repo>     List a repo's task names, one per line (machine-readable)

A bracketed argument is asked for when you leave it out, as a numbered menu.
With no terminal on stdin (scripts, CI) nothing is asked and the command
exits with this usage instead.`;

function dispatch(ctx: Context, positionals: string[], force: boolean): Promise<number> {
  const [cmd, a, b] = positionals;
  switch (cmd) {
    case "start": return cmdStart(ctx, a, b);
    case "resume": return cmdResume(ctx, a, b);
    case "finish": return cmdFinish(ctx, a, b, force);
    case "stop": return cmdStop(ctx, a, force);
    case "delete": return cmdDelete(ctx, a, force);
    case "list": return cmdList(ctx);
    case "image": return cmdImage(ctx, a);
    case "completion": return cmdCompletion(ctx, a, b);
    default: throw new ForgeError(`unknown command '${cmd}'\n${USAGE}`);
  }
}

async function main(): Promise<number> {
  const ctx = createContext();
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: { force: { type: "boolean" }, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
    });
    if (values.help || positionals.length === 0) {
      ctx.out(USAGE);
      return 0;
    }
    return await dispatch(ctx, positionals, values.force === true);
  } catch (e) {
    // Le préfixe "Error: " est ajouté ici, une seule fois : une ForgeError ne
    // porte que son message.
    ctx.err(`Error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

process.exit(await main());
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/e2e.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm run test:unit && npm run test:contract && npm run check`
Expected: everything green.

- [ ] **Step 7: Commit**

```bash
git add scripts/forge.ts scripts/lib/commands/image.ts scripts/lib/forge-image.sh tests/lib/fake-lxc.ts tests/e2e.test.ts
git commit -m "feat(cli): point d'entrée TypeScript, forge image, et tests bout-en-bout"
```

---

### Task 16: Switch the shim and delete the bash CLI

**Files:**
- Rewrite: `scripts/forge` (becomes the shim)
- Delete: `scripts/lib/forge-{common,completion,delete,finish,list,resume,start,stop}.sh`, `tests/test-forge-{common,completion,delete,dispatcher,finish,list,resume,start,stop}.sh`, `tests/lib/fake-lxc.sh`
- Modify: `tests/e2e.test.ts` (one assertion on the shim)

**Interfaces:**
- Consumes: `scripts/forge.ts` from Task 15.
- Produces: nothing new; this is the cutover.

The shim keeps the invocation `./scripts/forge` identical everywhere — README, the `forge` alias, the completion function — because type stripping keys off the `.ts` extension, so a file named `forge` would not be processed.

- [ ] **Step 1: Add the failing assertion**

Append to `tests/e2e.test.ts`:

```ts
test("the bash shim runs the TypeScript entry", () => {
  const r = spawnSync(resolve("scripts/forge"), ["list"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^REPO\s+MODE\s+STATE\s+BUILD$/m);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/e2e.test.ts`
Expected: FAIL — `scripts/forge` is still the old bash dispatcher and will not find its sourced libs, or will not behave as the new CLI.

- [ ] **Step 3: Replace the shim**

`scripts/forge`:

```bash
#!/bin/bash
# Le type-stripping de Node se déclenche sur l'extension .ts : un fichier nommé
# `forge` ne serait pas traité. Ce shim garde donc la commande inchangée.
exec node "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/forge.ts" "$@"
```

Then: `chmod +x scripts/forge`

- [ ] **Step 4: Delete the bash CLI and its tests**

```bash
git rm scripts/lib/forge-common.sh scripts/lib/forge-completion.sh \
       scripts/lib/forge-delete.sh scripts/lib/forge-finish.sh \
       scripts/lib/forge-list.sh scripts/lib/forge-resume.sh \
       scripts/lib/forge-start.sh scripts/lib/forge-stop.sh
git rm tests/test-forge-common.sh tests/test-forge-completion.sh \
       tests/test-forge-delete.sh tests/test-forge-dispatcher.sh \
       tests/test-forge-finish.sh tests/test-forge-list.sh \
       tests/test-forge-resume.sh tests/test-forge-start.sh \
       tests/test-forge-stop.sh tests/lib/fake-lxc.sh
```

`tests/test-forge-image.sh`, `tests/test-pre-bash.sh`, `tests/test-claude-*.sh`, `tests/test-lxd-agent-profile.sh` and `tests/test-readme-docs.sh` all stay: they cover bash and config files that are staying.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run check`
Expected: unit, contract, e2e and the retained bash tests all green. If `test-forge-image.sh` fails, it is asserting on something the Task 15 standalone conversion changed — fix the assertion to match the new shape, not by reverting the conversion.

- [ ] **Step 6: Commit**

```bash
git add scripts/forge tests/e2e.test.ts
git commit -m "refactor(cli): bascule sur le CLI TypeScript, suppression du bash"
```

---

### Task 17: Real-LXD integration test, run on the host

**Files:**
- Create: `tests/integration/lxd.test.ts`, `tests/fixtures/.gitkeep`

**Interfaces:**
- Consumes: `scripts/forge` (the shim) and the real `lxc`.
- Produces: `npm run test:integration`, and the fixtures replayed by `tests/lib/fake-lxc.ts`.

**Run the operator probe at the top of this plan first.** This task builds on `LXD_CONF`; if the probe shows it is not honoured, thread an explicit `--project` option through `lxd.ts` instead and adjust this test accordingly.

Isolation comes from an LXD project, not from a naming convention: instances in another project do not appear in the default project's `lxc list`, so a stray left by a killed run can never pollute `forge list`, and `lxc project delete` refuses to run while anything is left inside — the check is LXD's, not the test's.

- [ ] **Step 1: Write the test**

There is no red/green cycle here: the test exercises an environment this container does not have. It is written once, then run on the host.

`tests/integration/lxd.test.ts`:

```ts
// Couche 3 : le VRAI lxc, sur l'hôte LXD, en opt-in.
//
//   FORGE_INTEGRATION=1 npm run test:integration
//   FORGE_INTEGRATION=1 npm run test:integration -- --capture
//
// Un échec ici signifie que le faux a dérivé du réel : les assertions
// impriment donc la commande et sa sortie BRUTES, pour être collées telles
// quelles dans une discussion de design.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENABLED = process.env.FORGE_INTEGRATION === "1";
const CAPTURE = process.argv.includes("--capture");
const PROJECT = "forge-selftest";
const SENTINEL = "forge-selftest/throwaway";

let conf: string;
let container: string;

function lxc(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("lxc", args, { encoding: "utf8", env: { ...process.env, ...env } });
}
// Le CLI est dirigé vers le projet de test par un LXD_CONF isolé. Jamais
// `lxc project switch` : cela changerait le projet courant de l'opérateur.
const inProject = (args: string[]) => lxc(args, { LXD_CONF: conf });

function raw(label: string, r: { status: number | null; stdout: string; stderr: string }) {
  return `${label}\n  exit=${r.status}\n  stdout=${JSON.stringify(r.stdout)}\n  stderr=${JSON.stringify(r.stderr)}`;
}

before((t) => {
  if (!ENABLED) return t.skip("set FORGE_INTEGRATION=1 to run against a real LXD host");

  const probe = lxc(["--version"]);
  assert.equal(probe.status, 0, raw("no usable lxc client", probe));

  // Projet dédié. features.images=false hérite des images du projet par
  // défaut, donc agent-base reste visible sans copie.
  lxc(["project", "delete", PROJECT]);            // résidu d'un run tué
  const created = lxc(["project", "create", PROJECT,
    "-c", "features.images=false", "-c", "features.profiles=false"]);
  assert.equal(created.status, 0, raw("could not create the test project", created));

  conf = mkdtempSync(join(tmpdir(), "forge-lxdconf-"));
  const real = join(process.env.HOME ?? "", ".config", "lxc");
  if (real) cpSync(real, conf, { recursive: true, errorOnExist: false, force: true });
  lxc(["project", "switch", PROJECT], { LXD_CONF: conf });   // dans la copie isolée

  container = `agent-forge-selftest-${Math.random().toString(36).slice(2, 8)}`;
  // init, jamais start : ni réseau, ni cgroups, ni PAT, ni GitHub.
  const init = inProject(["init", "agent-base", container]);
  assert.equal(init.status, 0, raw("lxc init agent-base failed", init));
  inProject(["config", "set", container, "user.forge.repo", SENTINEL]);
  inProject(["config", "set", container, "user.forge.mode", "supervised"]);
});

after(() => {
  if (!ENABLED) return;
  // Double garde : le préfixe de nom ET la sentinelle doivent correspondre.
  const repo = inProject(["config", "get", container, "user.forge.repo"]).stdout.trim();
  if (container.startsWith("agent-forge-selftest-") && repo === SENTINEL) {
    inProject(["delete", container, "--force"]);
  }
  // `project delete` refuse de partir s'il reste quoi que ce soit dedans :
  // c'est LXD qui vérifie, pas nous.
  const removed = lxc(["project", "delete", PROJECT]);
  if (removed.status !== 0) {
    console.error(raw(`WARNING: project ${PROJECT} not deleted — inspect it`, removed));
  }
  rmSync(conf, { recursive: true, force: true });
});

function forge(args: string[]) {
  return spawnSync(resolve("scripts/forge"), args, {
    encoding: "utf8",
    env: { ...process.env, LXD_CONF: conf },
  });
}

test("lxc list -f json still has the name and status fields the CLI reads", { skip: !ENABLED }, () => {
  const r = inProject(["list", "-f", "json"]);
  assert.equal(r.status, 0, raw("lxc list failed", r));
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed), raw("lxc list is not an array", r));
  const mine = parsed.find((i: { name: string }) => i.name === container);
  assert.ok(mine, raw(`${container} missing from lxc list`, r));
  assert.equal(typeof mine.status, "string", raw("status is not a string", r));
  if (CAPTURE) {
    mkdirSync(resolve("tests/fixtures"), { recursive: true });
    writeFileSync(resolve("tests/fixtures/lxc-list.json"), r.stdout);
  }
});

test("forge list shows the throwaway container", { skip: !ENABLED }, () => {
  const r = forge(["list"]);
  assert.equal(r.status, 0, raw("forge list failed", r));
  assert.match(r.stdout, /^REPO\s+MODE\s+STATE\s+BUILD$/m);
  assert.ok(r.stdout.includes(SENTINEL), raw("sentinel repo not listed", r));
});

test("forge completion repos lists it, one per line", { skip: !ENABLED }, () => {
  const r = forge(["completion", "repos"]);
  assert.equal(r.status, 0, raw("completion repos failed", r));
  assert.ok(r.stdout.split("\n").includes(SENTINEL), raw("sentinel repo missing", r));
});

test("forge completion tasks on a stopped container prints nothing and succeeds", { skip: !ENABLED }, () => {
  const r = forge(["completion", "tasks", SENTINEL]);
  assert.equal(r.status, 0, raw("completion tasks failed", r));
  assert.equal(r.stdout.trim(), "", raw("expected no tasks", r));
});

test("config get returns the stamped value, and empty for an unset key", { skip: !ENABLED }, () => {
  const set = inProject(["config", "get", container, "user.forge.repo"]);
  assert.equal(set.stdout.trim(), SENTINEL, raw("unexpected repo stamp", set));
  const unset = inProject(["config", "get", container, "user.forge.nonexistent"]);
  assert.equal(unset.stdout.trim(), "", raw("an unset key should be empty", unset));
  if (CAPTURE) {
    mkdirSync(resolve("tests/fixtures"), { recursive: true });
    writeFileSync(resolve("tests/fixtures/lxc-config-get.txt"), set.stdout);
  }
});
```

- [ ] **Step 2: Verify it skips cleanly without the opt-in**

Run: `npm run test:integration`
Expected: every test reported as skipped, exit 0, and **no LXD call made**. This is what keeps `npm test` green on a machine with no LXD.

- [ ] **Step 3: Ask the operator to run it on the host**

```bash
git fetch origin agent/cli && git checkout agent/cli
FORGE_INTEGRATION=1 npm run test:integration
```

No `npm install` is needed: the script is `node --test` over a file importing nothing outside `node:`. If it fails, the raw command output in the failure message is the useful artefact — it means a fake has drifted from reality, and the fix belongs in the fake or the parser, not in the assertion.

- [ ] **Step 4: Capture the fixtures and commit them**

Once the run is green on the host:

```bash
FORGE_INTEGRATION=1 npm run test:integration -- --capture
git add tests/fixtures/
```

- [ ] **Step 5: Commit**

```bash
git add tests/integration/lxd.test.ts
git commit -m "test(cli): intégration LXD réelle sur l'hôte, isolée par projet LXD"
```

---

### Task 18: README

**Files:**
- Modify: `README.md`
- Test: `tests/test-readme-docs.sh` (retained bash test, must stay green)

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Update the prerequisites**

In `## Prerequisites`, add:

```markdown
- Node.js 24+ on the host (the `forge` CLI is TypeScript, run directly by Node's
  type stripping — no build step, no `npm install`). Node is separately installed
  *inside* the agent image; this entry is about the host.
```

- [ ] **Step 2: Replace the "Bash completion" section body**

The mechanism is unchanged for the user; only its source changed. Keep the `alias` + `eval` snippet as-is and update the closing paragraph to say the completion is fed by `forge completion repos` / `forge completion tasks <owner/repo>` — which it already did after PR #14, so verify rather than rewrite.

- [ ] **Step 3: Add a short "Developing the CLI" section**

Place it after "Bash completion":

```markdown
### Developing the CLI

The CLI lives in `scripts/forge.ts` and `scripts/lib/`, written in TypeScript
and executed directly by Node — there is no build step and no runtime
dependency, which is why the host needs nothing but Node itself.

```bash
npm install          # development only: typescript + @types/node
npm test             # unit + contract (real git/tmux) + the retained bash tests
npm run check        # tsc --noEmit — Node strips types without checking them
```

`npm run check` is not optional in spirit: Node erases type annotations without
verifying them, so `tsc` is what makes the types mean anything.

Two things stay in bash on purpose: `scripts/lib/forge-image.sh`, which is a
sequence of provisioning shell piped into a container, and
`.claude/hooks/pre-bash.sh`, a container-side security control that must stay
auditable and independent of the container's Node install.

A third test layer runs against a real LXD and is opt-in, because it needs the
host:

```bash
FORGE_INTEGRATION=1 npm run test:integration
```

It creates a throwaway container inside a dedicated `forge-selftest` LXD
project — instances in another project never appear in `forge list` — and
deletes it again. Its `--capture` mode refreshes `tests/fixtures/`, which is
what keeps the faked `lxc` in the other layers honest.
```

- [ ] **Step 4: Verify the docs test still passes**

Run: `bash tests/test-readme-docs.sh`
Expected: PASS. It asserts on documented command names and phrases; if a phrase it greps for has moved, update the README to keep the documented behaviour described, rather than deleting the assertion.

- [ ] **Step 5: Run the full suite one last time**

Run: `npm test && npm run check`
Expected: everything green.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: prérequis Node 24 et section développement du CLI"
```

---

## Opening the pull request

All the work sits on `agent/cli`, which also carries the four bash commits from
the closed PR #14 and the two spec commits. The cumulative diff reads as
"bash CLI → TypeScript CLI": files added then deleted along the way (the old
`tests/lib/fake-lxc.sh`, for instance) do not appear at all.

```bash
git push origin agent/cli
gh pr create --base main --title "refactor(cli): réécriture du CLI forge en TypeScript"
```

The PR description should lead with the three decisions a reviewer cannot infer
from the diff: zero runtime dependencies (nothing installed on the host that
handles the bot PAT), Node 24+ as a new host prerequisite, and the three-layer
test strategy with the one layer that only the operator can run.
