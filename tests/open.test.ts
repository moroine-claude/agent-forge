import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdOpen } from "../cli/lib/commands/open.ts";
import { saveHost, type LaptopHost } from "../cli/lib/laptop/state.ts";
import { fakeContext } from "./lib/fake-context.ts";

const ENV = ["FORGE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "FORGE_SSH_DIR", "LIMA_HOME"];
let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = mkdtempSync(join(tmpdir(), "forge-open-"));
  process.env.FORGE_HOME = tmp;
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

function host(name: string): LaptopHost {
  return {
    name, kind: "remote", address: "203.0.113.10", port: 22, user: "alice", admin: "ubuntu",
    adminKey: "/keys/admin", exposure: "public", done: [],
  };
}

test("open attaches herdr to the only host", async () => {
  saveHost(host("forge-acme"));
  const ctx = fakeContext({ attachCode: 0 });
  assert.equal(await cmdOpen(ctx, {}), 0);
  assert.deepEqual(ctx.attachCalls.map((a) => a.argv), [
    ["herdr", "--remote", "forge-acme", "--remote-keybindings", "server"],
  ]);
});

test("open with two hosts and --host attaches that one", async () => {
  saveHost(host("forge-acme"));
  saveHost(host("forge-beta"));
  const ctx = fakeContext();
  assert.equal(await cmdOpen(ctx, { host: "forge-beta" }), 0);
  assert.deepEqual(ctx.attachCalls.map((a) => a.argv), [
    ["herdr", "--remote", "forge-beta", "--remote-keybindings", "server"],
  ]);
});

test("open returns herdr's exit code", async () => {
  saveHost(host("forge-acme"));
  assert.equal(await cmdOpen(fakeContext({ attachCode: 3 }), {}), 3);
});

test("open with no host yet says to install one", async () => {
  await assert.rejects(cmdOpen(fakeContext(), {}), /forge install/);
});
