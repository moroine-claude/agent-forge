// The guards of a member's provisioning, ported from the single-agent flow's
// tests: nothing is created without the token and the git identity, the hook is
// proven to guard the agent both ways, a mirror of another repository is
// refused, no host git touches a workspace, and a failure leaves the
// provisioning markers on the container.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { assertNoHostGitIn } from "./lib/host-git.ts";
import { parseConfig } from "../cli/lib/config.ts";
import { proxyPlan } from "../cli/lib/ipv4.ts";
import { egressNames } from "../cli/lib/objects.ts";
import { strictLaunchArgs } from "../cli/lib/strict.ts";
import { memberNamed } from "../cli/lib/team.ts";
import { originMirrorPath, provisionMember } from "../cli/lib/team-provision.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-team-guards-"));
  mkdirSync(join(home, ".config", "agent-forge"), { recursive: true });
  writeFileSync(join(home, ".config", "agent-forge", "claude-token"), "tok-test\n");
  process.env.FORGE_HOME = home;
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
  process.env.FORGE_MIRRORS = join(home, "mirrors");
  // The proxy plan comes from the user's config: never the real one.
  process.env.XDG_CONFIG_HOME = join(home, "xdg");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const k of ["FORGE_HOME", "FORGE_REPO_DIR", "FORGE_WORKSPACES", "FORGE_MIRRORS", "XDG_CONFIG_HOME"]) delete process.env[k];
});

const IDENTITY: ExecRule[] = [
  { match: "git config --global --includes user.name", stdout: "Host User\n" },
  { match: "git config --global --includes user.email", stdout: "host@example.com\n" },
];
const HOOK_BLOCKS: ExecRule[] = [{ match: "forge-hook-probe-deny", code: 2, stderr: "BLOCKED.\n" }];

const config = (strict = false) => parseConfig("/c.json", {
  teams: { web: { repo: "o/web", roles: { dev: { capabilities: ["repo", "publish"], strict } } } },
});
const DEV = "agent-web-dev";

function strictFake(): FakeIncus {
  const fake = FakeIncus.withRuntime({ commit: "IMGSHA" });
  fake.acls.set("forge-egress-strict", { name: "forge-egress-strict", description: "", config: {}, ingress: [], egress: [] });
  fake.addInstance("agent-forge", "forge-proxy", { config: { "user.forge.proxy_recipe": "1" } });
  return fake;
}

function provision(opts: { rules?: ExecRule[]; strict?: boolean; fake?: FakeIncus } = {}) {
  const cfg = config(opts.strict);
  const fake = opts.fake ?? FakeIncus.withRuntime({ commit: "IMGSHA" });
  const ctx = fakeContext({ incus: fake, rules: [...(opts.rules ?? []), ...IDENTITY, ...HOOK_BLOCKS] });
  return { fake, ctx, run: () => provisionMember(ctx, cfg, memberNamed(cfg, DEV)) };
}
const flat = (ctx: ReturnType<typeof fakeContext>) => ctx.calls.map((c) => c.join(" "));
const launched = (ctx: ReturnType<typeof fakeContext>) => flat(ctx).some((l) => l.includes(" launch "));
const instance = (fake: FakeIncus) => fake.instances.get("agent-forge")!.get(DEV)!;

test("without a token file, provisioning stops before launch, naming forge install", async () => {
  rmSync(join(home, ".config", "agent-forge", "claude-token"));
  const { ctx, run } = provision();
  await assert.rejects(run, /forge install/);
  assert.equal(launched(ctx), false);
});

test("without a host git identity, it stops before launch with the commands to run", async () => {
  const { ctx, run } = provision({ rules: [{ match: "git config --global --includes user.email", code: 1 }] });
  await assert.rejects(run, /git config --global user\.name/);
  assert.equal(launched(ctx), false);
});

test("without the profile or the image, it names forge setup or forge image build", async () => {
  const noProfile = new FakeIncus();
  noProfile.addProject("agent-forge");
  await assert.rejects(provision({ fake: noProfile }).run, /forge setup/);
  const noImage = new FakeIncus();
  noImage.addProject("agent-forge");
  noImage.addProfile("agent-forge", "agent-forge");
  await assert.rejects(provision({ fake: noImage }).run, /forge image build/);
});

test("the installed hook is proven to guard the agent both ways, as aiuser, after it is pushed", async () => {
  const { ctx, run } = provision();
  await run();
  const calls = flat(ctx);
  const pushed = calls.findIndex((l) => l.includes("file push") && l.includes("/home/aiuser/.claude/hooks/pre-bash.sh"));
  const deny = calls.findIndex((l) => l.includes("forge-hook-probe-deny"));
  const allow = calls.findIndex((l) => l.includes("forge-hook-probe-allow"));
  assert.ok(pushed >= 0 && deny > pushed && allow > pushed, calls.join("\n"));
  for (const probe of [calls[deny], calls[allow]]) assert.ok(probe.includes("--user 1001"), probe);
});

test("a hook that lets a forbidden command through aborts, and the markers stay so the half-built container is known", async () => {
  const { fake, run } = provision({ rules: [{ match: "forge-hook-probe-deny", code: 0, stderr: "pre-bash.sh: jq: command not found\n" }] });
  await assert.rejects(run, (e: Error) => /let a forbidden command through/.test(e.message) && /jq: command not found/.test(e.message)
    && e.message.includes(`delete ${DEV} --force`));
  assert.equal(instance(fake).config["user.forge.provisioning"], "o/web");
});

test("a hook that refuses a harmless command aborts too", async () => {
  const { run } = provision({ rules: [{ match: "forge-hook-probe-allow", code: 2, stderr: "BLOCKED: jq introuvable.\n" }] });
  await assert.rejects(run, (e: Error) => /refuses a harmless command/.test(e.message) && !e.message.includes(".."));
});

// The refusals come before anything is created: a mirror of another repository
// names the real cause, and leaves no container behind.
test("a mirror of another repository stops before the launch", async () => {
  mkdirSync(originMirrorPath("web"), { recursive: true });
  const { ctx, run } = provision({ rules: [{ match: "--get remote.origin.url", stdout: "git@github.com:a/b.git\n" }] });
  await assert.rejects(run, /mirror of a\/b/);
  assert.equal(launched(ctx), false);
});

test("a non-empty workspace that no mirror vouches for stops before the launch", async () => {
  mkdirSync(join(home, "workspaces", DEV), { recursive: true });
  writeFileSync(join(home, "workspaces", DEV, "README.md"), "x");
  const { ctx, run } = provision();
  await assert.rejects(run, /no mirror of o\/web/);
  assert.equal(launched(ctx), false);
});

test("a failing clone in the container leaves the provisioning markers", async () => {
  const { fake, run } = provision({ rules: [{ match: "git clone --no-local", code: 128, stderr: "fatal: unreadable\n" }] });
  await assert.rejects(run, /clone repository failed: fatal: unreadable/);
  assert.equal(instance(fake).config["user.forge.provisioning"], "o/web");
});

test("the markers are gone once everything is done", async () => {
  const { fake, run } = provision();
  await run();
  assert.equal(instance(fake).config["user.forge.provisioning"], undefined);
  assert.equal(instance(fake).config["user.forge.provisioning_workspace"], undefined);
  assert.equal(instance(fake).config["user.forge.mode"], "supervised");
  assert.equal(instance(fake).config["user.forge.image_commit"], "IMGSHA");
});

test("no host git touches the workspaces", async () => {
  const { ctx, run } = provision();
  await run();
  assertNoHostGitIn(ctx.calls, join(home, "workspaces"));
});

test("a strict role launches with every override in the same call, and its settings come right after waitReady", async () => {
  const { ctx, run } = provision({ strict: true, fake: strictFake() });
  await run();
  const launches = ctx.calls.filter((c) => c.includes("launch"));
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0].slice(-strictLaunchArgs(proxyPlan("10.77.0.1/24", 0), egressNames("agent-forge")).length),
    strictLaunchArgs(proxyPlan("10.77.0.1/24", 0), egressNames("agent-forge")));
  const calls = flat(ctx);
  const ready = calls.findIndex((l) => l.includes("is-system-running --wait"));
  const settings = calls.findIndex((l) => l.includes("file push") && l.includes(`${DEV}/etc/profile.d/agent-forge-proxy.sh`));
  const token = calls.findIndex((l) => l.includes("file push") && l.includes("claude-token"));
  assert.ok(ready >= 0 && settings > ready && settings < token, calls.join("\n"));
});

test("a strict role is refused before anything is created when the proxy is missing", async () => {
  const fake = FakeIncus.withRuntime({ commit: "IMGSHA" });
  const { ctx, run } = provision({ strict: true, fake });
  await assert.rejects(run, /forge setup|7\.0\.2/);
  assert.equal(launched(ctx), false);
});
