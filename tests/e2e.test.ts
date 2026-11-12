// Bout-en-bout : le VRAI binaire, avec un faux incus sur le PATH. Prouve le
// câblage que les tests unitaires ne voient pas — parsing d'argv, dispatch,
// codes de sortie, et la séparation stdout/stderr.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let bin: string;
const ENTRY = resolve("cli/forge.ts");

before(() => {
  bin = mkdtempSync(join(tmpdir(), "forge-e2e-bin-"));
  const stub = resolve("tests/lib/fake-incus-bin.ts");
  writeFileSync(join(bin, "incus"), `#!/bin/sh\nexec node ${stub} "$@"\n`);
  chmodSync(join(bin, "incus"), 0o755);
});

after(() => {
  rmSync(bin, { recursive: true, force: true });
});

function forge(args: string[], input = "", extraEnv: Record<string, string> = {}) {
  // Never inherit the herdr session of the shell running the tests.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR_")));
  return spawnSync("node", [ENTRY, ...args], {
    encoding: "utf8",
    input,
    env: { ...env, FORGE_SIDE: "host", PATH: `${bin}:${process.env.PATH}`, ...extraEnv },
  });
}

test("no argument prints the usage and exits 0", () => {
  const r = forge([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: forge <command>/);
  // setup also creates the egress proxy and the allowlist (its entry, up to the next command).
  const setup = r.stdout.match(/^ {2}setup [\s\S]*?(?=^ {2}\S)/m)?.[0] ?? "";
  assert.match(setup, /proxy[\s\S]*allowlist/, r.stdout);
});

test("an unknown command exits 1 with Error: on stderr", () => {
  const r = forge(["frobnicate"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: unknown command 'frobnicate'/m);
  assert.equal(r.stdout, "");
});

test("list renders the table on stdout", () => {
  const r = forge(["list"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^REPO\s+MODE\s+EGRESS\s+STATE\s+BUILD$/m);
  assert.match(r.stdout, /alice\/project/);
});

test("completion repos is machine-readable, one per line", () => {
  const r = forge(["completion", "repos"]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.trim().split("\n"), ["alice/project", "acme/widgets"]);
});

test("--force is accepted in any position", () => {
  const first = forge(["stop", "--force", "alice/project"]);
  const last = forge(["stop", "alice/project", "--force"]);
  assert.equal(first.status, 0);
  assert.equal(last.status, 0);
});

test("a missing argument with no TTY prints the usage instead of hanging", () => {
  const r = forge(["stop"], "1\n");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: forge stop/);
});

// --remote ne vaut que pour install, --host pour install, open, fetch et ship.
test("--remote and --host are refused outside the laptop commands that take them", () => {
  for (const cmd of ["list", "stop"]) {
    const remote = forge([cmd, "--remote", "203.0.113.10"]);
    assert.equal(remote.status, 1, `${cmd}: ${remote.stderr}`);
    assert.match(remote.stderr, /^Error: --remote only goes with install/m, cmd);
    const host = forge([cmd, "--host", "forge-acme"]);
    assert.equal(host.status, 1, `${cmd}: ${host.stderr}`);
    assert.match(host.stderr, /^Error: --host only goes with install, open, fetch, ship, cloud and team: .*forge ship <task> --host <name>, forge cloud start --host <name>$/m, cmd);
  }
  const open = forge(["open", "--remote", "203.0.113.10"], "", { FORGE_SIDE: "laptop" });
  assert.equal(open.status, 1);
  assert.match(open.stderr, /^Error: --remote only goes with install/m);
});

test("an unknown option fails cleanly rather than crashing", () => {
  const r = forge(["list", "--nope"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: /m);
});

test("image without a subcommand fails with its usage", () => {
  const r = forge(["image"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: forge image build \| commit$/m);
});

test("the bash shim runs the TypeScript entry", () => {
  const r = spawnSync(resolve("cli/forge"), ["list"], {
    encoding: "utf8",
    env: { ...process.env, FORGE_SIDE: "host", PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^REPO\s+MODE\s+EGRESS\s+STATE\s+BUILD$/m);
});

test("a host command on the laptop says where it runs", () => {
  const r = forge(["list"], "", { FORGE_SIDE: "laptop" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /runs on the forge host/);
});

test("setup appears in the usage", () => {
  assert.match(forge([]).stdout, /^\s+setup\s/m);
});

test("upload-pack refuses a hostile container name and keeps stdout empty", () => {
  const r = forge(["upload-pack", "agent-x;id"]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^Error: container must be/m);
});
