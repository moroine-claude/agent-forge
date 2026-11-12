import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ForgeError } from "../cli/lib/context.ts";
import { cmdFetch, fetchAgents } from "../cli/lib/commands/fetch.ts";
import { cmdShip } from "../cli/lib/commands/ship.ts";
import { saveHost } from "../cli/lib/laptop/state.ts";
import type { ExecRule, FakeContext } from "./lib/fake-context.ts";
import { createLayout, git, hybridContext, type Layout } from "./lib/git-layout.ts";

// The host answers `forge team for-repo` with the team the layout stands for.
const teamContext = (opts: { rules?: ExecRule[] } = {}) =>
  hybridContext({ ...opts, rules: [{ match: "'forge' 'team' 'for-repo'", stdout: "web\n" }, ...(opts.rules ?? [])] });
import { hookScript } from "./lib/hostile-repo.ts";

const T = "web";
// The clone's remote for the team.
const C = "forge-web";
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
  layout = createLayout(T, OR);
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(tmp, { recursive: true, force: true });
  layout.cleanup();
});

const url = (n: number) => `https://github.com/${OR}/pull/${n}`;
const taskBase = (stdout: string): ExecRule => ({ match: `'forge' 'team' 'task-base' '${T}'`, stdout });
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

// The developer's forge fetch, before the review.
const fetched = () => fetchAgents(teamContext(), { cwd: layout.clone });
// forge ship after the developer's forge fetch and review (the remote exists).
const ship = async (ctx: FakeContext, task?: string) => { await fetched(); return shipNow(ctx, task); };
// forge ship alone.
const shipNow = (ctx: FakeContext, task?: string) => cmdShip(ctx, task, { cwd: layout.clone, sign: false });
// What ship says, without the lines announcing a fetch or a push, nor the list
// of the commits to sign (`agent/<t>:` and its indented lines).
const said = (ctx: FakeContext) => ctx.out_lines.filter((l) => !l.endsWith("…") && !/^agent\/\S+:$/.test(l) && !l.startsWith("  "));
const asked = (ctx: FakeContext, question: string) => ctx.err_lines.filter((l) => l.startsWith(`${question}>`)).length;
// The signing question names how many commits it covers, so none can be hidden from it.
const SIGN = (n: number) => `Sign and push ${n} commit${n === 1 ? "" : "s"}?`;
const signQuestions = (ctx: FakeContext) => ctx.err_lines.filter((l) => l.startsWith("Sign and push "));
// No control character (C0, DEL, C1): no escape sequence can rewrite what the terminal shows.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
// The list ship prints before its question: per task, its commits to sign, oldest first.
const listed = (ctx: FakeContext) => ctx.out_lines.filter((l) => /^agent\/\S+:$/.test(l) || l.startsWith("  "));
const line = (ref: string) => `  ${git(layout.container, "log", "-1", "--format=%h %s", ref)}`;
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
  const ctx = teamContext({ rules: [taskBase("t\torigin/main\n"), creates("main", "agent/t", url(1))], answers: [1] });
  assert.equal(await ship(ctx, "t"), 0);
  // Each network operation is announced: an SSH key's touch prompt would go
  // unseen. Every commit to sign is listed before the one question.
  assert.deepEqual(ctx.out_lines, [
    `Fetching ${C}…`,
    "Fetching origin…",
    "agent/t:",
    line("agent/t~1"),
    line("agent/t"),
    "Signing 2 commits: t (2)",
    "Pushing agent/t…",
    "Fetching agent/t from origin…",
    `agent/t: pushed 2 commits, created PR ${url(1)}`,
  ]);
  assert.equal(asked(ctx, SIGN(2)), 1);
  assert.equal(git(layout.github, "rev-list", "--count", "main..agent/t"), "2");
  // gh is checked before anything else, the fetch and SSH included.
  assert.deepEqual(ctx.calls[0], ["gh", "--version"]);
});

test("gh missing stops before any fetch", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  const ctx = teamContext({ rules: [{ match: "gh --version", code: 127 }] });
  await assert.rejects(shipNow(ctx, "t"), (e: unknown) => e instanceof ForgeError && /install the GitHub CLI/.test(e.message));
  assert.deepEqual(ctx.calls, [["gh", "--version"]]);
});

test("a chain A <- B <- C shipped from C pushes A, B, C in order and stacks the PRs", async () => {
  chain(["a", "a.txt"], ["b", "b1.txt", "b2.txt"], ["c", "c.txt"]);
  const ctx = teamContext({ rules: [
    taskBase("a\torigin/main\nb\tagent/a\nc\tagent/b\n"),
    creates("main", "agent/a", url(1)), creates("agent/a", "agent/b", url(2)), creates("agent/b", "agent/c", url(3)),
  ], answers: [1] });
  assert.equal(await ship(ctx, "c"), 0);
  assert.deepEqual(said(ctx), [
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
  const ctx = teamContext({ rules: [
    taskBase("a\torigin/main\nb\tagent/a\n"), creates("main", "agent/a", url(1)), creates("agent/a", "agent/b", url(2)),
  ], answers: [1] });
  assert.equal(await ship(ctx, "b"), 0);
  assert.deepEqual(said(ctx).slice(1), [
    `agent/a: pushed 1 commit, created PR ${url(1)}`,
    `agent/b: pushed 1 commit, created PR ${url(2)}`,
  ]);
  assert.equal(git(layout.github, "rev-parse", "agent/b~1"), git(layout.github, "rev-parse", "agent/a"));
});

test("a clone that fetches only main sees GitHub's agent branch move: ship goes on, no loop", async () => {
  git(layout.clone, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
  layout.commit(layout.container, "agent/t", "a.txt");
  const bases = taskBase("t\torigin/main\n");
  await ship(teamContext({ rules: [bases, creates("main", "agent/t", url(1))], answers: [1] }), "t");
  // A review suggestion lands on GitHub's agent/t, and the agent works on.
  pushElsewhere("agent/t", "z.txt", "outside\n");
  const outside = onGithub("agent/t");
  layout.commit(layout.container, "agent/t", "b.txt");
  const ctx = teamContext({ rules: [bases, prs("agent/t", [url(1), "OPEN"])], answers: [1] });
  assert.equal(await ship(ctx, "t"), 0);
  assert.deepEqual(said(ctx), ["Signing 1 commit: t (1)", `agent/t: pushed 1 commit, existing PR ${url(1)}`]);
  assert.equal(git(layout.github, "rev-parse", "agent/t~1"), outside);
});

test("re-running right after signs nothing, pushes nothing and finds the PRs", async () => {
  chain(["a", "a.txt"], ["b", "b.txt"]);
  const bases = taskBase("a\torigin/main\nb\tagent/a\n");
  await ship(teamContext({ rules: [bases, creates("main", "agent/a", url(1)), creates("agent/a", "agent/b", url(2))], answers: [1] }), "b");
  const before = [onGithub("agent/a"), onGithub("agent/b")];
  const ctx = teamContext({ rules: [bases, prs("agent/a", [url(1), "OPEN"]), prs("agent/b", [url(2), "OPEN"])] });
  assert.equal(await ship(ctx, "b"), 0);
  // Nothing to sign: no list, no question.
  assert.deepEqual(signQuestions(ctx), []);
  assert.deepEqual(listed(ctx), []);
  assert.deepEqual(said(ctx), [
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
  const ctx = teamContext({ rules: [taskBase("a\torigin/main\nb\tagent/a\n"), prs("agent/a", [url(1), "OPEN"])], answers: [1] });
  const before = snapshot();
  await assert.rejects(ship(ctx, "b"), (e: unknown) =>
    e instanceof ForgeError && /^agent\/b: replaying [0-9a-f]{7,} add b\.txt onto origin\/agent\/a stopped/.test(e.message));
  assert.deepEqual(said(ctx), ["Signing 2 commits: a (1), b (1)", `agent/a: pushed 1 commit, existing PR ${url(1)}`]);
  assert.equal(git(layout.github, "log", "-1", "--format=%s", "agent/a"), "add a2.txt");
  assert.equal(onGithub("agent/b"), null);
  assert.ok(!ran(ctx, "create"));
  // The developer's checkout is as it was, and no temporary worktree is left.
  assert.deepEqual(snapshot(), before);
});

test("an assumed base answered no, or not answered, ships nothing", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  for (const answers of [[2], []]) {
    const ctx = teamContext({ rules: [taskBase("")], answers });
    await assert.rejects(ship(ctx, "t"), new ForgeError("nothing shipped: main was not confirmed as agent/t's PR base"));
    assert.ok(ctx.err_lines.includes("agent/t has no recorded base: open its PR against main?> [yes | no]"), ctx.err_lines.join("\n"));
    assert.deepEqual(said(ctx), []);
    assert.ok(!ran(ctx, "cherry-pick") && !ran(ctx, "push") && !ran(ctx, "create"));
  }
  assert.equal(onGithub("agent/t"), null);
});

test("a base that is not a branch on GitHub says so, and yes ships against main", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  const ctx = teamContext({ rules: [taskBase("t\tv1.0\n"), creates("main", "agent/t", url(1))], answers: [1, 1] });
  assert.equal(await ship(ctx, "t"), 0);
  assert.ok(ctx.err_lines.includes("agent/t started from v1.0, not a branch on GitHub: open its PR against main?> [yes | no]"));
  assert.deepEqual(said(ctx), ["Signing 1 commit: t (1)", `agent/t: pushed 1 commit, created PR ${url(1)}`]);
});

test("the task is asked for when left out", async () => {
  layout.commit(layout.container, "agent/docs", "d.txt");
  layout.commit(layout.container, "agent/login", "l.txt");
  const ctx = teamContext({
    rules: [taskBase("docs\torigin/main\nlogin\torigin/main\n"), creates("main", "agent/login", url(1))],
    answers: [2, 1],
  });
  assert.equal(await ship(ctx), 0);
  assert.ok(ctx.err_lines.includes("Task> [docs | login]"));
  assert.deepEqual(said(ctx), ["Signing 1 commit: login (1)", `agent/login: pushed 1 commit, created PR ${url(1)}`]);
  assert.equal(onGithub("agent/docs"), null);
});

test("a task left out with no terminal to ask gets the usage", async () => {
  layout.commit(layout.container, "agent/docs", "d.txt");
  const ctx = teamContext({ rules: [taskBase("")] });
  await assert.rejects(ship(ctx), new ForgeError("Usage: forge ship <task> [--host <name>]"));
  assert.ok(!ran(ctx, "push"));
});

test("the task can be named as its branch, agent/<task>", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  const ctx = teamContext({ rules: [taskBase("t\torigin/main\n"), creates("main", "agent/t", url(1))], answers: [1] });
  assert.equal(await ship(ctx, "agent/t"), 0);
  assert.deepEqual(said(ctx), ["Signing 1 commit: t (1)", `agent/t: pushed 1 commit, created PR ${url(1)}`]);
});

test("an unknown task is refused with the list of tasks", async () => {
  layout.commit(layout.container, "agent/docs", "d.txt");
  layout.commit(layout.container, "agent/login", "l.txt");
  const ctx = teamContext({ rules: [taskBase("")] });
  await assert.rejects(ship(ctx, "nope"), new ForgeError("unknown task nope: the agents' tasks are docs, login"));
});

test("a chain whose bottom task is already merged ships only the task above, onto that task's base", async () => {
  chain(["a", "a.txt"], ["b", "b.txt"]);
  squashMerged("a");
  const ctx = teamContext({ rules: [
    taskBase("a\torigin/main\nb\tagent/a\n"), prs("agent/a", [url(1), "MERGED"]), creates("main", "agent/b", url(2)),
  ], answers: [1] });
  assert.equal(await ship(ctx, "b"), 0);
  assert.deepEqual(said(ctx), [
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
  const ctx = teamContext({ rules: [
    taskBase("a\torigin/main\nb\tagent/a\nc\tagent/b\n"),
    prs("agent/a", [url(1), "MERGED"]), prs("agent/b", [url(2), "MERGED"]), creates("main", "agent/c", url(3)),
  ], answers: [1] });
  assert.equal(await ship(ctx, "c"), 0);
  assert.deepEqual(said(ctx), [
    "agent/a: merged, skipped",
    "agent/b: merged, skipped",
    "Signing 1 commit: c (1)",
    `agent/c: pushed 1 commit, created PR ${url(3)}`,
  ]);
  assert.equal(git(layout.github, "rev-parse", "agent/c~1"), git(layout.github, "rev-parse", "main"));
});

test("a merged task below with commits not on GitHub is skipped, and the line says how to ship them", async () => {
  chain(["a", "a.txt"], ["b", "b.txt"]);
  squashMerged("a");
  // The agent went on with A after its PR was merged.
  layout.commit(layout.container, "agent/a", "a2.txt");
  const ctx = teamContext({ rules: [
    taskBase("a\torigin/main\nb\tagent/a\n"), prs("agent/a", [url(1), "MERGED"]), creates("main", "agent/b", url(2)),
  ], answers: [1] });
  assert.equal(await ship(ctx, "b"), 0);
  assert.deepEqual(said(ctx), [
    "agent/a: merged, skipped (1 commit not shipped: forge ship a)",
    "Signing 1 commit: b (1)",
    `agent/b: pushed 1 commit, created PR ${url(2)}`,
  ]);
  assert.deepEqual(pushes(ctx), ["HEAD:refs/heads/agent/b"]);
});

test("a task below with nothing to ship and no GitHub branch stops the chain before signing anything", async () => {
  git(layout.container, "branch", "agent/a", "main");
  git(layout.container, "branch", "agent/b", "agent/a");
  layout.commit(layout.container, "agent/b", "b.txt");
  const ctx = teamContext({ rules: [taskBase("a\torigin/main\nb\tagent/a\n")] });
  await assert.rejects(ship(ctx, "b"), (e: unknown) =>
    e instanceof ForgeError && /^agent\/a has no commits of its own and no branch on GitHub/.test(e.message) && /agent\/b/.test(e.message));
  assert.deepEqual(said(ctx), []);
  assert.ok(!ran(ctx, "cherry-pick") && !ran(ctx, "push"));
  assert.equal(onGithub("agent/b"), null);
});

test("the requested task with nothing to ship opens no PR", async () => {
  git(layout.container, "branch", "agent/t", "main");
  const ctx = teamContext({ rules: [taskBase("t\torigin/main\n")] });
  assert.equal(await ship(ctx, "t"), 0);
  assert.deepEqual(said(ctx), ["Nothing new to sign.", "agent/t: nothing to ship"]);
  assert.ok(!ran(ctx, "create"));
});

test("a merged task with nothing new opens no second PR", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  const bases = taskBase("t\torigin/main\n");
  await ship(teamContext({ rules: [bases, creates("main", "agent/t", url(1))], answers: [1] }), "t");
  // Merged on GitHub, its branch kept.
  const ctx = teamContext({ rules: [bases, prs("agent/t", [url(1), "MERGED"])] });
  assert.equal(await ship(ctx, "t"), 0);
  assert.deepEqual(said(ctx), ["Nothing new to sign.", "agent/t: nothing new, PR merged"]);
  assert.ok(!ran(ctx, "create"));
});

// GitHub squash-merges agent/t into main and deletes the branch.
function squashOnGithub() {
  const gh = path.join(layout.root, "ghwork");
  execFileSync("git", ["clone", "-q", layout.github, gh], { stdio: "ignore" });
  git(gh, "config", "user.name", "GitHub");
  git(gh, "config", "user.email", "gh@example.com");
  git(gh, "merge", "-q", "--squash", "origin/agent/t");
  git(gh, "commit", "-q", "-m", "squash t (#1)");
  git(gh, "push", "-q", "origin", "main");
  git(gh, "push", "-q", "origin", ":agent/t");
}

test("a task whose PR was squash-merged ships again only after a yes, as a new PR", async () => {
  layout.commit(layout.container, "agent/t", "a.txt", "b.txt");
  const bases = taskBase("t\torigin/main\n");
  await ship(teamContext({ rules: [bases, creates("main", "agent/t", url(1))], answers: [1] }), "t");
  squashOnGithub();
  // The squash matches neither commit: ship would sign both again.
  const question = `agent/t's PR ${url(1)} is merged: push 2 commits as a new PR?`;
  for (const answers of [[2], []]) {
    const ctx = teamContext({ rules: [bases, prs("agent/t", [url(1), "MERGED"]), creates("main", "agent/t", url(2))], answers });
    await assert.rejects(ship(ctx, "t"), new ForgeError("nothing shipped: agent/t's PR is merged, and a new one was not confirmed"));
    assert.equal(asked(ctx, question), 1, ctx.err_lines.join("\n"));
    assert.deepEqual(said(ctx), []);
    assert.ok(!ran(ctx, "cherry-pick") && !ran(ctx, "push") && !ran(ctx, "create"));
  }
  assert.equal(onGithub("agent/t"), null);
  const ctx = teamContext({ rules: [bases, prs("agent/t", [url(1), "MERGED"]), creates("main", "agent/t", url(2))], answers: [1, 1] });
  assert.equal(await ship(ctx, "t"), 0);
  assert.deepEqual(said(ctx), ["Signing 2 commits: t (2)", `agent/t: pushed 2 commits, created PR ${url(2)}`]);
});

test("a PR that fails after the push still says the branch was pushed", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  const ctx = teamContext({ rules: [taskBase("t\torigin/main\n"), { match: "gh pr create", code: 1, stderr: "GraphQL: boom" }], answers: [1] });
  await assert.rejects(ship(ctx, "t"), (e: unknown) => e instanceof ForgeError && /boom/.test(e.message));
  assert.deepEqual(said(ctx), ["Signing 1 commit: t (1)", "agent/t: pushed 1 commit, no PR yet"]);
  assert.notEqual(onGithub("agent/t"), null);
});

test("ship lists every commit it will sign, oldest first, and signs only after a yes", async () => {
  layout.commit(layout.container, "agent/t", "a.txt", "b.txt");
  const bases = taskBase("t\torigin/main\n");
  // No, or no terminal to ask: nothing is signed or pushed.
  for (const answers of [[2], []]) {
    const ctx = teamContext({ rules: [bases, creates("main", "agent/t", url(1))], answers });
    await assert.rejects(ship(ctx, "t"), new ForgeError("nothing shipped: signing was not confirmed"));
    assert.deepEqual(listed(ctx), ["agent/t:", line("agent/t~1"), line("agent/t")]);
    assert.equal(asked(ctx, SIGN(2)), 1);
    assert.deepEqual(said(ctx), []);
    assert.ok(!ran(ctx, "cherry-pick") && !ran(ctx, "push") && !ran(ctx, "create"));
  }
  assert.equal(onGithub("agent/t"), null);
  // Asked again, whatever was fetched since.
  const ctx = teamContext({ rules: [bases, creates("main", "agent/t", url(1))], answers: [1] });
  assert.equal(await ship(ctx, "t"), 0);
  assert.deepEqual(listed(ctx), ["agent/t:", line("agent/t~1"), line("agent/t")]);
  assert.deepEqual(said(ctx), ["Signing 2 commits: t (2)", `agent/t: pushed 2 commits, created PR ${url(1)}`]);
});

test("one question for the whole chain, each task's commits listed under it, before the Signing line", async () => {
  chain(["a", "a.txt"], ["b", "b1.txt", "b2.txt"]);
  const ctx = teamContext({
    rules: [taskBase("a\torigin/main\nb\tagent/a\n"), creates("main", "agent/a", url(1)), creates("agent/a", "agent/b", url(2))],
    answers: [1],
  });
  assert.equal(await ship(ctx, "b"), 0);
  // One question, its count the whole chain's.
  assert.deepEqual(signQuestions(ctx), [`${SIGN(3)}> [yes | no]`]);
  assert.deepEqual(ctx.out_lines.filter((l) => !l.endsWith("…")).slice(0, 6), [
    "agent/a:",
    line("agent/a"),
    "agent/b:",
    line("agent/b~1"),
    line("agent/b"),
    "Signing 3 commits: a (1), b (2)",
  ]);
});

test("a commit made after the review is listed even when another task's ship fetched it", async () => {
  const bases = taskBase("t1\torigin/main\nt2\torigin/main\n");
  layout.commit(layout.container, "agent/t1", "a.txt");
  layout.commit(layout.container, "agent/t2", "b.txt");
  // The developer fetches and reviews both; the agent then works on t2.
  await cmdFetch(teamContext({ rules: [bases] }), { cwd: layout.clone });
  layout.commit(layout.container, "agent/t2", "unreviewed.txt");
  const t1 = teamContext({ rules: [bases, creates("main", "agent/t1", url(1))], answers: [1] });
  assert.equal(await shipNow(t1, "t1"), 0);
  assert.deepEqual(listed(t1), ["agent/t1:", line("agent/t1")]);
  // t1's ship fetched t2's new commit: shipping t2 still lists it.
  const t2 = teamContext({ rules: [bases, creates("main", "agent/t2", url(2))], answers: [2] });
  await assert.rejects(shipNow(t2, "t2"), new ForgeError("nothing shipped: signing was not confirmed"));
  assert.deepEqual(listed(t2), ["agent/t2:", line("agent/t2~1"), line("agent/t2")]);
  assert.equal(onGithub("agent/t2"), null);
});

test("a commit made after the review is listed even after a ship that stopped after its fetch", async () => {
  const bases = taskBase("");
  layout.commit(layout.container, "agent/t", "a.txt");
  await cmdFetch(teamContext({ rules: [bases] }), { cwd: layout.clone });
  layout.commit(layout.container, "agent/t", "unreviewed.txt");
  // main not confirmed as the PR base: the ship stops, its fetch done.
  const no = teamContext({ rules: [bases], answers: [2] });
  await assert.rejects(shipNow(no, "t"), new ForgeError("nothing shipped: main was not confirmed as agent/t's PR base"));
  const again = teamContext({ rules: [bases, creates("main", "agent/t", url(1))], answers: [1, 2] });
  await assert.rejects(shipNow(again, "t"), new ForgeError("nothing shipped: signing was not confirmed"));
  assert.deepEqual(listed(again), ["agent/t:", line("agent/t~1"), line("agent/t")]);
  assert.equal(asked(again, SIGN(2)), 1);
  assert.equal(onGithub("agent/t"), null);
});

test("the list and question come after the other questions", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  const ctx = teamContext({ rules: [taskBase(""), creates("main", "agent/t", url(1))], answers: [1, 1] });
  assert.equal(await ship(ctx, "t"), 0);
  const questions = ctx.err_lines.filter((l) => l.includes("> ["));
  assert.deepEqual(questions, [
    "agent/t has no recorded base: open its PR against main?> [yes | no]",
    `${SIGN(1)}> [yes | no]`,
  ]);
});

test("a commit subject cannot hide a commit in the signing list: no control character reaches it", async () => {
  git(layout.container, "checkout", "-q", "-b", "agent/t", "main");
  fs.writeFileSync(path.join(layout.container, "evil.txt"), "evil\n");
  git(layout.container, "add", "evil.txt");
  git(layout.container, "commit", "-q", "-m", "evil");
  fs.writeFileSync(path.join(layout.container, "ok.txt"), "ok\n");
  git(layout.container, "add", "ok.txt");
  // Cursor up, erase the line, back to its start: on a terminal, "evil" would vanish.
  git(layout.container, "commit", "-q", "-m", "\x1b[1A\x1b[2K\radd ok.txt");
  git(layout.container, "checkout", "-q", "main");
  const ctx = teamContext({ rules: [taskBase("t\torigin/main\n"), creates("main", "agent/t", url(1))], answers: [2] });
  await assert.rejects(ship(ctx, "t"), new ForgeError("nothing shipped: signing was not confirmed"));
  const h = (ref: string) => git(layout.container, "rev-parse", "--short", ref);
  assert.deepEqual(listed(ctx), ["agent/t:", `  ${h("agent/t~1")} evil`, `  ${h("agent/t")} [1A[2Kadd ok.txt`]);
  assert.ok(ctx.out_lines.every((l) => !CONTROL.test(l)), JSON.stringify(ctx.out_lines));
  assert.deepEqual(signQuestions(ctx), [`${SIGN(2)}> [yes | no]`]);
  assert.equal(onGithub("agent/t"), null);
});

// Who committed each commit of GitHub's branch above main: the developer, once replayed.
const committers = (branch: string) => git(layout.github, "log", "--format=%ce", `main..${branch}`).split("\n");

// The agent tags its first commit with each name, which shadows in git's
// short-name lookup a ref that ship reads; ship must still replay both commits.
for (const names of [["origin/main"], ["origin/agent/t", `${C}/agent/t`, "main"]]) {
  test(`tags the agent creates in the container cannot change what ship signs and pushes: ${names.join(", ")}`, async () => {
    // The agent's own identity: a replayed commit is then always a new object.
    git(layout.container, "config", "user.email", "agent@example.org");
    const hidden = layout.commit(layout.container, "agent/t", "hidden.txt");
    layout.commit(layout.container, "agent/t", "visible.txt");
    for (const name of names) git(layout.container, "tag", name, hidden);
    const ctx = teamContext({ rules: [taskBase("t\torigin/main\n"), creates("main", "agent/t", url(1))], answers: [1] });
    assert.equal(await ship(ctx, "t"), 0);
    // Every commit pushed was replayed by the developer: none is the agent's own.
    assert.deepEqual(committers("agent/t"), ["test@example.com", "test@example.com"]);
    assert.notEqual(git(layout.github, "rev-parse", "agent/t~1"), hidden);
    assert.equal(git(layout.github, "rev-parse", "agent/t~2"), git(layout.github, "rev-parse", "main"));
    assert.equal(git(layout.clone, "tag", "-l"), "");
  });
}

test("a tag named after a full ref ship reads, missing on a first ship, is warned about and cannot stand in for it", async () => {
  // The developer prunes tags on fetch, a usual setting.
  git(layout.clone, "config", "fetch.pruneTags", "true");
  // The agent: a commit off agent/t, never in the reviewed range, tagged with a full ref name.
  git(layout.container, "checkout", "-q", "-b", "side", "main");
  fs.writeFileSync(path.join(layout.container, "evil.txt"), "evil\n");
  git(layout.container, "add", "evil.txt");
  git(layout.container, "commit", "-q", "-m", "evil");
  const evil = git(layout.container, "rev-parse", "HEAD");
  git(layout.container, "checkout", "-q", "main");
  git(layout.container, "branch", "-D", "side");
  git(layout.container, "tag", "refs/remotes/origin/agent/t", evil);
  layout.commit(layout.container, "agent/t", "visible.txt");
  // The same tag already in the clone, brought by a fetch from before forge kept tags out.
  git(layout.clone, "fetch", "-q", layout.container, "refs/tags/*:refs/tags/*");
  const bases = taskBase("t\torigin/main\n");
  const fetch = teamContext({ rules: [bases] });
  assert.equal(await cmdFetch(fetch, { cwd: layout.clone }), 0);
  const name = "refs/remotes/origin/agent/t";
  assert.ok(fetch.err_lines.includes(
    `WARNING: tag ${name} hides the branch ${name} in git commands: delete it (git tag -d ${name}) unless you made it`,
  ), fetch.err_lines.join("\n"));
  const ctx = teamContext({ rules: [bases, creates("main", "agent/t", url(1))], answers: [1] });
  assert.equal(await shipNow(ctx, "t"), 0);
  // Only the reviewed commit, replayed onto main: the tagged commit is nowhere on GitHub's branch.
  const pushed = git(layout.github, "rev-list", "main..agent/t").split("\n");
  assert.equal(pushed.length, 1);
  assert.ok(!pushed.includes(evil));
  assert.equal(git(layout.github, "rev-parse", "agent/t~1"), git(layout.github, "rev-parse", "main"));
});

// Two ways a hook can run code from the agent's tree: a relative core.hooksPath
// (husky v9, .githooks), and the developer's own hook running a script of the
// checked-out tree (lefthook, pre-commit). The marker is written outside the repository.
const HOOKS = ["post-checkout", "prepare-commit-msg", "post-commit", "pre-push", "reference-transaction", "post-index-change"];

// Ships agent/t twice: the second ship starts its worktree on GitHub's agent/t,
// which holds the agent's tooling commit.
async function shipTwice() {
  layout.commit(layout.container, "agent/t", "a.txt");
  const bases = taskBase("t\torigin/main\n");
  assert.equal(await ship(teamContext({ rules: [bases, creates("main", "agent/t", url(1))], answers: [1] }), "t"), 0);
  layout.commit(layout.container, "agent/t", "b.txt");
  assert.equal(await ship(teamContext({ rules: [bases, prs("agent/t", [url(1), "OPEN"])], answers: [1] }), "t"), 0);
  assert.equal(git(layout.github, "rev-list", "--count", "main..agent/t"), "3");
}

test("no hook from the agent's tree runs on the laptop during ship", async () => {
  const marker = path.join(layout.root, "hook-ran");
  git(layout.clone, "config", "core.hooksPath", ".githooks");
  git(layout.container, "checkout", "-q", "-b", "agent/t", "main");
  fs.mkdirSync(path.join(layout.container, ".githooks"));
  for (const h of HOOKS) fs.writeFileSync(path.join(layout.container, ".githooks", h), hookScript(marker), { mode: 0o755 });
  git(layout.container, "add", ".githooks");
  git(layout.container, "commit", "-q", "-m", "tooling");
  git(layout.container, "checkout", "-q", "main");
  await shipTwice();
  assert.equal(fs.existsSync(marker), false, "a hook from the agent's tree ran");
});

test("no script of the agent's tree runs through the clone's own hooks during ship", async () => {
  const marker = path.join(layout.root, "hook-ran");
  for (const h of HOOKS) {
    fs.writeFileSync(path.join(layout.clone, ".git", "hooks", h), "#!/bin/sh\n[ -x ./tree-hook.sh ] && ./tree-hook.sh\nexit 0\n", { mode: 0o755 });
  }
  git(layout.container, "checkout", "-q", "-b", "agent/t", "main");
  fs.writeFileSync(path.join(layout.container, "tree-hook.sh"), hookScript(marker), { mode: 0o755 });
  git(layout.container, "add", "tree-hook.sh");
  git(layout.container, "commit", "-q", "-m", "tooling");
  git(layout.container, "checkout", "-q", "main");
  await shipTwice();
  assert.equal(fs.existsSync(marker), false, "a script from the agent's tree ran");
});

test("a task name with a C1 control is neither proposed nor shipped, and is reported without the control", async () => {
  const CSI = "\u009b";
  layout.commit(layout.container, "agent/login", "a.txt");
  layout.commit(layout.container, `agent/evil${CSI}31m`, "b.txt");
  const ctx = teamContext({ rules: [taskBase("login\torigin/main\n"), prs("agent/login")] });
  await assert.rejects(shipNow(ctx, `evil${CSI}31m`), (e: Error) =>
    e instanceof ForgeError && !e.message.includes(CSI) && /unknown task/.test(e.message));
  assert.ok(!ctx.out_lines.concat(ctx.err_lines).some((l) => l.includes(CSI)));
  assert.ok(ctx.out_lines.includes("skipped an agent branch whose task name is not [A-Za-z0-9._-]: agent/evil31m"));
});
