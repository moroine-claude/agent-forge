// Layer 2: real git. The team mirror takes from a developer's container only
// the branches that developer owns, never runs a hook of the mirror, and
// follows a rebased branch (forced update). No Incus: a stand-in for forge
// answers `upload-pack` with the "container" repository.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "../../cli/lib/context.ts";
import { fakeContext } from "../lib/fake-context.ts";
import { FakeIncus } from "../lib/fake-incus.ts";
import { parseConfig } from "../../cli/lib/config.ts";
import { teamMirrorPath } from "../../cli/lib/mirror.ts";
import { refreshTeamMirror } from "../../cli/lib/team-mirror.ts";

let root: string;
const git = (args: string[], cwd: string) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd, encoding: "utf8" }).trim();

before(() => {
  root = mkdtempSync(join(tmpdir(), "forge-team-mirror-"));
  process.env.FORGE_MIRRORS = join(root, "mirrors");
  process.env.FORGE_WORKSPACES = join(root, "workspaces");
});
after(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.FORGE_MIRRORS;
  delete process.env.FORGE_WORKSPACES;
  delete process.env.FORGE_INVOKED_AS;
});

test("only the owned branches arrive, no hook of the mirror runs, a rewritten branch replaces the old one", async () => {
  // The developer's repository, with the owned branch and one it does not own.
  const container = join(root, "container");
  mkdirSync(container);
  git(["init", "-q", "-b", "main", "."], container);
  git(["commit", "-q", "--allow-empty", "-m", "base"], container);
  for (const b of ["agent/fix-login", "agent/other"]) {
    git(["checkout", "-q", "-b", b, "main"], container);
    git(["commit", "-q", "--allow-empty", "-m", b], container);
  }

  // Stand-in for forge: whatever it is asked, it serves the developer's repository.
  const stub = join(root, "forge");
  writeFileSync(stub, `#!/bin/sh\nexec git-upload-pack '${container}'\n`);
  chmodSync(stub, 0o755);
  process.env.FORGE_INVOKED_AS = stub;

  // A mirror that already exists, with a planted hook and no hooksPath of its
  // own: only the fetch's own core.hooksPath keeps the hook from running.
  const mirror = teamMirrorPath("web");
  mkdirSync(mirror, { recursive: true });
  git(["init", "--bare", "-q", mirror], root);
  const marker = join(root, "hook-ran");
  const hook = join(mirror, "hooks", "reference-transaction");
  mkdirSync(join(mirror, "hooks"), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(hook, 0o755);

  const cfg = parseConfig("/c.json", { teams: { web: { repo: "o/web", roles: { dev: { count: 1, capabilities: ["repo", "publish"] } } } } });
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-web-dev-1", { status: "Running", config: { "user.forge.base.fix-login": "origin/main" } });
  const ctx = fakeContext({ incus: fake });
  const real = createContext();
  const scripted = ctx.exec;
  ctx.exec = (argv, o) => (argv[0] === "git" ? real.exec(argv, o) : scripted(argv, o));

  const out = await refreshTeamMirror(ctx, cfg, "web");
  assert.deepEqual(out, { fetched: ["agent-web-dev-1"], failed: [] });
  const branches = git(["for-each-ref", "--format=%(refname)", "refs/heads"], mirror).split("\n");
  assert.deepEqual(branches, ["refs/heads/agent/fix-login"]);
  assert.equal(existsSync(marker), false, "a hook of the mirror ran on the host");

  // The developer rewrites the branch: the mirror follows.
  git(["checkout", "-q", "agent/fix-login"], container);
  git(["commit", "-q", "--amend", "--allow-empty", "-m", "rewritten"], container);
  const rewritten = git(["rev-parse", "agent/fix-login"], container);
  await refreshTeamMirror(ctx, cfg, "web");
  assert.equal(git(["rev-parse", "refs/heads/agent/fix-login"], mirror), rewritten);
});
