// A real on-disk git layout for the laptop commands, and a Context that runs
// real commands except ssh and gh.
//
//   github.git  bare repository standing for GitHub
//   container   repository standing for the container's /workspace
//   clone       the developer's clone, origin -> github.git
//
// Importing this file isolates every git call of the test process from the
// developer's own configuration (signing, hooks, aliases): an empty global
// config, no system config, and no GIT_AUTHOR_*/GIT_COMMITTER_* identity from
// the environment (CI sets one; it would override each repository's own).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createContext } from "../../cli/lib/context.ts";
import { fakeContext, type ExecRule, type FakeContext } from "./fake-context.ts";

const emptyConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "forge-gitcfg-")), "gitconfig");
fs.writeFileSync(emptyConfig, "");
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
for (const who of ["AUTHOR", "COMMITTER"]) {
  for (const field of ["NAME", "EMAIL", "DATE"]) delete process.env[`GIT_${who}_${field}`];
}

export const git = (repo: string, ...args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const identify = (repo: string) => {
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
};

export type Layout = {
  root: string;
  github: string;
  container: string;
  clone: string;
  // Commits `files` (one commit each) on `branch` of `repo`, creating the
  // branch from main when it does not exist; returns the last commit.
  commit(repo: string, branch: string, ...files: string[]): string;
  cleanup(): void;
};

export function createLayout(containerName: string, ownerRepo = "acme/widgets"): Layout {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-layout-")));
  const github = path.join(root, "github.git");
  const container = path.join(root, "container");
  const clone = path.join(root, "clone");
  const quiet = ["-q"];

  execFileSync("git", ["init", "--bare", "-b", "main", ...quiet, github]);
  const seed = path.join(root, "seed");
  execFileSync("git", ["init", "-b", "main", ...quiet, seed]);
  identify(seed);
  fs.writeFileSync(path.join(seed, "README"), "seed\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", github, "main");

  // Both clones come from the bare repository. The developer's origin is then
  // given its GitHub address, which insteadOf maps back to the bare repository.
  for (const dir of [container, clone]) {
    execFileSync("git", ["clone", ...quiet, github, dir], { stdio: "ignore" });
    identify(dir);
  }
  git(clone, "remote", "set-url", "origin", `git@github.com:${ownerRepo}.git`);
  git(clone, "config", `url.${github}.insteadOf`, `git@github.com:${ownerRepo}.git`);

  // git spawns ssh itself, not through ctx.exec: the clone's own core.sshCommand
  // ignores the host and the options and, for `forge upload-pack <c> …`, serves
  // the container repository. The real remote.<c>.url and .uploadpack are used.
  const script = path.join(root, "fake-ssh");
  fs.writeFileSync(script, [
    "#!/bin/sh",
    'for a; do last="$a"; done',
    'case "$last" in',
    `  "forge upload-pack ${containerName}"*) exec git upload-pack '${container}' ;;`,
    "esac",
    'echo "fake-ssh: unexpected command: $last" >&2',
    "exit 1",
    "",
  ].join("\n"));
  fs.chmodSync(script, 0o755);
  git(clone, "config", "core.sshCommand", script);

  let n = 0;
  return {
    root, github, container, clone,
    commit(repo, branch, ...files) {
      const exists = (() => { try { git(repo, "rev-parse", "-q", "--verify", `refs/heads/${branch}`); return true; } catch { return false; } })();
      git(repo, "checkout", "-q", ...(exists ? [branch] : ["-b", branch, "main"]));
      for (const f of files) {
        fs.writeFileSync(path.join(repo, f), `${f} ${++n}\n`);
        git(repo, "add", f);
        git(repo, "commit", "-q", "-m", `add ${f}`);
      }
      const sha = git(repo, "rev-parse", "HEAD");
      git(repo, "checkout", "-q", "main");
      return sha;
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

// Real exec, and attach run through exec (its output is captured), except ssh and gh: those are answered from `rules`
// (first substring match wins) and recorded, like fakeContext.
export function hybridContext(opts: { rules?: ExecRule[]; answers?: (number | string | null)[] } = {}): FakeContext {
  const ctx = fakeContext(opts);
  const real = createContext();
  const scripted = (argv: string[]) => argv[0] === "ssh" || argv[0] === "gh";
  const fakeExec = ctx.exec;
  const fakeAttach = ctx.attach;
  ctx.exec = (argv, o) => {
    if (scripted(argv)) return fakeExec(argv, o);
    ctx.calls.push(argv);
    ctx.execOptions.push(o);
    return real.exec(argv, o);
  };
  ctx.attach = (argv, o) => {
    if (scripted(argv)) return fakeAttach(argv, o);
    ctx.calls.push(argv);
    // Captured, not inherited: a failing git command must not spill onto the
    // test output. The exit code is what attach reports either way.
    return real.exec(argv, o).then((r) => r.code);
  };
  return ctx;
}
