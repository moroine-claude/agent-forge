import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    const file = join(dir, "config.d", "agent-forge.config");
    assert.equal(readFileSync(file, "utf8"), "two\n");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "config.d")).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(join(dir, "config.d")), ["agent-forge.config"]);
  });
});

// OpenSSH's `Include config.d/*` skips dotfiles: an interrupted write never
// leaves a temp file that ssh would read.
test("the temp file is a dotfile, outside the Include glob", () => {
  withSshDir((dir) => {
    // A directory in the way makes the rename fail and leaves the temp file.
    mkdirSync(join(dir, "config.d", "agent-forge.config", "x"), { recursive: true });
    assert.throws(() => writeForgeSshConfig("one\n"));
    assert.deepEqual(readdirSync(join(dir, "config.d")).sort(), [".agent-forge.forge-tmp", "agent-forge.config"]);
  });
});

// Earlier versions wrote config.d/agent-forge: it goes when forge wrote it
// (its header line), any other file of that name stays.
test("an old config.d/agent-forge written by forge is removed, any other one kept", () => {
  withSshDir((dir) => {
    const old = join(dir, "config.d", "agent-forge");
    mkdirSync(dirname(old), { recursive: true });
    writeFileSync(old, renderForgeSshConfig([lima], o));
    writeForgeSshConfig("new\n");
    assert.equal(existsSync(old), false);
    assert.equal(readFileSync(join(dir, "config.d", "agent-forge.config"), "utf8"), "new\n");

    writeFileSync(old, "Host mine\n  HostName 192.0.2.1\n");
    writeForgeSshConfig("new\n");
    assert.equal(readFileSync(old, "utf8"), "Host mine\n  HostName 192.0.2.1\n");
  });
  withSshDir((dir) => {
    mkdirSync(join(dir, "config.d", "agent-forge"), { recursive: true });
    writeForgeSshConfig("new\n");
    assert.ok(statSync(join(dir, "config.d", "agent-forge")).isDirectory());
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

// FORGE_HOME and FORGE_SSH_DIR in a temporary home: `~/` and `~/.ssh` agree.
function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "forge-home-"));
  const old = { home: process.env.FORGE_HOME, ssh: process.env.FORGE_SSH_DIR };
  process.env.FORGE_HOME = home;
  process.env.FORGE_SSH_DIR = join(home, ".ssh");
  try { return fn(home); } finally {
    if (old.home === undefined) delete process.env.FORGE_HOME; else process.env.FORGE_HOME = old.home;
    if (old.ssh === undefined) delete process.env.FORGE_SSH_DIR; else process.env.FORGE_SSH_DIR = old.ssh;
  }
}

// OpenSSH reads config.d/ only through an Include that applies to every host:
// at the top level, under `Match all`, or under `Host *`.
test("an Include that covers forge's file for every host is detected", () => {
  withHome(() => {
    // The maintainer's layout: `Match All` makes what follows global again.
    const layout = 'Host *\n  IdentityAgent "/run/user agent.sock"\n\nMatch All\nInclude ~/.ssh/config.d/*.config\n';
    assert.equal(includeState(layout), "covered");
    for (const text of [
      "Include config.d/*\n\nHost gh\n  User git\n",
      "# mine\n\nInclude ~/.ssh/config.d/*\nHost gh\n",
      "Include config.d/agent-forge.config\n",
      "include=config.d/*\n",
      "Include = config.d/*.config\n",
      "INCLUDE other.conf config.d/*\n",
      "Host *\n  Include config.d/*\n",
      "Host gh\n  User git\nMatch all\n  Include config.d/*.config\n",
      'Include "config.d/*.config"\n',
      "Include 'config.d/agent-forge.config'\n",
      'Include "my dir/*.conf" config.d/*\n',
      "Include config.d/agent-forge.confi?\n",
      "Include config.d/[a-c]gent-forge.config\n",
      "Include config.d/agent-forge.[!x]onfig\n",
      "Include */agent-forge.config\n",
      "Include ~/.*/config.d/*\n",
    ]) assert.equal(includeState(text), "covered", text);
  });
});

test("an Include that misses forge's file, or applies to some hosts only, is not enough", () => {
  withHome(() => {
    for (const text of [
      "",
      "Include other.conf\n",
      "Include config.d/*.conf\n",
      "Include config.d/agent-forge\n",
      "Include config.d/*.conf # config.d/*\n",
      "Host github.com\n  Include config.d/*\n",
      "Host * !gh\n  Include config.d/*\n",
      "Match host gh\n  Include config.d/*\n",
      "Match all\nHost gh\n  Include config.d/*\n",
      "Include config.d/[!a]gent-forge.config\n",
      "Include config.d/agent-forge.conf[a-f]?\n",
      // A wildcard never matches a leading dot: not ~/.ssh.
      "Include ~/*/config.d/*\n",
      "Include ~/.ssh/*\n",
    ]) assert.equal(includeState(text), "missing", text);
  });
});

test("an absolute Include path is compared with forge's file", () => {
  withSshDir((dir) => {
    assert.equal(includeState(`Include ${join(dir, "config.d", "*")}\n`), "covered");
    assert.equal(includeState(`Include ${join(dir, "config.d", "agent-forge.config")}\n`), "covered");
    assert.equal(includeState(`Include ${join(dir, "config.d", "*.conf")}\n`), "missing");
  });
});

test("the Include goes above the first Host line", () => {
  const input = "# my config\nHost *\n  ServerAliveInterval 30\n\nHost gh\n  User git\n";
  assert.equal(addInclude(input), `Include config.d/agent-forge.config\n\n${input}`);
  assert.equal(addInclude(""), "Include config.d/agent-forge.config\n");
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
