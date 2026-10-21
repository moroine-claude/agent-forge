// Layer 3 for the provisioning markers and the recreate flow (spec DX,
// "Testing"): the real `incus`, opt-in, on a disposable Incus.
//
//   FORGE_INTEGRATION=1 node --test tests/integration/provisioning.test.ts
//
// Unlike incus.test.ts this runs against the real `agent-forge` project: the
// flow reads the markers through forge's own functions, which talk to the
// project FORGE_INCUS_PROJECT names (default agent-forge). It needs the
// agent-base image there (`forge image build`), else it is skipped. The
// instance is only created (`incus init`, never started), carries the test
// prefix, and is deleted at the end; the workspace directory is a temporary
// one under FORGE_WORKSPACES.
import { test, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "../../cli/lib/context.ts";
import {
  checkNameCollision, PROVISIONING_KEY, PROVISIONING_WORKSPACE_KEY, provisioningMarker,
} from "../../cli/lib/containers.ts";
import { discardHalfProvisioned } from "../../cli/lib/commands/provision.ts";
import { configUnset } from "../../cli/lib/incus.ts";
import { ENABLED, PREFIX, incus, must, raw } from "./lib.ts";

const PROJECT = "agent-forge";
const REPO = "forge-selftest/provisioning";
const saved = { project: process.env.FORGE_INCUS_PROJECT, ws: process.env.FORGE_WORKSPACES };
const root = ENABLED ? mkdtempSync(join(tmpdir(), "forge-selftest-prov-")) : "";
const id = Math.random().toString(36).slice(2, 8);
const names: string[] = [];

if (ENABLED) {
  process.env.FORGE_INCUS_PROJECT = PROJECT;
  process.env.FORGE_WORKSPACES = join(root, "workspaces");
}

after(() => {
  if (!ENABLED) return;
  // Only what this file created: the name prefix is the guard.
  for (const name of names) {
    if (name.startsWith(PREFIX)) incus(PROJECT, ["delete", name, "--force"]);
  }
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["FORGE_INCUS_PROJECT", saved.project], ["FORGE_WORKSPACES", saved.ws]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// A stopped instance carrying both provisioning markers and no user.forge.repo.
function initMarked(name: string, workspace: "new" | "kept") {
  names.push(name);
  must(`init ${name}`, incus(PROJECT, [
    "init", "agent-base", name, "--profile", "agent-forge",
    "-c", `${PROVISIONING_KEY}=${REPO}`, "-c", `${PROVISIONING_WORKSPACE_KEY}=${workspace}`,
  ]));
}

const hasImage = () => ENABLED && incus(PROJECT, ["image", "info", "agent-base"]).status === 0;

test("a kept workspace survives discardHalfProvisioned; markers read back empty after unset", { skip: !ENABLED }, async (t: TestContext) => {
  if (!hasImage()) return t.skip(`no agent-base in project ${PROJECT} (run 'forge image build')`);
  const ctx = createContext();
  const name = `${PREFIX}prov-${id}-k`;
  initMarked(name, "kept");
  assert.equal(await checkNameCollision(ctx, name, REPO), "half-provisioned");
  assert.deepEqual(await provisioningMarker(ctx, name), { repo: REPO, workspace: "kept" });

  // The markers come off with config unset (what provisioning does last).
  for (const key of [PROVISIONING_KEY, PROVISIONING_WORKSPACE_KEY]) {
    assert.equal((await configUnset(ctx, name, key)).code, 0, `unset ${key}`);
    const got = incus(PROJECT, ["config", "get", name, key]);
    assert.equal(got.stdout.trim(), "", raw(`config get ${key}`, got));
  }
  assert.equal(await provisioningMarker(ctx, name), null);
  // Put them back: the discard below is what this test is about.
  must("set markers", incus(PROJECT, ["config", "set", name, `${PROVISIONING_KEY}=${REPO}`, `${PROVISIONING_WORKSPACE_KEY}=kept`]));

  const dir = join(process.env.FORGE_WORKSPACES!, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "work.txt"), "unrecovered work");
  assert.equal(await discardHalfProvisioned(ctx, name), "kept");
  assert.notEqual(incus(PROJECT, ["info", name]).status, 0, "the instance should be gone");
  assert.equal(readFileSync(join(dir, "work.txt"), "utf8"), "unrecovered work");
});

test("a workspace the failed attempt created is emptied, its directory kept", { skip: !ENABLED }, async (t: TestContext) => {
  if (!hasImage()) return t.skip(`no agent-base in project ${PROJECT} (run 'forge image build')`);
  const ctx = createContext();
  const name = `${PREFIX}prov-${id}-n`;
  initMarked(name, "new");
  assert.equal(await checkNameCollision(ctx, name, REPO), "half-provisioned");

  const dir = join(process.env.FORGE_WORKSPACES!, name);
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "partial.txt"), "x");
  assert.equal(await discardHalfProvisioned(ctx, name), "emptied");
  assert.notEqual(incus(PROJECT, ["info", name]).status, 0, "the instance should be gone");
  assert.ok(existsSync(dir));
  assert.deepEqual(readdirSync(dir), []);
});
