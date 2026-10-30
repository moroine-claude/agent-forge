import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdFetch } from "../cli/lib/commands/fetch.ts";
import { saveHost, type LaptopHost } from "../cli/lib/laptop/state.ts";
import { createLayout, git, hybridContext, type Layout } from "./lib/git-layout.ts";

const C = "agent-acme-widgets";
const ENV = ["FORGE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "FORGE_SSH_DIR", "LIMA_HOME"];
const saved: Record<string, string | undefined> = {};
let tmp: string;
let layout: Layout;

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = mkdtempSync(join(tmpdir(), "forge-fetch-"));
  process.env.FORGE_HOME = tmp;
  layout = createLayout(C);
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

const taskBase = (stdout: string) => ({ match: `'forge' 'task-base' '${C}'`, stdout });

test("the first fetch adds the forge remote and lists the tasks", async () => {
  saveHost(host("forge-local"));
  layout.commit(layout.container, "agent/login", "a.txt", "b.txt");
  layout.commit(layout.container, "agent/docs", "c.txt");
  const ctx = hybridContext({ rules: [taskBase("docs\torigin/main\nlogin\torigin/main\n")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.equal(git(layout.clone, "config", `remote.${C}.url`), `forge-local:${C}`);
  assert.deepEqual(ctx.out_lines, [
    "agent/docs  1 commits on origin/main",
    "agent/login  2 commits on origin/main",
  ]);
});

test("a task with a shipped commit and a new one says 1 not shipped", async () => {
  saveHost(host("forge-local"));
  const first = layout.commit(layout.container, "agent/login", "a.txt");
  layout.commit(layout.container, "agent/login", "b.txt");
  // The first commit reached GitHub as origin/agent/login.
  git(layout.container, "push", "-q", layout.github, `${first}:refs/heads/agent/login`);
  const ctx = hybridContext({ rules: [taskBase("login\torigin/main\n")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.deepEqual(ctx.out_lines, ["agent/login  2 commits on origin/main, 1 not shipped"]);
});

test("a task without a recorded base is assumed to start from main", async () => {
  saveHost(host("forge-local"));
  layout.commit(layout.container, "agent/login", "a.txt");
  const ctx = hybridContext({ rules: [taskBase("")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.deepEqual(ctx.out_lines, ["agent/login  1 commits on main (assumed)"]);
});

test("a base that is another agent branch counts against that branch", async () => {
  saveHost(host("forge-local"));
  layout.commit(layout.container, "agent/first", "a.txt");
  git(layout.container, "branch", "agent/second", "agent/first");
  layout.commit(layout.container, "agent/second", "b.txt");
  const ctx = hybridContext({ rules: [taskBase("second\tagent/first\n")] });
  await cmdFetch(ctx, { cwd: layout.clone });
  assert.deepEqual(ctx.out_lines, [
    "agent/first  1 commits on main (assumed)",
    "agent/second  1 commits on agent/first",
  ]);
});

test("the host of the clone's forge remote is used without asking", async () => {
  saveHost(host("forge-a"));
  saveHost(host("forge-b"));
  git(layout.clone, "remote", "add", C, `forge-b:${C}`);
  layout.commit(layout.container, "agent/login", "a.txt");
  const ctx = hybridContext({ rules: [taskBase("login\torigin/main\n")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.ok(!ctx.err_lines.some((l) => l.startsWith("Host>")), "no host question");
  const ssh = ctx.calls.find((c) => c[0] === "ssh");
  assert.ok(ssh?.includes("forge-b"));
  assert.equal(ctx.out_lines.length, 1);
});

test("a base that no longer exists is reported and the other tasks still list", async () => {
  saveHost(host("forge-local"));
  layout.commit(layout.container, "agent/login", "a.txt");
  layout.commit(layout.container, "agent/docs", "b.txt");
  const ctx = hybridContext({ rules: [taskBase("docs\torigin/main\nlogin\torigin/gone-branch\n")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.deepEqual(ctx.out_lines, [
    "agent/docs  1 commits on origin/main",
    "agent/login  base origin/gone-branch is gone",
  ]);
});

test("--host wins over the clone's remote, which is repointed", async () => {
  saveHost(host("forge-a"));
  saveHost(host("forge-b"));
  git(layout.clone, "remote", "add", C, `forge-a:${C}`);
  const ctx = hybridContext({ rules: [taskBase("")] });
  assert.equal(await cmdFetch(ctx, { host: "forge-b", cwd: layout.clone }), 0);
  assert.equal(git(layout.clone, "config", `remote.${C}.url`), `forge-b:${C}`);
  assert.ok(ctx.calls.find((c) => c[0] === "ssh")?.includes("forge-b"));
});

test("a remote host that hosts.json does not list falls back to the only host", async () => {
  saveHost(host("forge-b"));
  git(layout.clone, "remote", "add", C, `forge-old:${C}`);
  const ctx = hybridContext({ rules: [taskBase("")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.ok(!ctx.err_lines.some((l) => l.startsWith("Host>")), "no host question");
  assert.equal(git(layout.clone, "config", `remote.${C}.url`), `forge-b:${C}`);
});

test("a container without agent branches says so", async () => {
  saveHost(host("forge-local"));
  const ctx = hybridContext({ rules: [taskBase("")] });
  assert.equal(await cmdFetch(ctx, { cwd: layout.clone }), 0);
  assert.deepEqual(ctx.out_lines, ["no agent branches yet"]);
});
