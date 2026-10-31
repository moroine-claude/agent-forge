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
  // The rules apply in order: an unknown agent/<a> falls through to the GitHub rule.
  assert.deepEqual(resolveBase("agent/gone", tasks, (b) => b === "agent/gone"), { kind: "branch", branch: "agent/gone", assumed: false });
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
  assert.throws(() => chainFor("a", bases), new ForgeError("tasks base on each other in a cycle: a -> b -> a"));
});

test("chainFor names only the tasks of the cycle, not those above it", () => {
  const bases = new Map<string, Base>([
    ["c", { kind: "task", task: "b" }],
    ["b", { kind: "task", task: "a" }],
    ["a", { kind: "task", task: "b" }],
  ]);
  assert.throws(() => chainFor("c", bases), new ForgeError("tasks base on each other in a cycle: b -> a -> b"));
});

test("the first ship of a task on main replays all its commits onto the merge base", async () => {
  layout.commit(layout.container, "agent/t", "a.txt", "b.txt");
  const p = await plan("t", main);
  assert.equal(p.tip, `refs/remotes/${C}/agent/t`);
  assert.equal(p.limit, "refs/remotes/origin/main");
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
  assert.equal(p.onto, "refs/remotes/origin/agent/t");
});

test("outside commits on GitHub become the parent", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  // Someone added a commit to agent/t on GitHub; the agent's own commit is not there yet.
  git(layout.container, "checkout", "-q", "-b", "outside", "main");
  layout.commit(layout.container, "outside", "z.txt");
  git(layout.container, "push", "-q", layout.github, "outside:refs/heads/agent/t");
  const p = await plan("t", main);
  assert.equal(p.shipped, true);
  assert.equal(p.onto, "refs/remotes/origin/agent/t");
  assert.deepEqual(subjects(p.commits), ["add a.txt"]);
});

test("a stacked task excludes the commits of the task below", async () => {
  layout.commit(layout.container, "agent/a", "a.txt");
  git(layout.container, "branch", "agent/b", "agent/a");
  layout.commit(layout.container, "agent/b", "b.txt");
  const p = await plan("b", { kind: "task", task: "a" });
  assert.equal(p.limit, `refs/remotes/${C}/agent/a`);
  assert.deepEqual(subjects(p.commits), ["add b.txt"]);
  // agent/a is not on GitHub yet: onto is a name the caller makes exist.
  assert.equal(p.onto, "refs/remotes/origin/agent/a");
  assert.equal(p.prBase, "agent/a");
  assert.equal(p.shipped, false);
});

test("a stacked task over a merged task targets the merged task's base", async () => {
  layout.commit(layout.container, "agent/a", "a.txt");
  git(layout.container, "branch", "agent/b", "agent/a");
  layout.commit(layout.container, "agent/b", "b.txt");
  const p = await plan("b", { kind: "task", task: "a" }, { prBase: "main", merged: true });
  assert.equal(p.onto, "refs/remotes/origin/main");
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

// Creates `signed` on main with signed copies (another committer) of `refs`;
// publishSigned pushes it to GitHub as agent/<task> and returns to main.
function pushSignedCopies(...refs: string[]) {
  git(layout.container, "checkout", "-q", "-b", "signed", "main");
  git(layout.container, "-c", "user.name=Maintainer", "-c", "user.email=m@example.com", "cherry-pick", ...refs);
}
const publishSigned = (task: string) => {
  git(layout.container, "push", "-q", layout.github, `signed:refs/heads/agent/${task}`);
  git(layout.container, "checkout", "-q", "main");
};

test("signed copies, then an outside commit on GitHub: only the new commit is replayed", async () => {
  layout.commit(layout.container, "agent/t", "a.txt", "b.txt");
  pushSignedCopies("agent/t~1", "agent/t");
  git(layout.container, "checkout", "-q", "signed");
  layout.commit(layout.container, "signed", "z.txt");
  publishSigned("t");
  layout.commit(layout.container, "agent/t", "c.txt");
  const p = await plan("t", main);
  assert.deepEqual(subjects(p.commits), ["add c.txt"]);
  assert.equal(p.onto, "refs/remotes/origin/agent/t");
});

test("an Update branch merge on GitHub is not a merge commit of the agent", async () => {
  layout.commit(layout.container, "agent/t", "a.txt", "b.txt");
  pushSignedCopies("agent/t~1", "agent/t");
  layout.commit(layout.container, "newer", "n.txt");
  git(layout.container, "checkout", "-q", "main");
  git(layout.container, "merge", "-q", "--ff-only", "newer");
  git(layout.container, "push", "-q", layout.github, "main");
  git(layout.container, "checkout", "-q", "signed");
  git(layout.container, "merge", "-q", "--no-ff", "-m", "Update branch", "main");
  publishSigned("t");
  layout.commit(layout.container, "agent/t", "c.txt");
  const p = await plan("t", main);
  assert.deepEqual(subjects(p.commits), ["add c.txt"]);
  assert.equal(p.onto, "refs/remotes/origin/agent/t");
});

test("after a squash merge, the first ship goes onto the branch and replays cleanly", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  // The PR was squash-merged into main and its branch deleted.
  git(layout.container, "checkout", "-q", "main");
  git(layout.container, "merge", "-q", "--squash", "agent/t");
  git(layout.container, "commit", "-q", "-m", "squash t");
  git(layout.container, "push", "-q", layout.github, "main");
  // The agent then edits the same file.
  layout.commit(layout.container, "agent/t", "a.txt");
  const p = await plan("t", main);
  assert.equal(p.shipped, false);
  assert.equal(p.onto, "refs/remotes/origin/main");
  assert.deepEqual(subjects(p.commits), ["add a.txt"]);
  git(layout.clone, "checkout", "-q", "--detach", p.onto);
  git(layout.clone, "cherry-pick", ...p.commits);
});

test("tags in the clone named like the refs the plan reads change nothing", async () => {
  const hidden = layout.commit(layout.container, "agent/t", "hidden.txt");
  layout.commit(layout.container, "agent/t", "visible.txt");
  sync();
  // git's short-name lookup takes refs/tags/<name> before refs/remotes/<name>.
  for (const name of ["origin/main", "origin/agent/t", `${C}/agent/t`]) git(layout.clone, "tag", name, hidden);
  const p = await planTask(hybridContext(), layout.clone, C, "t", main);
  assert.equal(p.tip, `refs/remotes/${C}/agent/t`);
  assert.equal(p.limit, "refs/remotes/origin/main");
  assert.equal(p.shipped, false);
  assert.deepEqual(subjects(p.commits), ["add hidden.txt", "add visible.txt"]);
  assert.equal(p.onto, sha("refs/remotes/origin/main"));
});

test("a stacked task's refs are the remote-tracking ones, whatever the tags", async () => {
  layout.commit(layout.container, "agent/a", "a.txt");
  git(layout.container, "branch", "agent/b", "agent/a");
  layout.commit(layout.container, "agent/b", "b.txt");
  sync();
  git(layout.clone, "tag", `${C}/agent/a`, "refs/remotes/origin/main");
  const p = await planTask(hybridContext(), layout.clone, C, "b", { kind: "task", task: "a" });
  assert.equal(p.limit, `refs/remotes/${C}/agent/a`);
  assert.equal(p.onto, "refs/remotes/origin/agent/a");
  assert.deepEqual(subjects(p.commits), ["add b.txt"]);
});

test("a base that is gone from GitHub is reported by task and branch", async () => {
  layout.commit(layout.container, "agent/t", "a.txt");
  await assert.rejects(
    plan("t", { kind: "branch", branch: "feature-x", assumed: false }),
    new ForgeError("agent/t: its base feature-x is gone from GitHub"),
  );
});
