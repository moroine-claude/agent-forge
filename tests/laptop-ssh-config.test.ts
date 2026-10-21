import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addInclude, forgeSshConfigDefines, hostDefinedElsewhere, includeState, renderForgeSshConfig, sshOption,
  writeForgeSshConfig,
} from "../cli/lib/laptop/ssh-config.ts";
import type { LaptopHost } from "../cli/lib/laptop/state.ts";
import { fakeContext } from "./lib/fake-context.ts";

const lima: LaptopHost = {
  name: "forge-local", kind: "lima", address: "127.0.0.1", port: 60022, user: "forge",
  admin: "alice", adminKey: "/lima/_config/user", exposure: "local", done: [],
};
const remote: LaptopHost = {
  name: "forge-acme", kind: "remote", address: "203.0.113.10", port: 22, user: "forge",
  admin: "ubuntu", adminKey: "/keys/admin", exposure: "public",
  identityAgent: "/run/agent.sock", done: [],
};
const o = { knownHosts: "/state/known_hosts", keyPath: (n: string) => `/state/${n}/forge-key.pub` };

function withSshDir<T>(fn: (dir: string) => T): T {
  const dir = join(mkdtempSync(join(tmpdir(), "forge-ssh-")), ".ssh");
  const old = process.env.FORGE_SSH_DIR;
  process.env.FORGE_SSH_DIR = dir;
  try { return fn(dir); } finally {
    if (old === undefined) delete process.env.FORGE_SSH_DIR; else process.env.FORGE_SSH_DIR = old;
  }
}

test("renders a lima and a remote host", () => {
  assert.equal(renderForgeSshConfig([lima, remote], o), `# Managed by forge install: edits are overwritten.

Host forge-local
  HostName 127.0.0.1
  Port 60022
  User forge
  HostKeyAlias forge-local
  StrictHostKeyChecking accept-new
  UserKnownHostsFile /state/known_hosts
  IdentityFile /state/forge-local/forge-key.pub
  IdentitiesOnly yes
  ForwardAgent yes

Host forge-acme
  HostName 203.0.113.10
  Port 22
  User forge
  UserKnownHostsFile /state/known_hosts
  IdentityFile /state/forge-acme/forge-key.pub
  IdentitiesOnly yes
  IdentityAgent /run/agent.sock
  ForwardAgent yes
`);
});

test("a path with spaces is double-quoted", () => {
  const text = renderForgeSshConfig(
    [{ ...remote, identityAgent: "/Users/a b/agent.sock" }],
    { knownHosts: "/my state/known_hosts", keyPath: () => "/my state/key.pub" },
  );
  assert.match(text, /^ {2}IdentityAgent "\/Users\/a b\/agent\.sock"$/m);
  assert.match(text, /^ {2}IdentityFile "\/my state\/key\.pub"$/m);
  assert.match(text, /^ {2}UserKnownHostsFile "\/my state\/known_hosts"$/m);
});

test("sshOption quotes a value the way ssh reads it", () => {
  assert.equal(sshOption("IdentityAgent", "/run/agent.sock"), "IdentityAgent=/run/agent.sock");
  assert.equal(sshOption("IdentityAgent", "/a b/s"), 'IdentityAgent="/a b/s"');
  assert.equal(sshOption("IdentityAgent", "/o'b/s"), `IdentityAgent="/o'b/s"`);
  assert.equal(sshOption("IdentityAgent", '/q"x\\y'), String.raw`IdentityAgent="/q\"x\\y"`);
});

// `-G` only parses the options, it never connects.
test("ssh itself reads an sshOption value back whole", { skip: spawnSync("ssh", ["-V"]).status !== 0 }, () => {
  for (const path of ["/run/agent.sock", "/Users/a  b/Group Containers/agent.sock", "/o'b/s", '/q"x\\y  z']) {
    const r = spawnSync("ssh", ["-F", "/dev/null", "-G", "-o", sshOption("IdentityAgent", path), "example.invalid"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.split("\n").includes(`identityagent ${path}`), path);
  }
});

test("writes the file 0600 in 0700 directories, atomically", () => {
  withSshDir((dir) => {
    writeForgeSshConfig("one\n");
    writeForgeSshConfig("two\n");
    const file = join(dir, "config.d", "agent-forge");
    assert.equal(readFileSync(file, "utf8"), "two\n");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "config.d")).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(join(dir, "config.d")), ["agent-forge"]);
  });
});

test("forgeSshConfigDefines sees only a Host line of forge's own file", () => {
  withSshDir(() => {
    assert.equal(forgeSshConfigDefines("forge-acme"), false);
    writeForgeSshConfig(renderForgeSshConfig([remote], o));
    assert.equal(forgeSshConfigDefines("forge-acme"), true);
    assert.equal(forgeSshConfigDefines("forge-other"), false);
  });
});

test("an existing Include is detected", () => {
  assert.equal(includeState("Include config.d/*\n\nHost gh\n  User git\n"), "covered");
  assert.equal(includeState("# mine\n\nInclude ~/.ssh/config.d/*\nHost gh\n"), "covered");
  assert.equal(includeState("Include config.d/agent-forge\n"), "covered");
  assert.equal(includeState("include=config.d/*\n"), "covered");
  assert.equal(includeState("INCLUDE other.conf config.d/*\n"), "covered");
  withSshDir((dir) => {
    assert.equal(includeState(`Include ${join(dir, "config.d", "*")}\n`), "covered");
    assert.equal(includeState(`Include ${join(dir, "config.d", "agent-forge")}\n`), "covered");
  });
  assert.equal(includeState("Host gh\n  Include config.d/*\n"), "missing");
  assert.equal(includeState("Match all\nInclude config.d/*\n"), "missing");
  assert.equal(includeState("Include other.conf\n"), "missing");
  assert.equal(includeState(""), "missing");
});

test("the Include goes above the first Host line", () => {
  const input = "# my config\nHost *\n  ServerAliveInterval 30\n\nHost gh\n  User git\n";
  assert.equal(addInclude(input), `Include config.d/*\n\n${input}`);
  assert.equal(addInclude(""), "Include config.d/*\n");
  assert.equal(includeState(addInclude(input)), "covered");
});

test("hostDefinedElsewhere compares the resolved hostname", async () => {
  const other = fakeContext({ rules: [{ match: "ssh -G forge-acme", stdout: "user x\nhostname 203.0.113.10\nport 22\n" }] });
  assert.equal(await hostDefinedElsewhere(other, "forge-acme"), true);
  const unset = fakeContext({ rules: [{ match: "ssh -G forge-acme", stdout: "hostname Forge-Acme\n" }] });
  assert.equal(await hostDefinedElsewhere(unset, "forge-acme"), false);
  const failing = fakeContext({ rules: [{ match: "ssh -G", code: 255 }] });
  assert.equal(await hostDefinedElsewhere(failing, "forge-acme"), false);
});
