import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdStop } from "../scripts/lib/commands/stop.ts";
import { cmdDelete } from "../scripts/lib/commands/delete.ts";

const RULES = [
  { match: "agent-moroine-agent-forge user.forge.repo", stdout: "moroine/agent-forge" },
  { match: "lxc list", stdout: JSON.stringify([{ name: "agent-moroine-agent-forge", status: "Running" }]) },
  { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\n" },
  { match: "status --porcelain", stdout: " M scripts/forge\n" },
];

test("stop runs the WIP pre-flight and refuses a dirty worktree", async () => {
  const c = fakeContext({ rules: RULES });
  await assert.rejects(() => cmdStop(c, "moroine/agent-forge", false), /uncommitted changes/);
  assert.ok(!c.calls.some((call) => call[1] === "stop"));
});

test("stop --force skips the pre-flight and stops the container", async () => {
  const c = fakeContext({ rules: RULES });
  assert.equal(await cmdStop(c, "moroine/agent-forge", true), 0);
  assert.ok(c.calls.some((call) => call.join(" ") === "lxc stop agent-moroine-agent-forge"));
  assert.ok(!c.calls.some((call) => call.join(" ").includes("status --porcelain")));
});

test("stop asks for the repo when it is missing", async () => {
  const c = fakeContext({ rules: RULES, answers: [1] });
  await cmdStop(c, undefined, true);
  assert.ok(c.calls.some((call) => call.join(" ") === "lxc stop agent-moroine-agent-forge"));
});

test("delete skips the pre-flight on an already stopped container", async () => {
  const c = fakeContext({
    rules: [
      { match: "agent-x user.forge.repo", stdout: "o/r" },
      { match: "lxc list", stdout: JSON.stringify([{ name: "agent-x", status: "Stopped" }]) },
    ],
  });
  assert.equal(await cmdDelete(c, "o/r", false), 0);
  assert.ok(!c.calls.some((call) => call.join(" ").includes("status --porcelain")));
  assert.ok(c.calls.some((call) => call.join(" ") === "lxc delete agent-x --force"));
});

test("delete runs the pre-flight on a running container", async () => {
  const c = fakeContext({ rules: RULES });
  await assert.rejects(() => cmdDelete(c, "moroine/agent-forge", false), /uncommitted changes/);
});
