import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdTaskBase } from "../cli/lib/commands/task-base.ts";
import { ForgeError } from "../cli/lib/context.ts";

const listing = (config: Record<string, string>) => [{
  match: "incus --project agent-forge list",
  stdout: JSON.stringify([
    { name: "agent-other", status: "Running", config: { "user.forge.base.nope": "main" } },
    { name: "agent-x", status: "Running", config: { "user.forge.repo": "o/r", ...config } },
  ]),
}];

test("a task's base is printed", async () => {
  const c = fakeContext({ rules: listing({ "user.forge.base.fix": "origin/main", "user.forge.base.b": "dev" }) });
  assert.equal(await cmdTaskBase(c, "agent-x", "fix"), 0);
  assert.deepEqual(c.out_lines, ["origin/main"]);
});

test("every recorded task is printed, sorted, tab-separated", async () => {
  const c = fakeContext({ rules: listing({
    "user.forge.base.zeta": "origin/main", "user.forge.base.alpha": "origin/feature/x",
  }) });
  assert.equal(await cmdTaskBase(c, "agent-x"), 0);
  assert.deepEqual(c.out_lines, ["alpha\torigin/feature/x", "zeta\torigin/main"]);
});

test("no recorded base prints nothing and exits 0", async () => {
  const c = fakeContext({ rules: listing({}) });
  assert.equal(await cmdTaskBase(c, "agent-x"), 0);
  assert.equal(await cmdTaskBase(c, "agent-x", "fix"), 0);
  assert.deepEqual(c.out_lines, []);
});

test("an invalid recorded base reads as unknown", async () => {
  const c = fakeContext({ rules: listing({ "user.forge.base.fix": "main;rm" }) });
  assert.equal(await cmdTaskBase(c, "agent-x", "fix"), 0);
  assert.equal(await cmdTaskBase(c, "agent-x"), 0);
  assert.deepEqual(c.out_lines, []);
});

test("an invalid container or task name is refused before any call", async () => {
  const c = fakeContext({ rules: listing({}) });
  await assert.rejects(() => cmdTaskBase(c, "x; rm"), ForgeError);
  await assert.rejects(() => cmdTaskBase(c, undefined), ForgeError);
  await assert.rejects(() => cmdTaskBase(c, "agent-x", "a b"), ForgeError);
  assert.deepEqual(c.calls, []);
});
