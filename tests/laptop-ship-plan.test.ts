import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ForgeError } from "../cli/lib/context.ts";
import { chainFor, planTask, resolveBase, type Base } from "../cli/lib/laptop/ship-plan.ts";
import { createLayout, git, hybridContext, type Layout } from "./lib/git-layout.ts";

const C = "agent-acme-widgets";
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

const plan = (task: string, base: Base, below?: { prBase: string; merged: boolean }) => {
  sync();
  return planTask(hybridContext(), layout.clone, C, task, base, below);
};
const main: Base = { kind: "branch", branch: "main", assumed: false };
const sha = (ref: string) => git(layout.clone, "rev-parse", ref);
const subjects = (shas: string[]) => shas.map((s) => git(layout.clone, "log", "-1", "--format=%s", s));

test("resolveBase follows the recorded string", () => {
  const tasks = new Set(["a"]);
  const onGithub = (b: string) => b === "feature-x";
  assert.deepEqual(resolveBase(undefined, tasks, onGithub), { kind: "branch", branch: "main", assumed: true });
  assert.deepEqual(resolveBase("", tasks, onGithub), { kind: "branch", branch: "main", assumed: true });
  assert.deepEqual(resolveBase("origin/main", tasks, onGithub), { kind: "branch", branch: "main", assumed: false });
  assert.deepEqual(resolveBase("origin/feature-x", tasks, onGithub), { kind: "branch", branch: "feature-x", assumed: false });
  assert.deepEqual(resolveBase("agent/a", tasks, onGithub), { kind: "task", task: "a" });
  assert.deepEqual(resolveBase("agent/gone", tasks, onGithub), { kind: "branch", branch: "main", assumed: true });
  assert.deepEqual(resolveBase("feature-x", tasks, onGithub), { kind: "branch", branch: "feature-x", assumed: false });
  assert.deepEqual(resolveBase("v1.0", tasks, onGithub), { kind: "branch", branch: "main", assumed: true });
  assert.deepEqual(resolveBase("0123abcd", tasks, onGithub), { kind: "branch", branch: "main", assumed: true });
});

test("chainFor lists a chain bottom first", () => {
  const bases = new Map<string, Base>([
    ["c", { kind: "task", task: "b" }],
    ["b", { kind: "task", task: "a" }],
    ["a", main],
  ]);
  assert.deepEqual(chainFor("c", bases), ["a", "b", "c"]);
  assert.deepEqual(chainFor("a", bases), ["a"]);
});

test("chainFor rejects a cycle and names the tasks", () => {
  const bases = new Map<string, Base>([
    ["a", { kind: "task", task: "b" }],
    ["b", { kind: "task", task: "a" }],
  ]);
  assert.throws(() => chainFor("a", bases), (e: unknown) => e instanceof ForgeError && /a/.test(e.message) && /b/.test(e.message));
});

test("the first ship of a task on main replays all its commits onto the merge base", async () => {
  layout.commit(layout.container, "agent/t", "a.txt", "b.txt");
  const p = await plan("t", main);
  assert.equal(p.tip, `${C}/agent/t`);
  assert.equal(p.limit, "origin/main");
  assert.equal(p.shipped, false);
  assert.deepEqual(subjects(p.commits), ["add a.txt", "add b.txt"]);
  assert.equal(p.onto, sha("origin/main"));
  assert.equal(p.prBase, "main");
});

test("shipping twice signs only the new commits", async () => {
  layout.commit(layout.container, "agent/t", "a.txt", "b.txt");
  // GitHub holds signed copies of the first two: same patches, another committer.
  const mb = git(layout.container, "rev-parse", "main");
  git(layout.container, "checkout", "-q", "-b", "signed", mb);
  git(layout.container, "-c", "user.name=Maintainer", "-c", "user.email=m@example.com", "cherry-pick", "agent/t~1", "agent/t");
  git(layout.container, "push", "-q", layout.github, "signed:refs/heads/agent/t");
  git(layout.container, "checkout", "-q", "main");
  layout.commit(layout.container, "agent/t", "c.txt");
  const p = await plan("t", main);
  assert.equal(p.shipped, true);
  assert.deepEqual(subjects(p.commits), ["add c.txt"]);
  assert.equal(p.onto, "origin/agent/t");
});

test("outside commits on GitHub become the parent", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  // Someone added a commit to agent/t on GitHub; the agent's own commit is not there yet.
  git(layout.container, "checkout", "-q", "-b", "outside", "main");
  layout.commit(layout.container, "outside", "z.txt");
  git(layout.container, "push", "-q", layout.github, "outside:refs/heads/agent/t");
  const p = await plan("t", main);
  assert.equal(p.shipped, true);
  assert.equal(p.onto, "origin/agent/t");
  assert.deepEqual(subjects(p.commits), ["add a.txt"]);
});

test("a stacked task excludes the commits of the task below", async () => {
  layout.commit(layout.container, "agent/a", "a.txt");
  git(layout.container, "branch", "agent/b", "agent/a");
  layout.commit(layout.container, "agent/b", "b.txt");
  const p = await plan("b", { kind: "task", task: "a" });
  assert.equal(p.limit, `${C}/agent/a`);
  assert.deepEqual(subjects(p.commits), ["add b.txt"]);
  // agent/a is not on GitHub yet: onto is a name the caller makes exist.
  assert.equal(p.onto, "origin/agent/a");
  assert.equal(p.prBase, "agent/a");
  assert.equal(p.shipped, false);
});

test("a stacked task over a merged task targets the merged task's base", async () => {
  layout.commit(layout.container, "agent/a", "a.txt");
  git(layout.container, "branch", "agent/b", "agent/a");
  layout.commit(layout.container, "agent/b", "b.txt");
  const p = await plan("b", { kind: "task", task: "a" }, { prBase: "main", merged: true });
  assert.equal(p.onto, "origin/main");
  assert.equal(p.prBase, "main");
  assert.deepEqual(subjects(p.commits), ["add b.txt"]);
});

test("a merge commit among the commits is rejected", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  layout.commit(layout.container, "side", "s.txt");
  git(layout.container, "checkout", "-q", "agent/t");
  git(layout.container, "merge", "-q", "--no-ff", "-m", "merge side", "side");
  git(layout.container, "checkout", "-q", "main");
  await assert.rejects(plan("t", main), (e: unknown) => e instanceof ForgeError && /merge commit/.test(e.message));
});
