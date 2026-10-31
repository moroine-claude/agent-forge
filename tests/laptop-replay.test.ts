import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ForgeError } from "../cli/lib/context.ts";
import { replayAndPush } from "../cli/lib/laptop/replay.ts";
import { planTask, type Base, type TaskPlan } from "../cli/lib/laptop/ship-plan.ts";
import { createLayout, git, hybridContext, type Layout } from "./lib/git-layout.ts";

const C = "agent-acme-widgets";
const main: Base = { kind: "branch", branch: "main", assumed: false };
let layout: Layout;
beforeEach(() => { layout = createLayout(C); });
afterEach(() => layout.cleanup());

// Brings the container's and GitHub's branches into the clone as the fetch does.
function sync() {
  const remotes = git(layout.clone, "remote").split("\n");
  if (!remotes.includes(C)) git(layout.clone, "remote", "add", C, layout.container);
  git(layout.clone, "fetch", "-q", "--prune", C);
  git(layout.clone, "fetch", "-q", "--prune", "origin");
}
const plan = () => { sync(); return planTask(hybridContext(), layout.clone, C, "t", main); };
const ship = (p: TaskPlan, sign = false) => replayAndPush(hybridContext(), layout.clone, p, { sign });
const onGithub = () => git(layout.github, "rev-parse", "refs/heads/agent/t");
const snapshot = () => ({
  head: git(layout.clone, "rev-parse", "HEAD"),
  branch: git(layout.clone, "symbolic-ref", "-q", "HEAD"),
  status: git(layout.clone, "status", "--porcelain"),
  worktrees: git(layout.clone, "worktree", "list"),
});

// Someone else commits `file` on GitHub's agent/t.
function pushElsewhere(file: string, text: string) {
  const other = path.join(layout.root, "other");
  if (!fs.existsSync(other)) {
    execFileSync("git", ["clone", "-q", layout.github, other], { stdio: "ignore" });
    git(other, "config", "user.name", "Other");
    git(other, "config", "user.email", "other@example.com");
    git(other, "checkout", "-q", "-B", "agent/t", git(layout.github, "rev-parse", "agent/t"));
  }
  fs.writeFileSync(path.join(other, file), text);
  git(other, "add", file);
  git(other, "commit", "-q", "-m", `other ${file}`);
  git(other, "push", "-q", "origin", "agent/t");
}

test("the first ship pushes the agent's trees and parents and leaves the checkout alone", async () => {
  layout.commit(layout.container, "agent/t", "a", "b");
  const p = await plan();
  const before = snapshot();
  assert.equal(await ship(p), "pushed");
  assert.deepEqual(snapshot(), before);
  const pushed = git(layout.github, "rev-list", "--reverse", "main..agent/t").split("\n");
  const agent = git(layout.container, "rev-list", "--reverse", "main..agent/t").split("\n");
  assert.equal(pushed.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(git(layout.github, "rev-parse", `${pushed[i]}^{tree}`), git(layout.container, "rev-parse", `${agent[i]}^{tree}`));
    assert.equal(git(layout.github, "rev-parse", `${pushed[i]}^`), i === 0 ? git(layout.github, "rev-parse", "main") : pushed[0]);
  }
});

test("shipping twice pushes only the third commit, as a fast-forward", async () => {
  layout.commit(layout.container, "agent/t", "a", "b");
  await ship(await plan());
  const first = onGithub();
  layout.commit(layout.container, "agent/t", "c");
  const p = await plan();
  assert.equal(p.commits.length, 1);
  assert.equal(await ship(p), "pushed");
  assert.equal(git(layout.github, "rev-list", "--count", `${first}..agent/t`), "1");
  assert.equal(git(layout.github, "merge-base", first, "agent/t"), first);
});

test("no commit to replay: nothing is pushed", async () => {
  layout.commit(layout.container, "agent/t", "a");
  await ship(await plan());
  const first = onGithub();
  assert.equal(await ship(await plan()), "nothing");
  assert.equal(onGithub(), first);
});

test("a conflicting replay rejects, leaves GitHub as it was and no temporary worktree", async () => {
  layout.commit(layout.container, "agent/t", "a");
  await ship(await plan());
  // The agent edits a; someone else edits it on GitHub in another way.
  git(layout.container, "checkout", "-q", "agent/t");
  fs.writeFileSync(path.join(layout.container, "a"), "agent\n");
  git(layout.container, "commit", "-q", "-am", "edit a");
  git(layout.container, "checkout", "-q", "main");
  pushElsewhere("a", "someone\n");
  const moved = onGithub();
  const p = await plan();
  const before = snapshot();
  await assert.rejects(ship(p), (e: unknown) => e instanceof ForgeError && /replaying [0-9a-f]{7,} edit a onto/.test(e.message));
  assert.equal(onGithub(), moved);
  assert.deepEqual(snapshot(), before);
});

test("a commit that becomes empty on the target stops like a conflict, naming it", async () => {
  layout.commit(layout.container, "agent/t", "a");
  await ship(await plan());
  const first = onGithub();
  // The same file with the same content lands on GitHub and in the agent's next commit.
  pushElsewhere("z", "z 1\n");
  fs.writeFileSync(path.join(layout.container, "z"), "z 1\n");
  git(layout.container, "checkout", "-q", "agent/t");
  git(layout.container, "add", "z");
  git(layout.container, "commit", "-q", "-m", "add z");
  git(layout.container, "checkout", "-q", "main");
  const moved = onGithub();
  assert.notEqual(moved, first);
  sync();
  // Built by hand: the planner's patch-id check would already drop this commit.
  const p: TaskPlan = { ...(await plan()), commits: [git(layout.container, "rev-parse", "agent/t")], onto: "origin/agent/t" };
  await assert.rejects(ship(p), (e: unknown) => e instanceof ForgeError && /add z/.test(e.message));
  assert.equal(onGithub(), moved);
  assert.equal(git(layout.clone, "worktree", "list").split("\n").length, 1);
});

test("an originally empty commit replays as is", async () => {
  git(layout.container, "checkout", "-q", "-b", "agent/t", "main");
  git(layout.container, "commit", "-q", "--allow-empty", "-m", "empty one");
  git(layout.container, "checkout", "-q", "main");
  assert.equal(await ship(await plan()), "pushed");
  assert.equal(git(layout.github, "log", "-1", "--format=%s", "agent/t"), "empty one");
});

test("a push rejected as non-fast-forward stops with the way forward", async () => {
  layout.commit(layout.container, "agent/t", "a");
  const p = await plan();
  // GitHub's agent/t appears between the plan and the push.
  git(layout.github, "update-ref", "refs/heads/agent/t", git(layout.github, "rev-parse", "main"));
  pushElsewhere("x", "x\n");
  const moved = onGithub();
  await assert.rejects(ship(p), (e: unknown) =>
    e instanceof ForgeError && e.message === "GitHub's agent/t moved since the fetch: run forge ship again.");
  assert.equal(onGithub(), moved);
  assert.equal(git(layout.clone, "worktree", "list").split("\n").length, 1);
});

const hasKeygen = (() => { try { execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" }); return true; } catch (e) { return (e as { status?: number }).status !== undefined; } })();

test("sign: true signs the replayed commits with the developer's own key", { skip: !hasKeygen && "ssh-keygen not available" }, async () => {
  const key = path.join(layout.root, "key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test@example.com", "-f", key]);
  const signers = path.join(layout.root, "allowed");
  fs.writeFileSync(signers, `test@example.com ${fs.readFileSync(`${key}.pub`, "utf8")}`);
  for (const [k, v] of [["gpg.format", "ssh"], ["user.signingkey", `${key}.pub`], ["gpg.ssh.allowedSignersFile", signers]]) {
    git(layout.clone, "config", k, v);
  }
  layout.commit(layout.container, "agent/t", "a", "b");
  assert.equal(await ship(await plan(), true), "pushed");
  git(layout.clone, "fetch", "-q", "origin");
  assert.deepEqual(git(layout.clone, "log", "--format=%G?", "origin/main..origin/agent/t").split("\n"), ["G", "G"]);
});
