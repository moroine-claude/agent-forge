import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdOpen } from "../cli/lib/commands/open.ts";
import { ForgeError } from "../cli/lib/context.ts";
import { saveHost, type LaptopHost } from "../cli/lib/laptop/state.ts";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";

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

// The local VM is stopped after a laptop reboot: open starts it first.
const LIMA: LaptopHost = { ...host("forge-local"), kind: "lima", address: "127.0.0.1", port: 60022, exposure: "local" };
const HERDR_LOCAL = ["herdr", "--remote", "forge-local", "--remote-keybindings", "server"];
const listed = (status: string): ExecRule => ({
  match: "limactl list --json forge-local",
  stdout: JSON.stringify({ name: "forge-local", status, sshLocalPort: 60022, config: { user: { name: "alice" } } }) + "\n",
});

test("open starts a stopped local VM before herdr", async () => {
  saveHost(LIMA);
  const ctx = fakeContext({ rules: [listed("Stopped")] });
  assert.equal(await cmdOpen(ctx, {}), 0);
  assert.deepEqual(ctx.attachCalls.map((a) => a.argv), [["limactl", "start", "--tty=false", "forge-local"], HERDR_LOCAL]);
});

test("open attaches herdr to a running local VM without starting it", async () => {
  saveHost(LIMA);
  const ctx = fakeContext({ rules: [listed("Running")] });
  assert.equal(await cmdOpen(ctx, {}), 0);
  assert.deepEqual(ctx.attachCalls.map((a) => a.argv), [HERDR_LOCAL]);
});

test("open says when the local VM fails to start", async () => {
  saveHost(LIMA);
  const ctx = fakeContext({ rules: [listed("Stopped")], attachRules: [{ match: "limactl start", code: 1 }] });
  await assert.rejects(cmdOpen(ctx, {}), (e: Error) => e instanceof ForgeError && /limactl start/.test(e.message) && /forge-local/.test(e.message));
  assert.equal(ctx.attachCalls.length, 1);
});

test("open says a gone local VM is offered to be forgotten by forge install", async () => {
  saveHost(LIMA);
  const ctx = fakeContext({ rules: [{ match: "limactl list --json", code: 1, stderr: 'msg="No instance matching forge-local found."' }] });
  await assert.rejects(cmdOpen(ctx, {}), (e: Error) =>
    e instanceof ForgeError && /forge-local/.test(e.message) && /gone/.test(e.message) && /forge install/.test(e.message) && /forget/.test(e.message));
  assert.deepEqual(ctx.attachCalls, []);
});

test("open never asks Lima about a remote host", async () => {
  saveHost(host("forge-acme"));
  const ctx = fakeContext();
  await cmdOpen(ctx, {});
  assert.ok(!ctx.calls.some((c) => c[0] === "limactl"));
});
