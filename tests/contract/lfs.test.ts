// Layer 2: real git and git-lfs, in a temporary HOME. The container's
// workspace is cloned from a mirror that holds no LFS object; the two
// `git lfs install` commands forge runs must leave LFS files as pointers, so
// that `git worktree add` (what a task's worktree needs) succeeds.
// Skipped when git-lfs is absent, except under CI where it fails.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LFS_FILTERS_INSTALL, LFS_HOOKS_INSTALL } from "../../cli/lib/commands/provision.ts";

const present = spawnSync("git", ["lfs", "version"], { stdio: "ignore" }).status === 0;
const skip = !present && process.env.CI !== "true";

let root = "";
let mirror = "";

// Every call runs with the temporary HOME and global config: `git lfs install`
// writes there, never in the developer's own config. No inherited GIT_*
// variable survives (GIT_CONFIG_GLOBAL, GIT_LFS_SKIP_SMUDGE...), the identity
// is a dummy one and the locale is fixed for the expected error message.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) => {
  const home = join(root, "home");
  return execFileSync(cmd, args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), LC_ALL: "C",
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "forge test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "forge test", GIT_COMMITTER_EMAIL: "test@example.invalid",
      ...env,
    },
  });
};
const git = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) =>
  run("git", ["-c", "commit.gpgsign=false", ...args], cwd, env);
const sh = (command: string, cwd: string) => run("sh", ["-c", command], cwd);

// A workspace provisioned in forge's order (provision.ts): clone with the
// smudge skipped (mirror.ts), then the global filters, then the repository's
// hooks.
function workspace(name: string, filters: string, hooks: string): string {
  rmSync(join(root, "home"), { recursive: true, force: true });
  mkdirSync(join(root, "home"));
  const ws = join(root, name);
  git(["clone", "-q", "--no-local", mirror, ws], root, { GIT_LFS_SKIP_SMUDGE: "1" });
  sh(filters, root);
  sh(hooks, ws);
  return ws;
}

before(() => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), "forge-lfs-"));
  mkdirSync(join(root, "home"));
  run("git", ["lfs", "install", "--skip-repo"], root);

  // A source repository with one LFS file, then a bare mirror of it: the
  // mirror gets the pointer, never the LFS object, as on the forge host.
  const source = join(root, "source");
  mkdirSync(source);
  git(["init", "-q", "-b", "main", "."], source);
  git(["lfs", "track", "*.bin"], source);
  writeFileSync(join(source, "seed.bin"), "binary content\n");
  git(["add", ".gitattributes", "seed.bin"], source);
  git(["commit", "-q", "-m", "seed"], source);
  mirror = join(root, "mirror.git");
  git(["clone", "-q", "--bare", "--no-local", source, mirror], root, { GIT_LFS_SKIP_SMUDGE: "1" });
  rmSync(source, { recursive: true, force: true });
});

after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

const POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1/;
const addTask = (ws: string) => git(["worktree", "add", "-q", ".trees/t", "-b", "agent/t", "origin/main"], ws);

test("git worktree add succeeds on an LFS repository, the file stays a pointer", { skip }, () => {
  const ws = workspace("ws", LFS_FILTERS_INSTALL, LFS_HOOKS_INSTALL);
  addTask(ws);
  assert.match(readFileSync(join(ws, ".trees", "t", "seed.bin"), "utf8"), POINTER);
});

// Each command alone keeps the pointers: the second rewrites the global
// filters, so testing them only together would hide a first one without
// --skip-smudge.
test("the filters install alone keeps LFS files as pointers", { skip }, () => {
  const ws = workspace("ws-filters", LFS_FILTERS_INSTALL, "true");
  addTask(ws);
  assert.match(readFileSync(join(ws, ".trees", "t", "seed.bin"), "utf8"), POINTER);
});

test("the hooks install alone, after plain filters, keeps LFS files as pointers", { skip }, () => {
  const ws = workspace("ws-hooks", "git lfs install --skip-repo", LFS_HOOKS_INSTALL);
  addTask(ws);
  assert.match(readFileSync(join(ws, ".trees", "t", "seed.bin"), "utf8"), POINTER);
});

test("without --skip-smudge, the same worktree add fails (control)", { skip }, () => {
  const ws = workspace("ws-control", "git lfs install --skip-repo", "git lfs install");
  assert.throws(() => addTask(ws), /smudge filter lfs failed/);
});
