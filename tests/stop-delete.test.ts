import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { mirrorPath, workspacesDir } from "../cli/lib/paths.ts";
import { cmdStop } from "../cli/lib/commands/stop.ts";
import { cmdDelete } from "../cli/lib/commands/delete.ts";

// Jamais le vrai home : delete regarde si le miroir existe.
const dir = mkdtempSync(join(tmpdir(), "forge-delete-"));
const saved = { ws: process.env.FORGE_WORKSPACES, mirrors: process.env.FORGE_MIRRORS };
process.env.FORGE_WORKSPACES = join(dir, "workspaces");
process.env.FORGE_MIRRORS = join(dir, "mirrors");
after(() => {
  for (const [k, v] of [["FORGE_WORKSPACES", saved.ws], ["FORGE_MIRRORS", saved.mirrors]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const RULES = [
  { match: "agent-alice-project user.forge.repo", stdout: "alice/project" },
  { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-alice-project", status: "Running" }]) },
  { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\n" },
  { match: "status --porcelain", stdout: " M scripts/forge\n" },
];

test("stop runs the WIP pre-flight and refuses a dirty worktree", async () => {
  const c = fakeContext({ rules: RULES });
  await assert.rejects(() => cmdStop(c, "alice/project", false), /uncommitted changes/);
  assert.ok(!c.calls.some((call) => call[1] === "stop"));
});

test("stop --force skips the pre-flight and stops the container", async () => {
  const c = fakeContext({ rules: RULES });
  assert.equal(await cmdStop(c, "alice/project", true), 0);
  assert.ok(c.calls.some((call) => call.join(" ") === "incus --project agent-forge stop agent-alice-project"));
  assert.ok(!c.calls.some((call) => call.join(" ").includes("status --porcelain")));
});

test("stop asks for the repo when it is missing", async () => {
  const c = fakeContext({ rules: RULES, answers: [1] });
  await cmdStop(c, undefined, true);
  assert.ok(c.calls.some((call) => call.join(" ") === "incus --project agent-forge stop agent-alice-project"));
});

// Seen on a real host: `incus stop` on a stopped instance fails, so a second
// `forge stop` errored out ("The instance is already stopped").
test("stop on an already stopped container is a no-op, with or without --force", async () => {
  for (const force of [false, true]) {
    const c = fakeContext({
      rules: [
        { match: "agent-x user.forge.repo", stdout: "o/r" },
        { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-x", status: "Stopped" }]) },
        { match: "incus --project agent-forge stop", code: 1, stderr: "Error: The instance is already stopped\n" },
      ],
    });
    assert.equal(await cmdStop(c, "o/r", force), 0);
    assert.ok(!c.calls.some((call) => call.join(" ").includes("status --porcelain")), `force=${force}`);
    assert.ok(!c.calls.some((call) => call[3] === "stop"), `force=${force}`);
    assert.ok(c.out_lines.some((l) => l.includes("already stopped")), c.out_lines.join("\n"));
  }
});

test("delete skips the pre-flight on an already stopped container", async () => {
  const c = fakeContext({
    rules: [
      { match: "agent-x user.forge.repo", stdout: "o/r" },
      { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-x", status: "Stopped" }]) },
      { match: "git worktree list", stdout: "worktree /workspace\nworktree /workspace/.trees/cli\n" },
      { match: "status --porcelain", stdout: " M scripts/forge\n" },
    ],
  });
  assert.equal(await cmdDelete(c, "o/r", false), 0);
  assert.ok(!c.calls.some((call) => call.join(" ").includes("status --porcelain")));
  assert.ok(c.calls.some((call) => call.join(" ") === "incus --project agent-forge delete agent-x --force"));
});

test("delete runs the pre-flight on a running container", async () => {
  const c = fakeContext({ rules: RULES });
  await assert.rejects(() => cmdDelete(c, "alice/project", false), /uncommitted changes/);
});

// Fail-fast : `ctx.exec` capture stderr là où bash en héritait. Sans
// mustSucceed, un `incus stop`/`incus delete` en échec rendait 0 et n'affichait
// rien du tout — pire que le bash d'origine sous `set -e`.
test("stop fails loudly when incus stop fails, surfacing its stderr", async () => {
  const c = fakeContext({
    rules: [
      { match: "incus --project agent-forge stop", code: 1, stderr: "Error: The instance is currently in use\n" },
      ...RULES,
    ],
  });
  await assert.rejects(
    () => cmdStop(c, "alice/project", true),
    /incus stop failed: Error: The instance is currently in use/,
  );
});

test("delete fails loudly when incus delete fails, surfacing its stderr", async () => {
  const c = fakeContext({
    rules: [
      { match: "incus --project agent-forge delete", code: 1, stderr: "Error: Instance is protected\n" },
      { match: "agent-x user.forge.repo", stdout: "o/r" },
      { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-x", status: "Stopped" }]) },
    ],
  });
  await assert.rejects(
    () => cmdDelete(c, "o/r", false),
    /incus delete failed: Error: Instance is protected/,
  );
});

const STOPPED = [
  { match: "agent-alice-project user.forge.repo", stdout: "alice/project" },
  { match: "incus --project agent-forge list", stdout: JSON.stringify([{ name: "agent-alice-project", status: "Stopped" }]) },
];

test("delete says the workspace and the mirror are kept", async () => {
  mkdirSync(mirrorPath("agent-alice-project"), { recursive: true });
  try {
    const c = fakeContext({ rules: STOPPED });
    await cmdDelete(c, "alice/project", false);
    const line = c.out_lines.find((l) => l.startsWith("Kept "));
    assert.ok(line, c.out_lines.join("\n"));
    assert.ok(line.includes(join(workspacesDir(), "agent-alice-project")), line);
    assert.ok(line.includes(mirrorPath("agent-alice-project")), line);
    assert.ok(line.includes("whatever the agent left"), line);
  } finally {
    rmSync(mirrorPath("agent-alice-project"), { recursive: true, force: true });
  }
});

// Un container d'avant le miroir n'en a pas : la ligne n'en nomme aucun.
test("delete of a container without a mirror names only the workspace", async () => {
  const c = fakeContext({ rules: STOPPED });
  await cmdDelete(c, "alice/project", false);
  assert.deepEqual(c.out_lines.filter((l) => l.startsWith("Kept ")), [
    `Kept ${join(workspacesDir(), "agent-alice-project")}: it holds whatever the agent left.`,
  ]);
});

function incusWith(config: Record<string, string>): FakeIncus {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-o-r", { status: "Stopped", config });
  return fake;
}
const MARKER = { "user.forge.provisioning": "o/r", "user.forge.provisioning_workspace": "kept" };
const deleted = (c: { calls: string[][] }) => c.calls.some((call) => call.join(" ").includes(" delete agent-o-r"));

test("delete removes a half-provisioned container without asking", async () => {
  const c = fakeContext({ incus: incusWith(MARKER), answers: [] });
  assert.equal(await cmdDelete(c, "o/r", false), 0);
  assert.ok(deleted(c), c.calls.map((x) => x.join(" ")).join("\n"));
  assert.ok(c.out_lines.some((l) => l.startsWith("Kept ")), c.out_lines.join("\n"));
});

test("delete says a workspace the failed attempt created was emptied, not kept", async () => {
  {
    const dir = join(workspacesDir(), "agent-o-r");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "f"), "x");
    const c = fakeContext({ incus: incusWith({ ...MARKER, "user.forge.provisioning_workspace": "new" }), answers: [] });
    assert.equal(await cmdDelete(c, "o/r", false), 0);
    assert.ok(c.out_lines.some((l) => l.startsWith(`Emptied ${dir}`)), c.out_lines.join("\n"));
    assert.ok(!c.out_lines.some((l) => l.startsWith("Kept ")), c.out_lines.join("\n"));
    assert.deepEqual(readdirSync(dir), []);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delete asks before removing a container with no forge metadata", async () => {
  const yes = fakeContext({ incus: incusWith({}), answers: [1] });
  assert.equal(await cmdDelete(yes, "o/r", false), 0);
  assert.ok(deleted(yes));
  assert.ok(yes.out_lines.some((l) => l.startsWith("Kept ")));

  const no = fakeContext({ incus: incusWith({}), answers: [2] });
  await assert.rejects(() => cmdDelete(no, "o/r", false), /left alone\. From a script: forge delete o\/r --force/);
  assert.ok(!deleted(no));

  const forced = fakeContext({ incus: incusWith({}), answers: [] });
  assert.equal(await cmdDelete(forced, "o/r", true), 0);
  assert.ok(deleted(forced));
});

test("delete of an unknown repo says no container was found", async () => {
  const c = fakeContext({ incus: FakeIncus.withRuntime() });
  await assert.rejects(() => cmdDelete(c, "o/r", false), /no container found for o\/r\./);
});

test("delete refuses a container that belongs to another repo", async () => {
  const c = fakeContext({ incus: incusWith({ "user.forge.provisioning": "x/y" }) });
  await assert.rejects(() => cmdDelete(c, "o/r", false), /different repo/);
  assert.ok(!deleted(c));
});
