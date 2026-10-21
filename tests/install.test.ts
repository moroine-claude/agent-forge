import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { cmdInstall } from "../cli/lib/commands/install.ts";
import { ForgeError } from "../cli/lib/context.ts";
import {
  forgeKeyPath, inventoryPath, knownHostsPath, loadHosts, saveHost, type InstallStep, type LaptopHost,
} from "../cli/lib/laptop/state.ts";
import { fakeContext, type ExecRule, type FakeContext } from "./lib/fake-context.ts";

// Every laptop path lives in a temporary home: never the real one, never the
// real ~/.ssh, never a real VM.
const ENV: Record<string, string> = {
  FORGE_HOME: "", XDG_CONFIG_HOME: ".config", XDG_DATA_HOME: ".local/share", FORGE_SSH_DIR: ".ssh", LIMA_HOME: ".lima",
};
let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-install-"));
  for (const [k, rel] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = join(home, rel); }
  // A laptop's usual directories exist already.
  for (const d of [".config", ".local/share", ".ssh"]) mkdirSync(join(home, d), { recursive: true });
});
afterEach(() => {
  for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(home, { recursive: true, force: true });
});

const CHECKOUT = "/src/agent-forge";
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKeyOne alice@laptop";
const KEY2 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKeyTwo alice@work";
const OPTS = { checkout: CHECKOUT, lima: { sleep: async () => {}, freePort: async () => 60022 } };
const REMOTE = { ...OPTS, remote: "203.0.113.10" };
const ALL: InstallStep[] = ["vm", "inventory", "playbook", "ssh", "identity", "claude", "setup", "image"];
const HERDR_LOCAL = ["herdr", "--remote", "forge-local", "--remote-keybindings", "server"];
const INCLUDE = "Add `Include config.d/*` at the top of ~/.ssh/config?";
const LINK = `Link ~/.local/bin/forge to ${CHECKOUT}/cli/forge?`;

const BASE: ExecRule[] = [
  { match: "limactl --version", stdout: "limactl version 2.1.2\n" },
  { match: "ansible-playbook --version", stdout: "ansible-playbook [core 2.20.1]\n" },
  { match: "ssh-add -L", stdout: `${KEY}\n` },
  { match: "git config --global user.name", stdout: "Alice Example\n" },
  { match: "git config --global user.email", stdout: "alice@example.com\n" },
];
const NO_LOGIN: ExecRule = { match: "'test' '-e' '.claude/.credentials.json'", code: 1 };

// The Lima VM outlives a run: `limactl list` answers from this world, which
// `limactl create` and `limactl start` change.
type World = { vm: { status: string; port: number; user: string } | null };

function laptop(
  world: World,
  o: { rules?: ExecRule[]; answers?: (number | string | null)[]; attachRules?: ExecRule[] } = {},
): FakeContext {
  const ctx = fakeContext({ rules: [...(o.rules ?? []), ...BASE], answers: o.answers, attachRules: o.attachRules });
  const { exec, attach } = ctx;
  ctx.exec = async (argv, opts) => {
    if (argv[0] === "limactl" && argv[1] === "list") {
      ctx.calls.push(argv);
      ctx.execOptions.push(opts);
      if (!world.vm) return { code: 1, stdout: "", stderr: 'level=warning msg="No instance matching forge-local found."' };
      const { status, port, user } = world.vm;
      return { code: 0, stdout: JSON.stringify({ name: "forge-local", status, sshLocalPort: port, config: { user: { name: user } } }) + "\n", stderr: "" };
    }
    return exec(argv, opts);
  };
  ctx.attach = async (argv, opts) => {
    const code = await attach(argv, opts);
    if (code === 0 && argv[0] === "limactl" && argv[1] === "create") {
      const port = Number(argv[argv.indexOf("--set") + 1].split("= ")[1]);
      world.vm = { status: "Stopped", port, user: "alice" };
    }
    if (code === 0 && argv[0] === "limactl" && argv[1] === "start" && world.vm) world.vm.status = "Running";
    return code;
  };
  return ctx;
}

const attached = (ctx: FakeContext) => ctx.attachCalls.map((a) => a.argv.join(" "));
const called = (ctx: FakeContext) => ctx.calls.map((c) => c.join(" "));
// The labels of the questions asked (the fake prompt logs `label> ` or `label> [items]`).
const asked = (ctx: FakeContext) =>
  ctx.err_lines.filter((l) => /> (\[.*\])?$/.test(l)).map((l) => l.replace(/> (\[.*\])?$/, ""));
const firstIndex = (ctx: FakeContext, part: string) => called(ctx).findIndex((c) => c.includes(part));

async function finishedLocal(world: World): Promise<void> {
  const ctx = laptop(world, { answers: [0, 0] });
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.deepEqual(loadHosts()[0].done, ALL);
}

test("a first local install runs every step in order and ends in herdr", async () => {
  const world: World = { vm: null };
  const ctx = laptop(world, { rules: [NO_LOGIN], answers: [0, 0] });
  assert.equal(await cmdInstall(ctx, OPTS), 0);

  const collections = join(home, ".local/share/agent-forge/collections");
  assert.deepEqual(ctx.attachCalls.map((a) => a.argv), [
    ["limactl", "create", "--tty=false", "--name", "forge-local", "--set", ".ssh.localPort = 60022", `${CHECKOUT}/ansible/lima/forge.yaml`],
    ["limactl", "start", "--tty=false", "forge-local"],
    ["ansible-galaxy", "collection", "install", "-r", `${CHECKOUT}/ansible/requirements.yml`, "-p", collections],
    ["ansible-playbook", "-i", inventoryPath("forge-local"), `${CHECKOUT}/ansible/site.yml`],
    ["ssh", "-t", "forge-local", "--", "'claude' 'auth' 'login'"],
    ["ssh", "forge-local", "--", "'forge' 'setup'"],
    ["ssh", "-t", "forge-local", "--", "'forge' 'image' 'build'"],
    HERDR_LOCAL,
  ]);
  for (const a of ctx.attachCalls.filter((c) => c.argv[0].startsWith("ansible"))) {
    assert.deepEqual(a.opts?.env, { ANSIBLE_COLLECTIONS_PATH: collections });
  }
  // The SSH check comes after the playbook, the host's account steps after it.
  const playbook = firstIndex(ctx, "ansible-playbook -i");
  const sshCheck = firstIndex(ctx, "ssh -G forge-local");
  const identity = firstIndex(ctx, "forge-local -- 'git' 'config'");
  assert.ok(playbook < sshCheck && sshCheck < identity, called(ctx).join("\n"));
  assert.ok(called(ctx).some((c) => c.includes("forge-local -- 'git' 'config' '--global' 'user.name' 'Alice Example'")));

  const [h] = loadHosts();
  assert.deepEqual(h, {
    name: "forge-local", kind: "lima", address: "127.0.0.1", port: 60022, user: "forge", admin: "alice",
    adminKey: join(home, ".lima/_config/user"), exposure: "local", done: ALL,
  });
  assert.equal(readFileSync(forgeKeyPath("forge-local"), "utf8"), `${KEY}\n`);
  assert.equal(statSync(forgeKeyPath("forge-local")).mode & 0o777, 0o644);
  const inventory = readFileSync(inventoryPath("forge-local"), "utf8");
  assert.match(inventory, /ansible_port: 60022/);
  assert.match(inventory, /ansible_user: "alice"/);
  assert.ok(inventory.includes(`- "${KEY}"`), inventory);
  assert.match(readFileSync(join(home, ".ssh/config.d/agent-forge"), "utf8"), /^Host forge-local$/m);
  assert.equal(readFileSync(join(home, ".ssh/config"), "utf8"), "Include config.d/*\n");
  assert.equal(statSync(join(home, ".ssh/config")).mode & 0o777, 0o600);
  assert.equal(readlinkSync(join(home, ".local/bin/forge")), `${CHECKOUT}/cli/forge`);
  assert.ok(ctx.out_lines.includes('export PATH="$HOME/.local/bin:$PATH"'), ctx.out_lines.join("\n"));
  assert.deepEqual(asked(ctx), [INCLUDE, LINK]);
  // The summary: the host, then one line per step.
  assert.ok(ctx.out_lines.includes("forge-local:"), ctx.out_lines.join("\n"));
  assert.ok(ctx.out_lines.includes("  VM: done"), ctx.out_lines.join("\n"));
  assert.ok(ctx.out_lines.includes("  Claude login: done"), ctx.out_lines.join("\n"));
});

test("a re-run after a failed playbook resumes at the playbook with the saved answers", async () => {
  const world: World = { vm: null };
  const keys: ExecRule = { match: "ssh-add -L", stdout: `${KEY}\n${KEY2}\n` };
  const first = laptop(world, { rules: [keys], answers: [1], attachRules: [{ match: "ansible-playbook -i", code: 2 }] });
  await assert.rejects(cmdInstall(first, OPTS), (e: Error) =>
    e instanceof ForgeError && /ansible-playbook/.test(e.message) && /playbook/.test(e.message) &&
    /The playbook step failed: run forge install to resume there\./.test(e.message));
  assert.deepEqual(asked(first), ["Key GitHub accepts"]);
  assert.deepEqual(loadHosts()[0].done, ["vm", "inventory"]);
  const inventory = readFileSync(inventoryPath("forge-local"), "utf8");

  const second = laptop(world, { rules: [keys], answers: [0, 1] });
  assert.equal(await cmdInstall(second, OPTS), 0);
  assert.ok(!attached(second).some((a) => a.startsWith("limactl")), attached(second).join("\n"));
  // Only what comes after the playbook is asked: the Include and the link.
  assert.deepEqual(asked(second), [INCLUDE, LINK]);
  assert.ok(attached(second).some((a) => a.startsWith("ansible-playbook -i")));
  assert.equal(readFileSync(forgeKeyPath("forge-local"), "utf8"), `${KEY2}\n`);
  assert.equal(readFileSync(inventoryPath("forge-local"), "utf8"), inventory);
  assert.deepEqual(loadHosts()[0].done, ALL);
});

test("a re-run after an interrupted claude login resumes at the login", async () => {
  const world: World = { vm: null };
  const first = laptop(world, { rules: [NO_LOGIN], answers: [0], attachRules: [{ match: "'claude' 'auth' 'login'", code: 130 }] });
  await assert.rejects(cmdInstall(first, OPTS), /claude auth login[\s\S]*The Claude login step failed: run forge install to resume there\./);
  assert.deepEqual(loadHosts()[0].done, ["vm", "inventory", "playbook", "ssh", "identity"]);

  const second = laptop(world, { rules: [NO_LOGIN], answers: [1] });
  assert.equal(await cmdInstall(second, OPTS), 0);
  assert.ok(!attached(second).some((a) => a.startsWith("ansible")));
  assert.deepEqual(asked(second), [LINK]);
  assert.deepEqual(attached(second), [
    "ssh -t forge-local -- 'claude' 'auth' 'login'",
    "ssh forge-local -- 'forge' 'setup'",
    "ssh -t forge-local -- 'forge' 'image' 'build'",
    HERDR_LOCAL.join(" "),
  ]);
});

test("a Lima VM whose creation failed is created again without asking", async () => {
  const world: World = { vm: null };
  const first = laptop(world, { attachRules: [{ match: "limactl create", code: 1 }] });
  await assert.rejects(cmdInstall(first, OPTS), /limactl create failed[\s\S]*The VM step failed: run forge install to resume there\./);
  assert.deepEqual(loadHosts()[0].done, []);

  const second = laptop(world, { answers: [0, 1] });
  assert.equal(await cmdInstall(second, OPTS), 0);
  assert.ok(attached(second).some((a) => a.startsWith("limactl create")));
  assert.deepEqual(asked(second), [INCLUDE, LINK]);
});

test("a re-run of a finished host updates it", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  const inventory = readFileSync(inventoryPath("forge-local"), "utf8");

  const ctx = laptop(world);
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.deepEqual(attached(ctx), [
    `ansible-galaxy collection install -r ${CHECKOUT}/ansible/requirements.yml -p ${join(home, ".local/share/agent-forge/collections")}`,
    `ansible-playbook -i ${inventoryPath("forge-local")} ${CHECKOUT}/ansible/site.yml`,
    "ssh forge-local -- 'forge' 'setup'",
    "ssh -t forge-local -- 'forge' 'image' 'build'",
    HERDR_LOCAL.join(" "),
  ]);
  assert.ok(called(ctx).some((c) => c.includes("forge-local -- 'forge' 'image' 'commit'")));
  // VM, inventory, identity and login are skipped.
  assert.ok(!called(ctx).some((c) => c.startsWith("ssh -o BatchMode=yes -o ConnectTimeout=5")));
  assert.ok(!called(ctx).some((c) => c.includes("'git' 'config'") || c.includes("git config --global")));
  assert.ok(!called(ctx).some((c) => c.includes("'test' '-e'")));
  assert.equal(readFileSync(inventoryPath("forge-local"), "utf8"), inventory);
  assert.deepEqual(asked(ctx), []);
  assert.deepEqual(loadHosts()[0].done, ALL);
  assert.ok(ctx.out_lines.includes("  VM: already there"), ctx.out_lines.join("\n"));
  assert.ok(ctx.out_lines.includes("  playbook: done"), ctx.out_lines.join("\n"));
});

test("an update that fails resumes at the failed step", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  const failed = laptop(world, { attachRules: [{ match: "'forge' 'setup'", code: 1 }] });
  await assert.rejects(cmdInstall(failed, OPTS), /forge setup/);
  assert.deepEqual(loadHosts()[0].done, ["vm", "inventory", "playbook", "ssh", "identity", "claude"]);

  const ctx = laptop(world);
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.ok(!attached(ctx).some((a) => a.startsWith("ansible")));
  assert.ok(attached(ctx).includes("ssh forge-local -- 'forge' 'setup'"));
});

test("a stopped Lima VM is started on a re-run, not recreated", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  world.vm!.status = "Stopped";
  const ctx = laptop(world);
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.equal(attached(ctx)[0], "limactl start --tty=false forge-local");
  assert.ok(!attached(ctx).some((a) => a.startsWith("limactl create")));
});

test("a forge-local instance forge did not create is refused", async () => {
  const world: World = { vm: { status: "Running", port: 60022, user: "alice" } };
  const ctx = laptop(world);
  await assert.rejects(cmdInstall(ctx, OPTS), (e: Error) =>
    e instanceof ForgeError && /forge-local/.test(e.message) && /limactl delete forge-local/.test(e.message) &&
    /work/.test(e.message));
  assert.deepEqual(loadHosts(), []);
  assert.deepEqual(ctx.attachCalls, []);
  assert.equal(existsSync(join(home, ".config/agent-forge/hosts")), false);
});

test("a listed Lima VM that is gone is offered to be forgotten", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  writeFileSync(knownHostsPath(), "forge-local ssh-ed25519 AAAAold\n");
  appendFileSync(inventoryPath("forge-local"), "# an edit for the old VM\n");
  world.vm = null; // deleted by hand

  const ctx = laptop(world, { answers: [0] });
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.match(asked(ctx)[0], /forge-local.*gone/);
  const kh = knownHostsPath();
  const forget = ctx.calls.filter((c) => c[0] === "ssh-keygen");
  assert.deepEqual(forget, [
    ["ssh-keygen", "-R", "forge-local", "-f", kh],
    ["ssh-keygen", "-R", "forge-local-admin", "-f", kh],
    ["ssh-keygen", "-R", "[127.0.0.1]:60022", "-f", kh],
  ]);
  // Then a fresh install: a new VM and a new inventory, nothing else asked.
  assert.ok(firstIndex(ctx, "ssh-keygen") < firstIndex(ctx, "limactl create"));
  assert.deepEqual(asked(ctx).length, 1);
  assert.doesNotMatch(readFileSync(inventoryPath("forge-local"), "utf8"), /an edit for the old VM/);
  assert.equal(readFileSync(forgeKeyPath("forge-local"), "utf8"), `${KEY}\n`);
  assert.deepEqual(loadHosts().map((h) => [h.name, h.done]), [["forge-local", ALL]]);
});

test("stopping at a gone Lima VM keeps it listed", async () => {
  const world: World = { vm: null };
  await finishedLocal(world);
  const before = readFileSync(join(home, ".config/agent-forge/hosts.json"), "utf8");
  world.vm = null;
  const ctx = laptop(world, { answers: [1] });
  await assert.rejects(cmdInstall(ctx, OPTS), ForgeError);
  assert.equal(readFileSync(join(home, ".config/agent-forge/hosts.json"), "utf8"), before);
  assert.ok(existsSync(inventoryPath("forge-local")));
  assert.ok(!ctx.calls.some((c) => c[0] === "ssh-keygen"));
  assert.deepEqual(ctx.attachCalls, []);
});

test("a Lima admin named like the forge user is refused", async () => {
  const world: World = { vm: null };
  const ctx = laptop(world);
  const attach = ctx.attach;
  // Lima names its admin after the laptop login: here, forge.
  ctx.attach = async (argv, o) => { const c = await attach(argv, o); if (world.vm) world.vm.user = "forge"; return c; };
  await assert.rejects(cmdInstall(ctx, OPTS), (e: Error) => e instanceof ForgeError && /forge/.test(e.message) && /admin/.test(e.message));
  assert.deepEqual(loadHosts()[0].done, []);
});

test("a remote install asks its questions once and saves them first", async () => {
  const world: World = { vm: null };
  mkdirSync(join(home, "keys"));
  writeFileSync(join(home, "keys/admin"), "PRIVATE KEY\n", { mode: 0o600 });
  const rules: ExecRule[] = [{ match: "ssh -G github.com", stdout: "user git\nidentityagent /run/agent.sock\n" }];
  // The first connection fails: the answers are saved already.
  const first = laptop(world, {
    rules, answers: ["acme", "", 1, "alice", 1, "~/keys/admin"],
    attachRules: [{ match: "ubuntu@203.0.113.10", code: 255 }],
  });
  await assert.rejects(cmdInstall(first, REMOTE), /The first SSH connection step failed: run forge install --host forge-acme to resume there\./);
  assert.deepEqual(asked(first), [
    "Host name: forge-<name>", "Admin account (default ubuntu)", "Exposure",
    asked(first)[3], "Key the admin account accepts", "Private key file",
  ]);
  assert.match(asked(first)[3], /^Forge user name \(default .+\)$/);
  assert.deepEqual(first.attachCalls.map((a) => a.argv), [[
    "ssh", "-o", `UserKnownHostsFile=${knownHostsPath()}`, "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=/run/agent.sock", "-i", join(home, "keys/admin"), "ubuntu@203.0.113.10", "true",
  ]]);
  assert.deepEqual(loadHosts(), [{
    name: "forge-acme", kind: "remote", address: "203.0.113.10", port: 22, user: "alice", admin: "ubuntu",
    adminKey: join(home, "keys/admin"), exposure: "lan", identityAgent: "/run/agent.sock", done: [],
  }]);
  assert.equal(readFileSync(forgeKeyPath("forge-acme"), "utf8"), `${KEY}\n`);

  const second = laptop(world, { rules, answers: [0, 1] });
  assert.equal(await cmdInstall(second, REMOTE), 0);
  assert.deepEqual(asked(second), [INCLUDE, LINK]);
  assert.ok(!called(second).some((c) => c.startsWith("limactl")));
  assert.deepEqual(second.attachCalls.at(-1)?.argv, ["herdr", "--remote", "forge-acme", "--remote-keybindings", "server"]);
  // The agent and the admin key reach the inventory, the agent the SSH block.
  const inventory = readFileSync(inventoryPath("forge-acme"), "utf8");
  assert.match(inventory, /-o IdentityAgent='\/run\/agent.sock'/);
  assert.ok(inventory.includes(`ansible_ssh_private_key_file: "${join(home, "keys/admin")}"`), inventory);
  assert.match(inventory, /forge_exposure: "lan"/);
  assert.match(inventory, /- name: "alice"/);
  const block = readFileSync(join(home, ".ssh/config.d/agent-forge"), "utf8");
  assert.match(block, /Host forge-acme\n[\s\S]*IdentityAgent \/run\/agent.sock/);
  assert.deepEqual(loadHosts()[0].done, ALL);
});

test("a remote admin that accepts the GitHub key uses its public half", async () => {
  const world: World = { vm: null };
  const ctx = laptop(world, { answers: ["forge-acme", "ubuntu", 0, "alice", null, 0, 1] });
  assert.equal(await cmdInstall(ctx, REMOTE), 0);
  const [h] = loadHosts();
  assert.equal(h.adminKey, forgeKeyPath("forge-acme"));
  assert.equal(h.exposure, "public");
  assert.ok(readFileSync(inventoryPath("forge-acme"), "utf8")
    .includes(`ansible_ssh_private_key_file: "${forgeKeyPath("forge-acme")}"`));
  assert.deepEqual(ctx.attachCalls[0].argv, [
    "ssh", "-o", `UserKnownHostsFile=${knownHostsPath()}`, "-o", "IdentitiesOnly=yes",
    "-i", forgeKeyPath("forge-acme"), "ubuntu@203.0.113.10", "true",
  ]);
});

test("a remote re-run finds its host by address or by name", async () => {
  const world: World = { vm: null };
  assert.equal(await cmdInstall(laptop(world, { answers: ["acme", "", 0, "alice", null, 0, 0] }), REMOTE), 0);
  for (const opts of [REMOTE, { ...OPTS, host: "forge-acme" }]) {
    const ctx = laptop(world);
    assert.equal(await cmdInstall(ctx, opts), 0);
    assert.deepEqual(asked(ctx), []);
    assert.equal(ctx.attachCalls.at(-1)?.argv[2], "forge-acme");
  }
  assert.equal(loadHosts().length, 1);
});

test("the remote questions are checked and nothing is saved on a bad answer", async () => {
  saveHost({
    name: "forge-beta", kind: "remote", address: "198.51.100.7", port: 22, user: "alice", admin: "ubuntu",
    adminKey: "/keys/admin", exposure: "public", done: [],
  });
  const cases: [string, (number | string | null)[], RegExp][] = [
    ["no name", [null], /name/],
    ["an invalid name", ["Acme_Corp"], /forge-Acme_Corp/],
    ["the Lima name", ["local"], /forge-local/],
    ["a listed name", ["beta"], /forge-beta/],
    ["no exposure", ["acme", "ubuntu", null], /exposure/i],
    ["an invalid user", ["acme", "ubuntu", 0, "Alice Smith"], /Alice Smith/],
    ["the admin as user", ["acme", "ubuntu", 0, "ubuntu"], /ubuntu/],
    ["a missing key file", ["acme", "ubuntu", 0, "alice", 1, "/nowhere/key"], /\/nowhere\/key/],
  ];
  for (const [what, answers, re] of cases) {
    const ctx = laptop({ vm: null }, { answers });
    await assert.rejects(cmdInstall(ctx, REMOTE), (e: Error) => e instanceof ForgeError && re.test(e.message), what);
    assert.deepEqual(loadHosts().map((h) => h.name), ["forge-beta"], what);
    assert.deepEqual(ctx.attachCalls, [], what);
  }
});

test("--remote and --host together are refused", async () => {
  await assert.rejects(cmdInstall(laptop({ vm: null }), { ...REMOTE, host: "forge-acme" }), ForgeError);
});

test("a remote host defined by hand in ~/.ssh/config stops the install", async () => {
  const world: World = { vm: null };
  const rules: ExecRule[] = [{ match: "ssh -G forge-acme", stdout: "host forge-acme\nhostname 198.51.100.7\nport 22\n" }];
  const ctx = laptop(world, { rules, answers: ["acme", "ubuntu", 0, "alice", null] });
  await assert.rejects(cmdInstall(ctx, REMOTE), (e: Error) =>
    e instanceof ForgeError && /Host forge-acme/.test(e.message) && /remove/.test(e.message));
  assert.equal(existsSync(join(home, ".ssh/config.d/agent-forge")), false);
  assert.equal(existsSync(join(home, ".ssh/config")), false);
  assert.ok(!attached(ctx).some((a) => a.startsWith("herdr")));
  assert.deepEqual(loadHosts()[0].done, ["vm", "inventory", "playbook"]);
});

test("declining the Include stops the install, ~/.ssh/config unchanged", async () => {
  const config = join(home, ".ssh/config");
  writeFileSync(config, "Host *\n  ServerAliveInterval 60\n", { mode: 0o644 });
  const ctx = laptop({ vm: null }, { answers: [1] });
  await assert.rejects(cmdInstall(ctx, OPTS), (e: Error) =>
    e instanceof ForgeError && /Include config\.d\/\*/.test(e.message) && /forge-local/.test(e.message));
  assert.equal(readFileSync(config, "utf8"), "Host *\n  ServerAliveInterval 60\n");
  assert.equal(statSync(config).mode & 0o777, 0o644);
  assert.ok(!called(ctx).some((c) => c.includes("'git' 'config'")));
  assert.ok(!loadHosts()[0].done.includes("ssh"));
});

test("an accepted Include keeps the rest of ~/.ssh/config and its mode", async () => {
  const config = join(home, ".ssh/config");
  writeFileSync(config, "Host *\n  ServerAliveInterval 60\n", { mode: 0o640 });
  assert.equal(await cmdInstall(laptop({ vm: null }, { answers: [0, 1] }), OPTS), 0);
  assert.equal(readFileSync(config, "utf8"), "Include config.d/*\n\nHost *\n  ServerAliveInterval 60\n");
  assert.equal(statSync(config).mode & 0o777, 0o640);
});

test("a ~/.local/bin/forge pointing elsewhere is left alone", async () => {
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync("/elsewhere/forge", join(home, ".local/bin/forge"));
  writeFileSync(join(home, ".ssh/config"), "Include config.d/*\n");
  const ctx = laptop({ vm: null });
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.deepEqual(asked(ctx), []);
  assert.equal(readlinkSync(join(home, ".local/bin/forge")), "/elsewhere/forge");
  assert.ok([...ctx.out_lines, ...ctx.err_lines].some((l) => l.includes("~/.local/bin/forge") && l.includes("left")));
  assert.ok(!ctx.out_lines.includes('export PATH="$HOME/.local/bin:$PATH"'));
});

// Every path under `root`, with what it is: a change shows as a different value.
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      const rel = relative(root, p);
      if (st.isSymbolicLink()) out.set(rel, `link ${readlinkSync(p)}`);
      else if (st.isDirectory()) { out.set(rel, `dir ${st.mode & 0o777}`); walk(p); }
      else out.set(rel, `file ${st.mode & 0o777} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(root);
  return out;
}

function changedOutsideForge(before: Map<string, string>, after: Map<string, string>): { changed: string[]; outside: string[] } {
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p)).sort();
  const forge = (p: string) =>
    p === ".config/agent-forge" || p.startsWith(".config/agent-forge/") ||
    p === ".local/share/agent-forge" || p.startsWith(".local/share/agent-forge/") ||
    p === ".ssh/config.d" || p === ".ssh/config.d/agent-forge";
  return { changed, outside: changed.filter((p) => !forge(p)) };
}

test("nothing is written outside forge's directories without a confirmation", async () => {
  // The developer's own files, which must stay as they are.
  writeFileSync(join(home, ".ssh/id_ed25519.pub"), `${KEY}\n`);
  writeFileSync(join(home, ".zshrc"), "export EDITOR=vi\n");

  // Every confirmation declined: the run stops at the Include.
  let before = snapshot(home);
  await assert.rejects(cmdInstall(laptop({ vm: null }, { answers: [1] }), OPTS), ForgeError);
  let diff = changedOutsideForge(before, snapshot(home));
  assert.ok(diff.changed.includes(".config/agent-forge/hosts.json"), diff.changed.join("\n"));
  assert.deepEqual(diff.outside, []);

  // The Include already there and the link declined: the run completes.
  rmSync(join(home, ".config/agent-forge"), { recursive: true, force: true });
  rmSync(join(home, ".ssh/config.d"), { recursive: true, force: true });
  writeFileSync(join(home, ".ssh/config"), "Include config.d/*\n\nHost *\n  ServerAliveInterval 60\n");
  before = snapshot(home);
  const ctx = laptop({ vm: null }, { answers: [1] });
  assert.equal(await cmdInstall(ctx, OPTS), 0);
  assert.deepEqual(asked(ctx), [LINK]);
  diff = changedOutsideForge(before, snapshot(home));
  assert.ok(diff.changed.includes(".ssh/config.d/agent-forge"), diff.changed.join("\n"));
  assert.deepEqual(diff.outside, []);
  assert.equal(existsSync(join(home, ".local/bin")), false);
});
