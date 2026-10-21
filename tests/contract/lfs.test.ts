// Layer 2: real git and git-lfs, in a temporary HOME. The container's
// workspace is cloned from a mirror that holds no LFS object; the two
// `git lfs install` commands forge runs must leave LFS files as pointers, so
// that `git worktree add` (what `forge start` runs for a task) succeeds.
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

// Every call runs with the temporary HOME: `git lfs install` writes the
// global config there, never in the developer's own ~/.gitconfig.
const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) =>
  execFileSync(cmd, args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home", ".config"),
      GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
const git = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) =>
  run("git", ["-c", "commit.gpgsign=false", ...args], cwd, env);
const sh = (command: string, cwd: string) => run("sh", ["-c", command], cwd);

// A workspace provisioned the way forge does it: global filters, clone with
// the smudge skipped (mirror.ts), then the repository's hooks.
function workspace(name: string, filters: string, hooks: string): string {
  rmSync(join(root, "home"), { recursive: true, force: true });
  mkdirSync(join(root, "home"));
  sh(filters, root);
  const ws = join(root, name);
  git(["clone", "-q", "--no-local", mirror, ws], root, { GIT_LFS_SKIP_SMUDGE: "1" });
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

test("git worktree add succeeds on an LFS repository, the file stays a pointer", { skip }, () => {
  const ws = workspace("ws", LFS_FILTERS_INSTALL, LFS_HOOKS_INSTALL);
  git(["worktree", "add", "-q", ".trees/t", "-b", "agent/t", "origin/main"], ws);
  const content = readFileSync(join(ws, ".trees", "t", "seed.bin"), "utf8");
  assert.match(content, /^version https:\/\/git-lfs\.github\.com\/spec\/v1/);
});

test("without --skip-smudge, the same worktree add fails (control)", { skip }, () => {
  const ws = workspace("ws-control", "git lfs install --skip-repo", "git lfs install");
  assert.throws(() => git(["worktree", "add", "-q", ".trees/t", "-b", "agent/t", "origin/main"], ws),
    /smudge filter lfs failed/);
});
