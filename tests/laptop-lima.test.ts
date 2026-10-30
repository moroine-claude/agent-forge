import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeContext, type ExecRule, type FakeContext } from "./lib/fake-context.ts";
import { ForgeError } from "../cli/lib/context.ts";
import { ensureLimaVm, freePort, limaInstance, LIMA_DEFAULT_PORT, LIMA_NAME } from "../cli/lib/laptop/lima.ts";

const TEMPLATE = "/repo/ansible/lima/forge.yaml";

function inst(status: string, port: number, user = "alice"): string {
  return JSON.stringify({ name: LIMA_NAME, status, sshLocalPort: port, config: { user: { name: user } } }) + "\n";
}

const ABSENT: ExecRule = {
  match: "limactl list --json",
  code: 1,
  stderr: 'level=warning msg="No instance matching forge-local found."\nlevel=fatal msg="unmatched instances"',
};

// Isolated Lima home and state: nothing touches the real ones.
function withTmpEnv<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "forge-lima-"));
  const saved = { l: process.env.LIMA_HOME, x: process.env.XDG_CONFIG_HOME };
  process.env.LIMA_HOME = join(dir, "lima");
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  return fn().finally(() => {
    for (const [k, v] of [["LIMA_HOME", saved.l], ["XDG_CONFIG_HOME", saved.x]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

const noSleep = async () => {};
const fixedPort = (p: number) => async () => p;
const sshCalls = (ctx: FakeContext) => ctx.calls.filter((c) => c[0] === "ssh");

// The fake's rules are static: an instance that starts absent and exists after
// the create needs state, so `limactl list --json` is answered by this wrapper.
function statefulCtx(afterCreate: { status: string; port: number }, extra: ExecRule[] = []) {
  const ctx = fakeContext({ rules: extra });
  let created = false;
  let started = false;
  const exec = ctx.exec;
  const attach = ctx.attach;
  ctx.attach = async (argv, o) => {
    if (argv.includes("create")) created = true;
    if (argv.includes("start")) started = true;
    return attach(argv, o);
  };
  ctx.exec = async (argv, o) => {
    if (argv.join(" ").startsWith("limactl list --json")) {
      ctx.calls.push(argv);
      if (!created) return { code: 1, stdout: "", stderr: "No instance matching forge-local found." };
      return { code: 0, stdout: inst(started ? "Running" : afterCreate.status, afterCreate.port), stderr: "" };
    }
    return exec(argv, o);
  };
  return ctx;
}

test("limaInstance is null for an absent instance", async () => {
  const ctx = fakeContext({ rules: [ABSENT] });
  assert.equal(await limaInstance(ctx, LIMA_NAME), null);
});

test("limaInstance reads status, port and user from the first JSON line", async () => {
  const ctx = fakeContext({ rules: [{ match: "limactl list --json forge-local", stdout: inst("Stopped", 60022) + inst("Running", 1) }] });
  assert.deepEqual(await limaInstance(ctx, LIMA_NAME), { status: "Stopped", port: 60022, user: "alice" });
});

test("limaInstance falls back to limactl shell for the user", async () => {
  const ctx = fakeContext({
    rules: [
      { match: "limactl list --json", stdout: inst("Running", 60022, "") },
      { match: "limactl shell --workdir / forge-local id -un", stdout: "bob\n" },
    ],
  });
  assert.equal((await limaInstance(ctx, LIMA_NAME))?.user, "bob");
});

test("limaInstance throws on another failure", async () => {
  const ctx = fakeContext({ rules: [{ match: "limactl list --json", code: 1, stderr: "boom" }] });
  await assert.rejects(limaInstance(ctx, LIMA_NAME), ForgeError);
});

test("freePort returns the preferred port when it is free", async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  assert.equal(await freePort(port), port);
});

test("freePort returns another port when the preferred one is taken", async () => {
  const taken = createServer();
  await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
  const port = (taken.address() as { port: number }).port;
  try {
    const got = await freePort(port);
    assert.notEqual(got, port);
    assert.ok(got > 0);
  } finally {
    await new Promise<void>((r) => taken.close(() => r()));
  }
});

test("ensureLimaVm creates then starts an absent VM with the chosen port", () => withTmpEnv(async () => {
  const ctx = statefulCtx({ status: "Stopped", port: 61234 });
  const r = await ensureLimaVm(ctx, TEMPLATE, { sleep: noSleep, freePort: fixedPort(61234) });
  assert.deepEqual(ctx.attachCalls.map((a) => a.argv), [
    ["limactl", "create", "--tty=false", "--name", "forge-local", "--set", ".ssh.localPort = 61234", TEMPLATE],
    ["limactl", "start", "--tty=false", "forge-local"],
  ]);
  assert.equal(r.port, 61234);
  assert.equal(r.admin, "alice");
  assert.equal(r.adminKey, join(process.env.LIMA_HOME!, "_config", "user"));
}));

// A first install stopped after the SSH wait, then `limactl delete`: the new VM
// has new host keys, which accept-new would refuse under the old aliases.
test("ensureLimaVm forgets forge-local's host keys before creating the VM", () => withTmpEnv(async () => {
  const kh = join(process.env.XDG_CONFIG_HOME!, "agent-forge", "known_hosts");
  mkdirSync(dirname(kh), { recursive: true });
  writeFileSync(kh, "forge-local-admin ssh-ed25519 AAAAold\n");
  const ctx = statefulCtx({ status: "Stopped", port: 61234 });
  await ensureLimaVm(ctx, TEMPLATE, { sleep: noSleep, freePort: fixedPort(61234) });
  const joined = ctx.calls.map((c) => c.join(" "));
  const create = joined.findIndex((c) => c.startsWith("limactl create"));
  assert.deepEqual(joined.slice(create - 2, create), [
    `ssh-keygen -R forge-local -f ${kh}`, `ssh-keygen -R forge-local-admin -f ${kh}`,
  ]);
}));

test("ensureLimaVm without known_hosts creates the VM without ssh-keygen", () => withTmpEnv(async () => {
  const ctx = statefulCtx({ status: "Stopped", port: 61234 });
  await ensureLimaVm(ctx, TEMPLATE, { sleep: noSleep, freePort: fixedPort(61234) });
  assert.ok(!ctx.calls.some((c) => c[0] === "ssh-keygen"));
}));

test("ensureLimaVm keeps the host keys of an existing VM", () => withTmpEnv(async () => {
  const kh = join(process.env.XDG_CONFIG_HOME!, "agent-forge", "known_hosts");
  mkdirSync(dirname(kh), { recursive: true });
  writeFileSync(kh, "forge-local-admin ssh-ed25519 AAAAcurrent\n");
  const ctx = fakeContext({ rules: [{ match: "limactl list --json", stdout: inst("Stopped", 60022) }] });
  await ensureLimaVm(ctx, TEMPLATE, { sleep: noSleep });
  assert.ok(!ctx.calls.some((c) => c[0] === "ssh-keygen"));
}));

test("ensureLimaVm only starts a stopped VM, on its own port", () => withTmpEnv(async () => {
  const ctx = fakeContext({ rules: [{ match: "limactl list --json", stdout: inst("Stopped", 60022) }] });
  const r = await ensureLimaVm(ctx, TEMPLATE, { sleep: noSleep });
  assert.deepEqual(ctx.attachCalls.map((a) => a.argv), [["limactl", "start", "--tty=false", "forge-local"]]);
  assert.equal(r.port, 60022);
}));

test("ensureLimaVm does nothing to a running VM except wait for it", () => withTmpEnv(async () => {
  const ctx = fakeContext({ rules: [{ match: "limactl list --json", stdout: inst("Running", 60022) }] });
  await ensureLimaVm(ctx, TEMPLATE, { sleep: noSleep });
  assert.deepEqual(ctx.attachCalls, []);
}));

test("ensureLimaVm fails when the port read back differs", () => withTmpEnv(async () => {
  const ctx = statefulCtx({ status: "Stopped", port: 50000 });
  await assert.rejects(
    ensureLimaVm(ctx, TEMPLATE, { sleep: noSleep, freePort: fixedPort(61234) }),
    (e: Error) => e instanceof ForgeError && /50000/.test(e.message) && /61234/.test(e.message),
  );
}));

test("ensureLimaVm refuses an existing VM whose port Lima picks at each start", () => withTmpEnv(async () => {
  const ctx = fakeContext({ rules: [{ match: "limactl list --json", stdout: inst("Stopped", 0) }] });
  await assert.rejects(ensureLimaVm(ctx, TEMPLATE, { sleep: noSleep }), /forge install/);
  assert.deepEqual(ctx.attachCalls, []);
}));

test("ensureLimaVm names the failed step when create or start exits non-zero", () => withTmpEnv(async () => {
  const create = fakeContext({ rules: [ABSENT], attachCode: 3 });
  await assert.rejects(ensureLimaVm(create, TEMPLATE, { sleep: noSleep, freePort: fixedPort(61234) }), /limactl create/);
  const start = fakeContext({ rules: [{ match: "limactl list --json", stdout: inst("Stopped", 60022) }], attachCode: 3 });
  await assert.rejects(ensureLimaVm(start, TEMPLATE, { sleep: noSleep }), /limactl start/);
}));

test("ensureLimaVm waits for SSH with forge's own known_hosts and the admin key", () => withTmpEnv(async () => {
  let tries = 0;
  const ctx = fakeContext({ rules: [{ match: "limactl list --json", stdout: inst("Running", 60022) }] });
  const exec = ctx.exec;
  ctx.exec = async (argv, o) => {
    if (argv[0] === "ssh" && argv.at(-1) === "true" && ++tries < 3) return { code: 255, stdout: "", stderr: "refused" };
    return exec(argv, o);
  };
  let sleeps = 0;
  await ensureLimaVm(ctx, TEMPLATE, { sleep: async () => { sleeps++; } });
  assert.equal(sleeps, 2);
  const first = sshCalls(ctx)[0];
  const j = first.join(" ");
  assert.match(j, /-o BatchMode=yes -o ConnectTimeout=5 -o IdentitiesOnly=yes/);
  assert.ok(j.includes(`UserKnownHostsFile=${join(process.env.XDG_CONFIG_HOME!, "agent-forge", "known_hosts")}`));
  assert.ok(j.includes("HostKeyAlias=forge-local-admin"));
  assert.ok(j.includes("StrictHostKeyChecking=accept-new"));
  assert.ok(j.includes(`-i ${join(process.env.LIMA_HOME!, "_config", "user")} -p 60022 alice@127.0.0.1 true`));
}));

test("ensureLimaVm quotes a known_hosts path with a space for ssh", () => withTmpEnv(async () => {
  process.env.XDG_CONFIG_HOME = join(process.env.XDG_CONFIG_HOME!, "my config");
  const ctx = fakeContext({ rules: [{ match: "limactl list --json", stdout: inst("Running", 60022) }] });
  await ensureLimaVm(ctx, TEMPLATE, { sleep: noSleep });
  const known = join(process.env.XDG_CONFIG_HOME, "agent-forge", "known_hosts");
  assert.ok(sshCalls(ctx)[0].includes(`UserKnownHostsFile="${known}"`), sshCalls(ctx)[0].join(" "));
}));

test("ensureLimaVm gives up after 60 SSH tries", () => withTmpEnv(async () => {
  const ctx = fakeContext({ rules: [{ match: "limactl list --json", stdout: inst("Running", 60022) }, { match: "ssh ", code: 255 }] });
  let sleeps = 0;
  await assert.rejects(ensureLimaVm(ctx, TEMPLATE, { sleep: async () => { sleeps++; } }), /SSH/);
  assert.equal(sshCalls(ctx).length, 60);
  assert.equal(sleeps, 59);
}));

test("ensureLimaVm accepts cloud-init exit 2 and rejects other failures", () => withTmpEnv(async () => {
  const list: ExecRule = { match: "limactl list --json", stdout: inst("Running", 60022) };
  const two = fakeContext({ rules: [list, { match: "cloud-init status --wait", code: 2 }] });
  await ensureLimaVm(two, TEMPLATE, { sleep: noSleep });
  const bad = fakeContext({ rules: [list, { match: "cloud-init status --wait", code: 1 }] });
  await assert.rejects(ensureLimaVm(bad, TEMPLATE, { sleep: noSleep }), /cloud-init/);
}));

test("the defaults are forge-local on port 60022", () => {
  assert.equal(LIMA_NAME, "forge-local");
  assert.equal(LIMA_DEFAULT_PORT, 60022);
});
