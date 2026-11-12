import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { discardHalfProvisioned } from "../cli/lib/commands/provision.ts";

// The provisioning of a member is tested in team-provision*.test.ts; what is
// left here is the discard of an interrupted one.
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-prov-"));
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.FORGE_WORKSPACES;
});

function seedWorkspace(...files: string[]) {
  const dir = join(home, "workspaces", "agent-x");
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), "x");
  return dir;
}

// Nothing that existed before the failed attempt may be deleted: a reused
// workspace can hold the only copy of unretrieved work.
test("discarding removes the instance and empties a workspace the failed attempt created", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-x", { config: { "user.forge.provisioning": "o/r", "user.forge.provisioning_workspace": "new" } });
  const dir = seedWorkspace("partial");
  await discardHalfProvisioned(fakeContext({ incus: fake }), "agent-x");
  assert.equal(fake.instances.get("agent-forge")!.has("agent-x"), false);
  assert.deepEqual(readdirSync(dir), []);
});

test("discarding keeps a workspace the failed attempt reused", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-x", { config: { "user.forge.provisioning": "o/r", "user.forge.provisioning_workspace": "kept" } });
  const dir = seedWorkspace("unretrieved");
  await discardHalfProvisioned(fakeContext({ incus: fake }), "agent-x");
  assert.equal(fake.instances.get("agent-forge")!.has("agent-x"), false);
  assert.deepEqual(readdirSync(dir), ["unretrieved"]);
});
