import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdStart } from "../scripts/lib/commands/start.ts";

const RUNNING = JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Running" }]);

function rules(extra: { match: string; code?: number; stdout?: string }[] = []) {
  return [
    ...extra,
    { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
    { match: "user.forge.mode", stdout: "autonomous" },
    { match: "lxc list", stdout: RUNNING },
    { match: "lxc info", code: 0 },
    { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\n" },
    { match: "test -e /workspace/.trees/", code: 1 },
    { match: "show-ref", code: 1 },
  ];
}
const added = (c: ReturnType<typeof fakeContext>) =>
  c.calls.map((x) => x.join(" ")).find((l) => l.includes("worktree add")) ?? "";

test("an existing worktree is attached, not refused", async () => {
  const c = fakeContext({ rules: rules([{ match: "test -e /workspace/.trees/cli", code: 0 }]) });
  assert.equal(await cmdStart(c, "moroine/agent-forge", "cli"), 0);
  assert.equal(added(c), "", "aucun worktree ne doit être créé");
  assert.ok(c.calls.some((call) => call.includes("tmux")));
});

test("an existing local branch is resumed in a new worktree", async () => {
  const c = fakeContext({ rules: rules([{ match: "show-ref --verify --quiet refs/heads/agent/docs", code: 0 }]) });
  await cmdStart(c, "moroine/agent-forge", "docs");
  assert.ok(added(c).includes("worktree add .trees/docs agent/docs"), added(c));
});

test("a branch that exists only on origin is picked up", async () => {
  const c = fakeContext({ rules: rules([{ match: "show-ref --verify --quiet refs/remotes/origin/agent/api", code: 0 }]) });
  await cmdStart(c, "moroine/agent-forge", "api");
  assert.ok(added(c).includes("worktree add .trees/api -b agent/api origin/agent/api"), added(c));
});

test("with nothing existing, the branch starts from origin/main", async () => {
  const c = fakeContext({ rules: rules() });
  await cmdStart(c, "moroine/agent-forge", "fresh");
  assert.ok(added(c).includes("worktree add .trees/fresh -b agent/fresh origin/main"), added(c));
});

test("main is refreshed before the worktree is created", async () => {
  const c = fakeContext({ rules: rules() });
  await cmdStart(c, "moroine/agent-forge", "fresh");
  const flat = c.calls.map((x) => x.join(" "));
  const fetch = flat.findIndex((l) => l.includes("fetch origin"));
  const add = flat.findIndex((l) => l.includes("worktree add"));
  assert.ok(fetch >= 0 && fetch < add, "le fetch doit précéder la création");
});

test("a supervised container skips the fetch", async () => {
  const c = fakeContext({
    rules: rules().map((r) => (r.match === "user.forge.mode" ? { ...r, stdout: "supervised" } : r)),
  });
  await cmdStart(c, "moroine/agent-forge", "fresh");
  assert.ok(!c.calls.some((call) => call.join(" ").includes("fetch origin")));
});

test("the task menu mixes worktrees, local branches and origin branches", async () => {
  const c = fakeContext({
    rules: rules([
      { match: "for-each-ref --format='%(refname:short)' refs/heads/agent", stdout: "agent/cli\nagent/docs\n" },
      { match: "for-each-ref --format='%(refname:short)' refs/remotes/origin/agent", stdout: "origin/agent/api\n" },
      { match: "show-ref --verify --quiet refs/remotes/origin/agent/api", code: 0 },
    ]),
    answers: [4],
  });
  await cmdStart(c, "moroine/agent-forge", undefined);
  const menu = c.err_lines.join("\n");
  assert.ok(menu.includes("new task"), menu);
  assert.ok(menu.includes("cli (existing worktree — attach)"), menu);
  assert.ok(menu.includes("docs (local branch)"), menu);
  assert.ok(menu.includes("api (branch on origin)"), menu);
  assert.ok(menu.includes("other branch…"), menu);
  assert.ok(added(c).includes("-b agent/api origin/agent/api"), added(c));
});

test("other branch… branches agent/<task> from the named ref", async () => {
  const c = fakeContext({ rules: rules(), answers: [3, "origin/feature/thing", "thing"] });
  await cmdStart(c, "moroine/agent-forge", undefined);
  assert.ok(added(c).includes("worktree add .trees/thing -b agent/thing origin/feature/thing"), added(c));
});

test("other branch… refuses to overwrite an existing agent branch", async () => {
  const c = fakeContext({
    rules: rules([{ match: "show-ref --verify --quiet refs/heads/agent/thing", code: 0 }]),
    answers: [3, "origin/feature/thing", "thing"],
  });
  await assert.rejects(() => cmdStart(c, "moroine/agent-forge", undefined), /already exists/);
});

test("with no TTY, a missing task is a usage error rather than a hang", async () => {
  const c = fakeContext({ rules: rules(), tty: false });
  await assert.rejects(() => cmdStart(c, "moroine/agent-forge", undefined), /Usage: forge start/);
});

test("an invalid ref from the menu is rejected before reaching su -c", async () => {
  const c = fakeContext({ rules: rules(), answers: [3, "--upload-pack=evil", "x"] });
  await assert.rejects(() => cmdStart(c, "moroine/agent-forge", undefined), /must not start with/);
});
