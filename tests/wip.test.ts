import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { checkWorktree } from "../scripts/lib/wip.ts";

const clean = { match: "status --porcelain", stdout: "" };
const onBranch = { match: "rev-parse --abbrev-ref HEAD", stdout: "agent/cli\n" };

test("a dirty tree is refused, and the diff is shown", async () => {
  const ctx = fakeContext({
    rules: [{ match: "status --porcelain", stdout: " M scripts/forge\n" }],
  });
  await assert.rejects(
    () => checkWorktree(ctx, "agent-x", "/workspace/.trees/cli"),
    /uncommitted changes[\s\S]*scripts\/forge/,
  );
});

test("a supervised container is only checked for dirtiness", async () => {
  const ctx = fakeContext({
    rules: [clean, { match: "user.forge.mode", stdout: "supervised" }],
  });
  await checkWorktree(ctx, "agent-x", "/workspace/.trees/cli");
  assert.ok(!ctx.calls.some((c) => c.join(" ").includes("origin/main..")));
});

test("an unexpected branch name is refused", async () => {
  const ctx = fakeContext({
    rules: [
      clean,
      { match: "user.forge.mode", stdout: "autonomous" },
      { match: "rev-parse --abbrev-ref HEAD", stdout: "main\n" },
    ],
  });
  await assert.rejects(() => checkWorktree(ctx, "agent-x", "/workspace/.trees/cli"), /unexpected branch name/);
});

test("commits ahead of main with no origin branch are refused", async () => {
  const ctx = fakeContext({
    rules: [
      clean,
      { match: "user.forge.mode", stdout: "autonomous" },
      onBranch,
      { match: "origin/main..", stdout: "abc feat: x\n" },
      { match: "rev-parse --verify origin/", code: 1 },
    ],
  });
  await assert.rejects(() => checkWorktree(ctx, "agent-x", "/workspace/.trees/cli"), /never been pushed/);
});

test("unpushed commits are refused and listed", async () => {
  const ctx = fakeContext({
    rules: [
      clean,
      { match: "user.forge.mode", stdout: "autonomous" },
      onBranch,
      { match: "origin/main..", stdout: "abc feat: x\n" },
      { match: "rev-parse --verify origin/", code: 0 },
      { match: "origin/agent/cli..", stdout: "abc feat: x\n" },
    ],
  });
  await assert.rejects(() => checkWorktree(ctx, "agent-x", "/workspace/.trees/cli"), /unpushed commits[\s\S]*feat: x/);
});

test("a clean, fully pushed worktree passes", async () => {
  const ctx = fakeContext({
    rules: [
      clean,
      { match: "user.forge.mode", stdout: "autonomous" },
      onBranch,
      { match: "origin/main..", stdout: "" },
    ],
  });
  await checkWorktree(ctx, "agent-x", "/workspace/.trees/cli");
});
