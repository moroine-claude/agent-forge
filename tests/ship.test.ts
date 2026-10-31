import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ForgeError } from "../cli/lib/context.ts";
import { cmdShip } from "../cli/lib/commands/ship.ts";
import { saveHost } from "../cli/lib/laptop/state.ts";
import type { ExecRule, FakeContext } from "./lib/fake-context.ts";
import { createLayout, git, hybridContext, type Layout } from "./lib/git-layout.ts";

const C = "agent-acme-widgets";
const OR = "acme/widgets";
const ENV = ["FORGE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "FORGE_SSH_DIR", "LIMA_HOME"];
const saved: Record<string, string | undefined> = {};
let tmp: string;
let layout: Layout;

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-ship-test-"));
  process.env.FORGE_HOME = tmp;
  saveHost({
    name: "forge-local", kind: "remote", address: "203.0.113.10", port: 22, user: "alice", admin: "ubuntu",
    adminKey: "/keys/admin", exposure: "public", done: [],
  });
  layout = createLayout(C, OR);
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(tmp, { recursive: true, force: true });
  layout.cleanup();
});

const url = (n: number) => `https://github.com/${OR}/pull/${n}`;
const taskBase = (stdout: string): ExecRule => ({ match: `'forge' 'task-base' '${C}'`, stdout });
// gh's answer for the PRs of `branch`; none by default (an unmatched gh call prints nothing).
const prs = (branch: string, ...list: [string, string][]): ExecRule => ({
  match: `gh pr list --repo ${OR} --head ${branch} --state`,
  stdout: JSON.stringify(list.map(([u, state]) => ({ url: u, state }))),
});
// The PR gh creates for `branch` against `base`: any other base gets no URL, and ensurePr fails.
const creates = (base: string, branch: string, u: string): ExecRule => ({
  match: `gh pr create --repo ${OR} --base ${base} --head ${branch} --title`,
  stdout: `Creating pull request for ${branch} into ${base} in ${OR}\n\n${u}\n`,
});

const ship = (ctx: FakeContext, task?: string) => cmdShip(ctx, task, { cwd: layout.clone, sign: false });
const onGithub = (branch: string): string | null => {
  try { return git(layout.github, "rev-parse", "-q", "--verify", `refs/heads/${branch}`); } catch { return null; }
};
const pushes = (ctx: FakeContext) => ctx.calls.filter((c) => c[0] === "git" && c.includes("push")).map((c) => c.at(-1));
const ran = (ctx: FakeContext, word: string) => ctx.calls.some((c) => c.includes(word));
const snapshot = () => ({
  head: git(layout.clone, "rev-parse", "HEAD"),
  branch: git(layout.clone, "symbolic-ref", "-q", "HEAD"),
  status: git(layout.clone, "status", "--porcelain"),
  worktrees: git(layout.clone, "worktree", "list"),
});

// A on main, B on A, C on B, in the container.
function chain(...tasks: [string, ...string[]][]) {
  let below = "main";
  for (const [task, ...files] of tasks) {
    git(layout.container, "branch", `agent/${task}`, below);
    layout.commit(layout.container, `agent/${task}`, ...files);
    below = `agent/${task}`;
  }
}

// Someone else commits `file` on GitHub's `branch`.
function pushElsewhere(branch: string, file: string, text: string) {
  const other = path.join(layout.root, "other");
  if (!fs.existsSync(other)) {
    execFileSync("git", ["clone", "-q", layout.github, other], { stdio: "ignore" });
    git(other, "config", "user.name", "Other");
    git(other, "config", "user.email", "other@example.com");
  }
  git(other, "fetch", "-q", "origin");
  git(other, "checkout", "-q", "-B", branch, `origin/${branch}`);
  fs.writeFileSync(path.join(other, file), text);
  git(other, "add", file);
  git(other, "commit", "-q", "-m", `other ${file}`);
  git(other, "push", "-q", "origin", branch);
}

// The task's PR was squash-merged into main on GitHub, and its branch deleted.
function squashMerged(task: string) {
  git(layout.container, "merge", "-q", "--squash", `agent/${task}`);
  git(layout.container, "commit", "-q", "-m", `squash ${task}`);
  git(layout.container, "push", "-q", "origin", "main");
}

test("one task: pushed, its PR created against main", async () => {
  layout.commit(layout.container, "agent/t", "a.txt", "b.txt");
  const ctx = hybridContext({ rules: [taskBase("t\torigin/main\n"), creates("main", "agent/t", url(1))] });
  assert.equal(await ship(ctx, "t"), 0);
  assert.deepEqual(ctx.out_lines, [
    "Signing 2 commits: t (2)",
    `agent/t: pushed 2 commits, created PR ${url(1)}`,
  ]);
  assert.equal(git(layout.github, "rev-list", "--count", "main..agent/t"), "2");
  // gh is checked before anything else, the fetch and SSH included.
  assert.deepEqual(ctx.calls[0], ["gh", "--version"]);
});

test("gh missing stops before any fetch", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  const ctx = hybridContext({ rules: [{ match: "gh --version", code: 127 }] });
  await assert.rejects(ship(ctx, "t"), (e: unknown) => e instanceof ForgeError && /install the GitHub CLI/.test(e.message));
  assert.deepEqual(ctx.calls, [["gh", "--version"]]);
});

test("a chain A <- B <- C shipped from C pushes A, B, C in order and stacks the PRs", async () => {
  chain(["a", "a.txt"], ["b", "b1.txt", "b2.txt"], ["c", "c.txt"]);
  const ctx = hybridContext({ rules: [
    taskBase("a\torigin/main\nb\tagent/a\nc\tagent/b\n"),
    creates("main", "agent/a", url(1)), creates("agent/a", "agent/b", url(2)), creates("agent/b", "agent/c", url(3)),
  ] });
  assert.equal(await ship(ctx, "c"), 0);
  assert.deepEqual(ctx.out_lines, [
    "Signing 4 commits: a (1), b (2), c (1)",
    `agent/a: pushed 1 commit, created PR ${url(1)}`,
    `agent/b: pushed 2 commits, created PR ${url(2)}`,
    `agent/c: pushed 1 commit, created PR ${url(3)}`,
  ]);
  assert.deepEqual(pushes(ctx), ["HEAD:refs/heads/agent/a", "HEAD:refs/heads/agent/b", "HEAD:refs/heads/agent/c"]);
  // Each GitHub branch sits on the one below: A's commits reach GitHub once, through agent/a.
  const gh = (ref: string) => git(layout.github, "rev-parse", ref);
  assert.equal(gh("agent/a~1"), gh("main"));
  assert.equal(gh("agent/b~2"), gh("agent/a"));
  assert.equal(gh("agent/c~1"), gh("agent/b"));
});

test("a clone that fetches only main still stacks the chain", async () => {
  // A push then updates no origin/agent/* ref by itself: ship fetches it for the task above.
  git(layout.clone, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
  chain(["a", "a.txt"], ["b", "b.txt"]);
  const ctx = hybridContext({ rules: [
    taskBase("a\torigin/main\nb\tagent/a\n"), creates("main", "agent/a", url(1)), creates("agent/a", "agent/b", url(2)),
  ] });
  assert.equal(await ship(ctx, "b"), 0);
  assert.deepEqual(ctx.out_lines.slice(1), [
    `agent/a: pushed 1 commit, created PR ${url(1)}`,
    `agent/b: pushed 1 commit, created PR ${url(2)}`,
  ]);
  assert.equal(git(layout.github, "rev-parse", "agent/b~1"), git(layout.github, "rev-parse", "agent/a"));
});

test("re-running right after signs nothing, pushes nothing and finds the PRs", async () => {
  chain(["a", "a.txt"], ["b", "b.txt"]);
  const bases = taskBase("a\torigin/main\nb\tagent/a\n");
  await ship(hybridContext({ rules: [bases, creates("main", "agent/a", url(1)), creates("agent/a", "agent/b", url(2))] }), "b");
  const before = [onGithub("agent/a"), onGithub("agent/b")];
  const ctx = hybridContext({ rules: [bases, prs("agent/a", [url(1), "OPEN"]), prs("agent/b", [url(2), "OPEN"])] });
  assert.equal(await ship(ctx, "b"), 0);
  assert.deepEqual(ctx.out_lines, [
    "Nothing new to sign.",
    `agent/a: nothing new, existing PR ${url(1)}`,
    `agent/b: nothing new, existing PR ${url(2)}`,
  ]);
  assert.deepEqual(pushes(ctx), []);
  assert.ok(!ran(ctx, "cherry-pick") && !ran(ctx, "create"));
  assert.deepEqual([onGithub("agent/a"), onGithub("agent/b")], before);
});

test("a conflict in the second task leaves the first one shipped and cleans up", async () => {
  layout.commit(layout.container, "agent/a", "a1.txt");
  git(layout.container, "push", "-q", "origin", "agent/a");
  // On GitHub, someone adds the b.txt that the agent's B adds as well.
  pushElsewhere("agent/a", "b.txt", "outside\n");
  layout.commit(layout.container, "agent/a", "a2.txt");
  git(layout.container, "branch", "agent/b", "agent/a");
  layout.commit(layout.container, "agent/b", "b.txt");
  const ctx = hybridContext({ rules: [taskBase("a\torigin/main\nb\tagent/a\n"), prs("agent/a", [url(1), "OPEN"])] });
  const before = snapshot();
  await assert.rejects(ship(ctx, "b"), (e: unknown) =>
    e instanceof ForgeError && /^agent\/b: replaying [0-9a-f]{7,} add b\.txt onto origin\/agent\/a stopped/.test(e.message));
  assert.deepEqual(ctx.out_lines, ["Signing 2 commits: a (1), b (1)", `agent/a: pushed 1 commit, existing PR ${url(1)}`]);
  assert.equal(git(layout.github, "log", "-1", "--format=%s", "agent/a"), "add a2.txt");
  assert.equal(onGithub("agent/b"), null);
  assert.ok(!ran(ctx, "create"));
  // The developer's checkout is as it was, and no temporary worktree is left.
  assert.deepEqual(snapshot(), before);
});

test("an assumed base answered no, or not answered, ships nothing", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  for (const answers of [[2], []]) {
    const ctx = hybridContext({ rules: [taskBase("")], answers });
    await assert.rejects(ship(ctx, "t"), new ForgeError("nothing shipped: main was not confirmed as agent/t's PR base"));
    assert.ok(ctx.err_lines.includes("agent/t has no recorded base: open its PR against main?> [yes | no]"), ctx.err_lines.join("\n"));
    assert.deepEqual(ctx.out_lines, []);
    assert.ok(!ran(ctx, "cherry-pick") && !ran(ctx, "push") && !ran(ctx, "create"));
  }
  assert.equal(onGithub("agent/t"), null);
});

test("a base that is not a branch on GitHub says so, and yes ships against main", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  const ctx = hybridContext({ rules: [taskBase("t\tv1.0\n"), creates("main", "agent/t", url(1))], answers: [1] });
  assert.equal(await ship(ctx, "t"), 0);
  assert.ok(ctx.err_lines.includes("agent/t started from v1.0, not a branch on GitHub: open its PR against main?> [yes | no]"));
  assert.deepEqual(ctx.out_lines, ["Signing 1 commit: t (1)", `agent/t: pushed 1 commit, created PR ${url(1)}`]);
});

test("the task is asked for when left out", async () => {
  layout.commit(layout.container, "agent/docs", "d.txt");
  layout.commit(layout.container, "agent/login", "l.txt");
  const ctx = hybridContext({
    rules: [taskBase("docs\torigin/main\nlogin\torigin/main\n"), creates("main", "agent/login", url(1))],
    answers: [2],
  });
  assert.equal(await ship(ctx), 0);
  assert.ok(ctx.err_lines.includes("Task> [docs | login]"));
  assert.deepEqual(ctx.out_lines, ["Signing 1 commit: login (1)", `agent/login: pushed 1 commit, created PR ${url(1)}`]);
  assert.equal(onGithub("agent/docs"), null);
});

test("a task left out with no terminal to ask gets the usage", async () => {
  layout.commit(layout.container, "agent/docs", "d.txt");
  const ctx = hybridContext({ rules: [taskBase("")] });
  await assert.rejects(ship(ctx), new ForgeError("Usage: forge ship <task> [--host <name>]"));
  assert.ok(!ran(ctx, "push"));
});

test("the task can be named as its branch, agent/<task>", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  const ctx = hybridContext({ rules: [taskBase("t\torigin/main\n"), creates("main", "agent/t", url(1))] });
  assert.equal(await ship(ctx, "agent/t"), 0);
  assert.deepEqual(ctx.out_lines, ["Signing 1 commit: t (1)", `agent/t: pushed 1 commit, created PR ${url(1)}`]);
});

test("an unknown task is refused with the list of tasks", async () => {
  layout.commit(layout.container, "agent/docs", "d.txt");
  layout.commit(layout.container, "agent/login", "l.txt");
  const ctx = hybridContext({ rules: [taskBase("")] });
  await assert.rejects(ship(ctx, "nope"), new ForgeError("unknown task nope: the agents' tasks are docs, login"));
});

test("a chain whose bottom task is already merged ships only the task above, onto that task's base", async () => {
  chain(["a", "a.txt"], ["b", "b.txt"]);
  squashMerged("a");
  const ctx = hybridContext({ rules: [
    taskBase("a\torigin/main\nb\tagent/a\n"), prs("agent/a", [url(1), "MERGED"]), creates("main", "agent/b", url(2)),
  ] });
  assert.equal(await ship(ctx, "b"), 0);
  assert.deepEqual(ctx.out_lines, [
    "agent/a: merged, skipped",
    "Signing 1 commit: b (1)",
    `agent/b: pushed 1 commit, created PR ${url(2)}`,
  ]);
  assert.deepEqual(pushes(ctx), ["HEAD:refs/heads/agent/b"]);
  assert.equal(onGithub("agent/a"), null);
  assert.equal(git(layout.github, "rev-parse", "agent/b~1"), git(layout.github, "rev-parse", "main"));
});

test("two merged tasks below: the top one goes onto the bottom one's base", async () => {
  chain(["a", "a.txt"], ["b", "b.txt"], ["c", "c.txt"]);
  squashMerged("a");
  squashMerged("b");
  const ctx = hybridContext({ rules: [
    taskBase("a\torigin/main\nb\tagent/a\nc\tagent/b\n"),
    prs("agent/a", [url(1), "MERGED"]), prs("agent/b", [url(2), "MERGED"]), creates("main", "agent/c", url(3)),
  ] });
  assert.equal(await ship(ctx, "c"), 0);
  assert.deepEqual(ctx.out_lines, [
    "agent/a: merged, skipped",
    "agent/b: merged, skipped",
    "Signing 1 commit: c (1)",
    `agent/c: pushed 1 commit, created PR ${url(3)}`,
  ]);
  assert.equal(git(layout.github, "rev-parse", "agent/c~1"), git(layout.github, "rev-parse", "main"));
});

test("a task below with nothing to ship and no GitHub branch stops the chain before signing anything", async () => {
  git(layout.container, "branch", "agent/a", "main");
  git(layout.container, "branch", "agent/b", "agent/a");
  layout.commit(layout.container, "agent/b", "b.txt");
  const ctx = hybridContext({ rules: [taskBase("a\torigin/main\nb\tagent/a\n")] });
  await assert.rejects(ship(ctx, "b"), (e: unknown) =>
    e instanceof ForgeError && /^agent\/a has no commits of its own and no branch on GitHub/.test(e.message) && /agent\/b/.test(e.message));
  assert.deepEqual(ctx.out_lines, []);
  assert.ok(!ran(ctx, "cherry-pick") && !ran(ctx, "push"));
  assert.equal(onGithub("agent/b"), null);
});

test("the requested task with nothing to ship opens no PR", async () => {
  git(layout.container, "branch", "agent/t", "main");
  const ctx = hybridContext({ rules: [taskBase("t\torigin/main\n")] });
  assert.equal(await ship(ctx, "t"), 0);
  assert.deepEqual(ctx.out_lines, ["Nothing new to sign.", "agent/t: nothing to ship"]);
  assert.ok(!ran(ctx, "create"));
});

test("a merged task with nothing new opens no second PR", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  const bases = taskBase("t\torigin/main\n");
  await ship(hybridContext({ rules: [bases, creates("main", "agent/t", url(1))] }), "t");
  // Merged on GitHub, its branch kept.
  const ctx = hybridContext({ rules: [bases, prs("agent/t", [url(1), "MERGED"])] });
  assert.equal(await ship(ctx, "t"), 0);
  assert.deepEqual(ctx.out_lines, ["Nothing new to sign.", "agent/t: nothing new, PR merged"]);
  assert.ok(!ran(ctx, "create"));
});

test("a PR that fails after the push still says the branch was pushed", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  const ctx = hybridContext({ rules: [taskBase("t\torigin/main\n"), { match: "gh pr create", code: 1, stderr: "GraphQL: boom" }] });
  await assert.rejects(ship(ctx, "t"), (e: unknown) => e instanceof ForgeError && /boom/.test(e.message));
  assert.deepEqual(ctx.out_lines, ["Signing 1 commit: t (1)", "agent/t: pushed 1 commit, no PR yet"]);
  assert.notEqual(onGithub("agent/t"), null);
});
