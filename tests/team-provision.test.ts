import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { parseConfig } from "../cli/lib/config.ts";
import { memberNamed, PILOT } from "../cli/lib/team.ts";
import { provisionMember, originMirrorPath, teamMirrorPath } from "../cli/lib/team-provision.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-team-prov-"));
  mkdirSync(join(home, ".config", "agent-forge"), { recursive: true });
  writeFileSync(join(home, ".config", "agent-forge", "claude-token"), "tok-test\n");
  writeFileSync(join(home, "reviewer.md"), "Tu relis le code.\n");
  process.env.FORGE_HOME = home;
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
  process.env.FORGE_MIRRORS = join(home, "mirrors");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const k of ["FORGE_HOME", "FORGE_REPO_DIR", "FORGE_WORKSPACES", "FORGE_MIRRORS"]) delete process.env[k];
});

const IDENTITY: ExecRule[] = [
  { match: "git config --global --includes user.name", stdout: "Host User\n" },
  { match: "git config --global --includes user.email", stdout: "host@example.com\n" },
];
// A working hook refuses the probe's forbidden command with exit code 2.
const HOOK_BLOCKS: ExecRule[] = [{ match: "forge-hook-probe-deny", code: 2, stderr: "BLOCKED.\n" }];

const config = (extra: Record<string, unknown> = {}) => parseConfig("/c.json", {
  pilot: { capabilities: ["assign"], talkTo: ["web"] },
  teams: {
    web: {
      repo: "o/web",
      ...extra,
      roles: {
        lead: { capabilities: ["repo", "assign"] },
        dev: { count: 2, memory: "8GiB", cpu: 2, capabilities: ["repo", "publish"] },
        reviewer: { capabilities: ["repo", "read-team"], plugins: ["superpowers@claude-plugins-official"] },
      },
    },
  },
});

function provision(name: string, cfg = config(), rules: ExecRule[] = []) {
  const fake = FakeIncus.withRuntime({ commit: "IMGSHA" });
  const ctx = fakeContext({ incus: fake, rules: [...rules, ...IDENTITY, ...HOOK_BLOCKS] });
  return { fake, ctx, run: () => provisionMember(ctx, cfg, memberNamed(cfg, name)) };
}
const flat = (ctx: ReturnType<typeof fakeContext>) => ctx.calls.map((c) => c.join(" "));

test("a developer: launched with its keys and limits, origin mounted read-only, no team device", async () => {
  const { fake, ctx, run } = provision("agent-web-dev-1");
  await run();
  const launch = flat(ctx).find((l) => l.includes(" launch "))!;
  for (const part of ["--profile agent-forge", "-c user.forge.team=web", "-c user.forge.role=dev",
    "-c user.forge.repo=o/web", "-c limits.memory=8GiB", "-c limits.cpu=2"]) {
    assert.ok(launch.includes(part), `${part} in ${launch}`);
  }
  const devices = fake.expandedDevices("agent-forge", "agent-web-dev-1");
  assert.deepEqual(devices.origin, { type: "disk", source: originMirrorPath("web"), path: "/forge/origin.git", readonly: "true" });
  assert.equal(devices.team, undefined);
  assert.equal(devices.workspace.path, "/workspace");
  const calls = flat(ctx);
  const clone = calls.findIndex((c) => c.includes("git clone"));
  const lastDevice = calls.findLastIndex((c) => c.includes("config device add"));
  assert.ok(clone > lastDevice && lastDevice >= 0, calls.join("\n"));
  // The provisioning markers are gone at the end.
  assert.equal(fake.instances.get("agent-forge")!.get("agent-web-dev-1")!.config["user.forge.provisioning"], undefined);
});

test("the hook's audit log is excluded from the clone's status, so a fresh clone is clean", async () => {
  const { ctx, run } = provision("agent-web-dev-1");
  await run();
  assert.ok(flat(ctx).some((c) => c.includes("/.claude/bash-audit.log") && c.includes(".git/info/exclude")));
});

test("a read-team member mounts the team mirror read-only and adds the team remote", async () => {
  const { fake, ctx, run } = provision("agent-web-reviewer");
  await run();
  const devices = fake.expandedDevices("agent-forge", "agent-web-reviewer");
  assert.deepEqual(devices.team, { type: "disk", source: teamMirrorPath("web"), path: "/forge/team.git", readonly: "true" });
  assert.ok(flat(ctx).some((c) => c.includes("git -C /workspace remote add team /forge/team.git")));
});

test("the pilot has no repo: no origin device, no clone, no repo key", async () => {
  const { fake, ctx, run } = provision(PILOT);
  await run();
  const devices = fake.expandedDevices("agent-forge", PILOT);
  assert.equal(devices.origin, undefined);
  assert.ok(devices.workspace);
  assert.ok(!flat(ctx).some((c) => c.includes("git clone")));
  assert.ok(!flat(ctx).find((l) => l.includes(" launch "))!.includes("user.forge.repo"));
});

test("pushed files: token, team instructions plus the role prompt, settings with the plugins", async () => {
  const cfg = config({ prompts: home });
  const { fake, run } = provision("agent-web-reviewer", cfg);
  await run();
  const file = (path: string) => fake.files.get(`agent-forge/agent-web-reviewer${path}`);
  assert.equal(file("/home/aiuser/.config/forge/claude-token")?.mode, "600");
  const claudeMd = file("/home/aiuser/.claude/CLAUDE.md")!.content;
  assert.equal(claudeMd, `${readFileSync("container/CLAUDE.team.md", "utf8")}\nTu relis le code.\n`);
  const settings = JSON.parse(file("/home/aiuser/.claude/settings.json")!.content);
  assert.deepEqual(settings.enabledPlugins, { "superpowers@claude-plugins-official": true });
  assert.deepEqual(settings.hooks, JSON.parse(readFileSync("container/settings.json", "utf8")).hooks);
  assert.equal(file("/home/aiuser/.claude/settings.json")!.uid, "0");
  assert.ok(file("/usr/local/bin/forge-agent") && file("/home/aiuser/.claude/hooks/pre-bash.sh") && file("/home/aiuser/.claude.json"));
});

test("without plugins the settings carry no enabledPlugins", async () => {
  const { fake, run } = provision("agent-web-dev-1");
  await run();
  const settings = JSON.parse(fake.files.get("agent-forge/agent-web-dev-1/home/aiuser/.claude/settings.json")!.content);
  assert.equal(settings.enabledPlugins, undefined);
});

test("the team's git identity wins over the host's", async () => {
  const cfg = config({ gitIdentity: { name: "Team Bot", email: "team@example.com" } });
  const { ctx, run } = provision("agent-web-dev-1", cfg);
  await run();
  const calls = flat(ctx);
  assert.ok(calls.some((c) => c.includes("git config --global user.name Team Bot")));
  assert.ok(!calls.some((c) => c.includes("--includes user.name")));
});
