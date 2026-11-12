import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdFetch } from "../cli/lib/commands/fetch.ts";
import { saveHost, type LaptopHost } from "../cli/lib/laptop/state.ts";
import type { ExecRule, FakeContext } from "./lib/fake-context.ts";
import { createLayout, git, hybridContext, type Layout } from "./lib/git-layout.ts";

// The host answers `forge team for-repo` with the team the layout stands for.
const teamContext = (opts: { rules?: ExecRule[] } = {}) =>
  hybridContext({ ...opts, rules: [{ match: "'forge' 'team' 'for-repo'", stdout: "web\n" }, ...(opts.rules ?? [])] });

const T = "web";
// The clone's remote for the team.
const C = "forge-web";
const ENV = ["FORGE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "FORGE_SSH_DIR", "LIMA_HOME"];
const saved: Record<string, string | undefined> = {};
let tmp: string;
let layout: Layout;

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = mkdtempSync(join(tmpdir(), "forge-fetch-"));
  process.env.FORGE_HOME = tmp;
  layout = createLayout(T);
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
  layout.cleanup();
});

const host = (name: string): LaptopHost => ({
  name, kind: "remote", address: "203.0.113.10", port: 22, user: "alice", admin: "ubuntu",
  adminKey: "/keys/admin", exposure: "public", done: [],
});

const taskBase = (stdout: string) => ({ match: `'forge' 'team' 'task-base' '${T}'`, stdout });
// The task listing, without the lines about the remote and the fetches.
const listing = (ctx: FakeContext) => ctx.out_lines.filter((l) => !l.endsWith("…") && !/^(Added|Fixed) remote /.test(l));
const warning = (name: string) =>
  `WARNING: tag ${name} hides the branch ${name} in git commands: delete it (git tag -d ${name}) unless you made it`;

test("the first fetch adds the forge remote, says so, and lists the tasks", async () => {
  saveHost(host("forge-local"));
  layout.commit(layout.container, "agent/login", "a.txt", "b.txt");
  layout.commit(layout.container, "agent/docs", "c.txt");
  const ctx = teamContext({ rules: [taskBase("docs\torigin/main\nlogin\torigin/main\n")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.equal(git(layout.clone, "config", `remote.${C}.url`), `forge-local:team-${T}`);
  assert.deepEqual(ctx.out_lines, [
    `Added remote ${C} (forge-local:team-${T}) to this clone.`,
    `Fetching ${C}…`,
    "Fetching origin…",
    "agent/docs  1 commits on origin/main",
    "agent/login  2 commits on origin/main",
  ]);
  // Fetched again, the remote is as it should be: nothing to say about it.
  const again = teamContext({ rules: [taskBase("docs\torigin/main\nlogin\torigin/main\n")] });
  assert.equal(await cmdFetch(again, { cwd: layout.clone }), 0);
  assert.equal(again.out_lines[0], `Fetching ${C}…`);
});

test("a task with a shipped commit and a new one says 1 not shipped", async () => {
  saveHost(host("forge-local"));
  const first = layout.commit(layout.container, "agent/login", "a.txt");
  layout.commit(layout.container, "agent/login", "b.txt");
  // The first commit reached GitHub as origin/agent/login.
  git(layout.container, "push", "-q", layout.github, `${first}:refs/heads/agent/login`);
  const ctx = teamContext({ rules: [taskBase("login\torigin/main\n")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.deepEqual(listing(ctx), ["agent/login  2 commits on origin/main, 1 not shipped"]);
});

test("a single-branch clone still gets GitHub's agent branches", async () => {
  saveHost(host("forge-local"));
  git(layout.clone, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
  const first = layout.commit(layout.container, "agent/login", "a.txt");
  layout.commit(layout.container, "agent/login", "b.txt");
  git(layout.container, "push", "-q", layout.github, `${first}:refs/heads/agent/login`);
  const ctx = teamContext({ rules: [taskBase("login\torigin/main\n")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.equal(git(layout.clone, "rev-parse", "refs/remotes/origin/agent/login"), first);
  assert.deepEqual(listing(ctx), ["agent/login  2 commits on origin/main, 1 not shipped"]);
  // Deleted on GitHub (merged, say), it is pruned like any other.
  git(layout.github, "update-ref", "-d", "refs/heads/agent/login");
  assert.equal(await cmdFetch(teamContext({ rules: [taskBase("login\torigin/main\n")] }), { cwd: layout.clone }), 0);
  assert.throws(() => git(layout.clone, "rev-parse", "-q", "--verify", "refs/remotes/origin/agent/login"));
  assert.equal(git(layout.clone, "config", "--get-all", "remote.origin.fetch"), "+refs/heads/main:refs/remotes/origin/main");
});

test("a task without a recorded base is assumed to start from main", async () => {
  saveHost(host("forge-local"));
  layout.commit(layout.container, "agent/login", "a.txt");
  const ctx = teamContext({ rules: [taskBase("")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.deepEqual(listing(ctx), ["agent/login  1 commits on main (assumed)"]);
});

test("a tag or SHA base is listed as ship reads it: main, assumed", async () => {
  saveHost(host("forge-local"));
  layout.commit(layout.container, "agent/login", "a.txt");
  layout.commit(layout.container, "agent/docs", "b.txt");
  const ctx = teamContext({ rules: [taskBase("docs\t0123abcd\nlogin\tv1.0\n")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.deepEqual(listing(ctx), [
    "agent/docs  1 commits on main (assumed, started from 0123abcd)",
    "agent/login  1 commits on main (assumed, started from v1.0)",
  ]);
});

test("without origin/main, a task with no recorded base reads as main's base gone", async () => {
  saveHost(host("forge-local"));
  layout.commit(layout.container, "agent/login", "a.txt");
  git(layout.clone, "update-ref", "-d", "refs/remotes/origin/main");
  git(layout.clone, "config", "remote.origin.fetch", "+refs/heads/agent/*:refs/remotes/origin/agent/*");
  const ctx = teamContext({ rules: [taskBase("")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.deepEqual(listing(ctx), ["agent/login  base main (assumed) is gone"]);
});

test("a base that is another agent branch counts against that branch", async () => {
  saveHost(host("forge-local"));
  layout.commit(layout.container, "agent/first", "a.txt");
  git(layout.container, "branch", "agent/second", "agent/first");
  layout.commit(layout.container, "agent/second", "b.txt");
  const ctx = teamContext({ rules: [taskBase("second\tagent/first\n")] });
  await cmdFetch(ctx, { cwd: layout.clone });
  assert.deepEqual(listing(ctx), [
    "agent/first  1 commits on main (assumed)",
    "agent/second  1 commits on agent/first",
  ]);
});

test("the host of the clone's forge remote is used without asking", async () => {
  saveHost(host("forge-a"));
  saveHost(host("forge-b"));
  git(layout.clone, "remote", "add", C, `forge-b:team-${T}`);
  layout.commit(layout.container, "agent/login", "a.txt");
  const ctx = teamContext({ rules: [taskBase("login\torigin/main\n")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.ok(!ctx.err_lines.some((l) => l.startsWith("Host>")), "no host question");
  const ssh = ctx.calls.find((c) => c[0] === "ssh");
  assert.ok(ssh?.includes("forge-b"));
  // A remote added by hand lacks uploadpack and tagOpt: fixed, and said.
  assert.equal(ctx.out_lines[0], `Fixed remote ${C} (forge-b:team-${T}) in this clone.`);
  assert.equal(listing(ctx).length, 1);
});

test("a base that no longer exists is reported and the other tasks still list", async () => {
  saveHost(host("forge-local"));
  layout.commit(layout.container, "agent/login", "a.txt");
  layout.commit(layout.container, "agent/docs", "b.txt");
  const ctx = teamContext({ rules: [taskBase("docs\torigin/main\nlogin\torigin/gone-branch\n")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.deepEqual(listing(ctx), [
    "agent/docs  1 commits on origin/main",
    "agent/login  base origin/gone-branch is gone",
  ]);
});

test("--host wins over the clone's remote, which is repointed", async () => {
  saveHost(host("forge-a"));
  saveHost(host("forge-b"));
  git(layout.clone, "remote", "add", C, `forge-a:team-${T}`);
  const ctx = teamContext({ rules: [taskBase("")] });
  assert.equal(await cmdFetch(ctx, { host: "forge-b", cwd: layout.clone }), 0);
  assert.equal(git(layout.clone, "config", `remote.${C}.url`), `forge-b:team-${T}`);
  assert.ok(ctx.calls.find((c) => c[0] === "ssh")?.includes("forge-b"));
  assert.ok(ctx.out_lines.includes(`Fixed remote ${C} (forge-b:team-${T}) in this clone.`));
});

test("a remote host that hosts.json does not list falls back to the only host", async () => {
  saveHost(host("forge-b"));
  git(layout.clone, "remote", "add", C, `forge-old:team-${T}`);
  const ctx = teamContext({ rules: [taskBase("")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.ok(!ctx.err_lines.some((l) => l.startsWith("Host>")), "no host question");
  assert.equal(git(layout.clone, "config", `remote.${C}.url`), `forge-b:team-${T}`);
});

test("the container's tags stay out of the clone", async () => {
  saveHost(host("forge-local"));
  const sha = layout.commit(layout.container, "agent/login", "a.txt");
  for (const name of ["origin/main", "v9"]) git(layout.container, "tag", name, sha);
  const ctx = teamContext({ rules: [taskBase("login\torigin/main\n")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.equal(git(layout.clone, "tag", "-l"), "");
  assert.equal(git(layout.clone, "config", `remote.${C}.tagOpt`), "--no-tags");
  assert.deepEqual(listing(ctx), ["agent/login  1 commits on origin/main"]);
});

test("tags of the clone that hide the refs fetch reads are warned about, and change nothing", async () => {
  saveHost(host("forge-local"));
  layout.commit(layout.container, "agent/login", "a.txt");
  // Brought by a fetch from before forge set tagOpt, say.
  const seed = git(layout.clone, "rev-parse", "HEAD");
  // refs/remotes/…: a full name stands in for its ref wherever that ref is missing.
  for (const name of ["origin/main", `${C}/agent/login`, "main", "v1.0", "refs/remotes/origin/agent/login"]) {
    git(layout.clone, "tag", name, seed);
  }
  const ctx = teamContext({ rules: [taskBase("login\torigin/main\n")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.deepEqual(ctx.err_lines.filter((l) => l.startsWith("WARNING")),
    [warning(`${C}/agent/login`), warning("main"), warning("origin/main"), warning("refs/remotes/origin/agent/login")]);
  assert.deepEqual(listing(ctx), ["agent/login  1 commits on origin/main"]);
});

test("with the developer's fetch.pruneTags, no container tag arrives and the clone's own tags stay", async () => {
  saveHost(host("forge-local"));
  // A usual pair in a developer's ~/.gitconfig.
  git(layout.clone, "config", "fetch.prune", "true");
  git(layout.clone, "config", "fetch.pruneTags", "true");
  git(layout.clone, "tag", "dev-own-tag", "HEAD");
  const sha = layout.commit(layout.container, "agent/login", "a.txt");
  for (const name of ["origin/main", "main", "v9"]) git(layout.container, "tag", name, sha);
  const ctx = teamContext({ rules: [taskBase("login\torigin/main\n")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.equal(git(layout.clone, "tag", "-l"), "dev-own-tag");
  assert.equal(git(layout.clone, "config", `remote.${C}.pruneTags`), "false");
  assert.deepEqual(listing(ctx), ["agent/login  1 commits on origin/main"]);
});

test("a container without agent branches says so", async () => {
  saveHost(host("forge-local"));
  const ctx = teamContext({ rules: [taskBase("")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.deepEqual(listing(ctx), ["no agent branches yet"]);
});

// U+009B is the 8-bit CSI: git accepts it in a ref name, a terminal reads it as an escape.
const CSI = "\u009b";

test("a task name with a C1 control is not listed raw: it is reported once, filtered", async () => {
  saveHost(host("forge-local"));
  layout.commit(layout.container, "agent/login", "a.txt");
  layout.commit(layout.container, `agent/evil${CSI}31m`, "b.txt");
  const ctx = teamContext({ rules: [taskBase("login\torigin/main\n")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.deepEqual(listing(ctx), [
    "skipped an agent branch whose task name is not [A-Za-z0-9._-]: agent/evil31m",
    "agent/login  1 commits on origin/main",
  ]);
  assert.ok(![...ctx.out_lines, ...ctx.err_lines].some((l) => l.includes(CSI)));
});

test("a tag with a C1 control is warned about without the control", async () => {
  saveHost(host("forge-local"));
  layout.commit(layout.container, "agent/login", "a.txt");
  git(layout.clone, "tag", `origin/x${CSI}31m`, git(layout.clone, "rev-parse", "HEAD"));
  const ctx = teamContext({ rules: [taskBase("login\torigin/main\n")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.ok(![...ctx.out_lines, ...ctx.err_lines].some((l) => l.includes(CSI)));
  assert.deepEqual(ctx.err_lines.filter((l) => l.startsWith("WARNING")),
    ["WARNING: tag origin/x31m hides the branch origin/x31m in git commands: delete it with git tag -d, unless you made it (its name holds control characters)"]);
});

test("a host with no team for the repository is named, with the repository, before git is asked anything", async () => {
  saveHost(host("forge-local"));
  const ctx = hybridContext({ rules: [{ match: "'forge' 'team' 'for-repo'", code: 1 }] });
  await assert.rejects(cmdFetch(ctx, { cwd: layout.clone }), /forge-local has no team for acme\/widgets/);
  assert.ok(!ctx.calls.some((c) => c[0] === "git" && c.includes("fetch")));
});

test("a single-agent remote from before teams stays in the clone and is said", async () => {
  saveHost(host("forge-local"));
  git(layout.clone, "remote", "add", "agent-acme-widgets", "forge-local:agent-acme-widgets");
  const ctx = teamContext({ rules: [taskBase("")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.ok(ctx.out_lines.includes("Remote agent-acme-widgets is a single-agent remote, no longer fetched: left in place."));
  assert.equal(git(layout.clone, "config", "remote.agent-acme-widgets.url"), "forge-local:agent-acme-widgets");
});
