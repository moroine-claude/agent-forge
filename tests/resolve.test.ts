import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { resolveRepo } from "../cli/lib/commands/resolve.ts";

const LIST = JSON.stringify([
  { name: "agent-alice-project", status: "Running" },
  { name: "agent-acme-widgets", status: "Running" },
]);
const RULES = [
  { match: "agent-alice-project user.forge.repo", stdout: "alice/project" },
  { match: "agent-acme-widgets user.forge.repo", stdout: "acme/widgets" },
  { match: "incus --project agent-forge list", stdout: LIST },
];

test("a provided repo is returned untouched, with no prompt", async () => {
  const c = fakeContext({ rules: RULES });
  assert.equal(await resolveRepo(c, "given/repo", "usage"), "given/repo");
  assert.equal(c.err_lines.length, 0);
});

test("a missing repo is picked from the managed repos", async () => {
  const c = fakeContext({ rules: RULES, answers: [2] });
  assert.equal(await resolveRepo(c, undefined, "usage"), "acme/widgets");
});

test("resolveRepo throws the usage when it cannot ask", async () => {
  const c = fakeContext({ rules: RULES, tty: false });
  await assert.rejects(() => resolveRepo(c, undefined, "Usage: forge stop <owner/repo>"), /Usage: forge stop/);
});

test("resolveRepo explains when no container exists at all", async () => {
  const c = fakeContext({ rules: [{ match: "incus --project agent-forge list", stdout: "[]" }] });
  await assert.rejects(() => resolveRepo(c, undefined, "usage"), /no single-agent forge container/);
});
