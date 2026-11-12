import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { assertNoHostGitIn } from "./lib/host-git.ts";
import { mirrorPath } from "../cli/lib/paths.ts";
import { discardHalfProvisioned, provisionContainer } from "../cli/lib/commands/provision.ts";
import { provisioningMarker } from "../cli/lib/containers.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-prov-"));
  mkdirSync(join(home, ".config", "agent-forge"), { recursive: true });
  writeFileSync(join(home, ".config", "agent-forge", "claude-token"), "tok-test\n");
  process.env.FORGE_HOME = home;
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
  process.env.FORGE_MIRRORS = join(home, "mirrors");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.FORGE_HOME;
  delete process.env.FORGE_REPO_DIR;
  delete process.env.FORGE_WORKSPACES;
  delete process.env.FORGE_MIRRORS;
});

// Quotes, spaces and a command substitution: the identity must reach git as
// it is, never through a shell.
const NAME = `Ada O'Brien "$(id)"`;
const EMAIL = "ada@example.com";
const IDENTITY: ExecRule[] = [
  { match: "git config --global --includes user.name", stdout: `${NAME}\n` },
  { match: "git config --global --includes user.email", stdout: `${EMAIL}\n` },
];

// A working hook refuses the probe's forbidden command with exit code 2 and
// lets its harmless command through (the fake's default exit code is 0).
const HOOK_BLOCKS: ExecRule[] = [{ match: "forge-hook-probe-deny", code: 2, stderr: "BLOCKED: sudo non autorisé.\n" }];

function provision(opts: { rules?: ExecRule[]; fake?: FakeIncus } = {}) {
  const fake = opts.fake ?? FakeIncus.withRuntime({ commit: "IMGSHA" });
  const ctx = fakeContext({ incus: fake, rules: [...(opts.rules ?? []), ...IDENTITY, ...HOOK_BLOCKS] });
  return { fake, ctx, run: () => provisionContainer(ctx, "agent-x", "o/r") };
}
const flat = (ctx: ReturnType<typeof fakeContext>) => ctx.calls.map((c) => c.join(" "));
const launched = (ctx: ReturnType<typeof fakeContext>) => flat(ctx).some((l) => l.includes(" launch "));

function seedWorkspace(...files: string[]) {
  const dir = join(home, "workspaces", "agent-x");
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), "x");
  return dir;
}
// A mirror left by a previous container, cloned from `url`.
function seedMirror(url: string): ExecRule {
  mkdirSync(mirrorPath("agent-x"), { recursive: true });
  return { match: "--get remote.origin.url", stdout: `${url}\n` };
}
const WORKSPACE = () => join(home, "workspaces", "agent-x");

test("a new container is launched from agent-base under the agent-forge profile, then waited for", async () => {
  const { ctx, run } = provision();
  await run();
  const calls = flat(ctx);
  const launch = calls.findIndex((l) => l.startsWith("incus --project agent-forge launch agent-base agent-x --profile agent-forge"));
  const ready = calls.indexOf("incus --project agent-forge exec agent-x -- systemctl is-system-running --wait");
  assert.ok(launch >= 0 && ready > launch, calls.join("\n"));
});

test("without a token file, provisioning stops before launch", async () => {
  rmSync(join(home, ".config", "agent-forge", "claude-token"));
  const { ctx, run } = provision();
  await assert.rejects(run, /forge install/);
  assert.equal(launched(ctx), false);
});

test("the forge-agent launcher is pushed, root-owned and executable", async () => {
  const { fake, run } = provision();
  await run();
  const launcher = fake.files.get("agent-forge/agent-x/usr/local/bin/forge-agent");
  assert.ok(launcher, [...fake.files.keys()].join("\n"));
  assert.deepEqual([launcher.uid, launcher.gid, launcher.mode], ["0", "0", "755"]);
});

test("the token is pushed, mode 600, and no credentials file", async () => {
  const { fake, ctx, run } = provision();
  await run();
  const token = fake.files.get("agent-forge/agent-x/home/aiuser/.config/forge/claude-token");
  assert.ok(token, [...fake.files.keys()].join("\n"));
  assert.deepEqual([token.uid, token.gid, token.mode], ["1001", "1001", "600"]);
  assert.ok(![...fake.files.keys()].some((k) => k.endsWith(".credentials.json")));
  // The directory is private, made as the agent, before the push.
  const calls = flat(ctx);
  const mkdir = calls.findIndex((c) => c.includes("mkdir -p -m 700 /home/aiuser/.config/forge"));
  const push = calls.findIndex((c) => c.includes("file push") && c.includes("claude-token"));
  assert.ok(mkdir >= 0 && push > mkdir, calls.join("\n"));
  // The value is never in an argv.
  assert.ok(!calls.some((c) => c.includes("tok-test")));
});


test("it refuses without a host git identity, with the commands to run", async () => {
  const { ctx, run } = provision({ rules: [{ match: "git config --global --includes user.email", code: 1 }] });
  await assert.rejects(run, (e: Error) => {
    assert.match(e.message, /git config --global user\.name/);
    assert.match(e.message, /git config --global user\.email/);
    return true;
  });
  assert.equal(launched(ctx), false);
});

// Defense in depth: started from inside ~/workspaces/<c>, host git would
// discover the agent's repository, even for `config --global --includes`.
test("every host git call of a provisioning runs from /, whatever forge's own cwd", async () => {
  const { ctx, run } = provision();
  await run();
  const hostGit = ctx.calls.flatMap((c, i) => (c[0] === "git" ? [i] : []));
  assert.ok(hostGit.length >= 3, flat(ctx).join("\n"));
  for (const i of hostGit) assert.equal(ctx.execOptions[i]?.cwd, "/", ctx.calls[i].join(" "));
});

test("it names forge setup when the profile is missing", async () => {
  const fake = new FakeIncus();
  fake.addProject("agent-forge");
  fake.addImage("agent-forge", "agent-base");
  const { ctx, run } = provision({ fake });
  await assert.rejects(run, /Run 'forge setup' first/);
  assert.equal(launched(ctx), false);
});

test("it names forge image build when agent-base is missing", async () => {
  const fake = new FakeIncus();
  fake.addProject("agent-forge");
  fake.addProfile("agent-forge", "agent-forge");
  const { ctx, run } = provision({ fake });
  await assert.rejects(run, /Run 'forge image build' first/);
  assert.equal(launched(ctx), false);
});

test("the host identity reaches git as argv elements, and commits are unsigned", async () => {
  const { ctx, run } = provision();
  await run();
  const gitCalls = ctx.calls.filter((c) => c[0] === "incus" && c.includes("git") && c.includes("--global"));
  assert.deepEqual(gitCalls.map((c) => c.slice(c.indexOf("--") + 1)), [
    ["git", "config", "--global", "user.name", NAME],
    ["git", "config", "--global", "user.email", EMAIL],
    ["git", "config", "--global", "commit.gpgsign", "false"],
  ]);
  for (const c of gitCalls) {
    assert.deepEqual(c.slice(3, c.indexOf("--")),
      ["exec", "agent-x", "--user", "1001", "--group", "1001", "--env", "HOME=/home/aiuser"]);
  }
});

test("no autonomous remnant: no prompt, no gh, no signing key, no cloud-init cleanup", async () => {
  const { ctx, run } = provision();
  await run();
  const all = flat(ctx).join("\n");
  for (const gone of ["gh auth", "signing", "gpg.format", "deluser", "sudoers", "https://github.com/o/r", "lxd init"]) {
    assert.ok(!all.includes(gone), gone);
  }
  assert.ok(!ctx.err_lines.some((l) => l.endsWith("> ") || l.endsWith(": ")), "no question is asked");
});

test("the workspace is mounted without shift", async () => {
  const { fake, run } = provision();
  await run();
  assert.deepEqual(fake.instances.get("agent-forge")!.get("agent-x")!.devices.workspace,
    { type: "disk", source: join(home, "workspaces", "agent-x"), path: "/workspace" });
});

test("files come from container/; the hook and the settings belong to root", async () => {
  const { ctx, run } = provision();
  await run();
  const push = (dest: string) => ctx.calls.find((c) => c.includes("push") && c.includes(`agent-x${dest}`))!;
  const repo = (file: string) => join(process.cwd(), "container", file);
  assert.ok(push("/home/aiuser/.claude.json").includes(repo("claude.json")));
  assert.ok(push("/home/aiuser/.claude/CLAUDE.md").includes(repo("CLAUDE.md")));
  for (const [dest, file] of [["/home/aiuser/.claude/hooks/pre-bash.sh", "pre-bash.sh"], ["/home/aiuser/.claude/settings.json", "settings.json"]]) {
    const c = push(dest);
    assert.ok(c.includes(repo(file)), c.join(" "));
    assert.equal(c[c.indexOf("--uid") + 1], "0");
  }
});

// The hook is the agent's guardrail: a hook that cannot read its input (no
// jq in the image, 2026-10-17) let every command through, silently.
test("provisioning proves the installed hook guards aiuser both ways", async () => {
  const { ctx, run } = provision();
  await run();
  const calls = flat(ctx);
  const pushed = calls.findIndex((l) => l.includes("push") && l.includes("agent-x/home/aiuser/.claude/hooks/pre-bash.sh"));
  const deny = calls.findIndex((l) => l.includes("forge-hook-probe-deny"));
  const allow = calls.findIndex((l) => l.includes("forge-hook-probe-allow"));
  assert.ok(pushed >= 0 && deny > pushed && allow > pushed, calls.join("\n"));
  for (const probe of [calls[deny], calls[allow]]) assert.ok(probe.includes("--user 1001"), probe);
  assert.ok(calls[deny].includes("sudo"), calls[deny]);
});

// The v1 hook without jq: everything got through.
test("a hook that lets a forbidden command through aborts provisioning", async () => {
  const { fake, run } = provision({ rules: [{ match: "forge-hook-probe-deny", code: 0, stderr: "pre-bash.sh: line 9: jq: command not found\n" }] });
  await assert.rejects(run, (e: Error) => /let a forbidden command through/.test(e.message) && /jq: command not found/.test(e.message));
  assert.equal(fake.instances.get("agent-forge")!.get("agent-x")!.config["user.forge.repo"], undefined);
});

// The fail-closed hook without jq: everything is refused, the agent cannot
// run anything — safe, but useless, and silent unless provisioning says so.
test("a hook that refuses a harmless command aborts provisioning", async () => {
  const { fake, run } = provision({ rules: [{ match: "forge-hook-probe-allow", code: 2, stderr: "BLOCKED: jq introuvable, le hook ne peut pas lire la commande (fail-closed).\n" }] });
  // The hook's own sentence ends with a period: no ".." in the message. The
  // half-provisioned container still carries its provisioning markers, so
  // `forge delete` can remove it: the message points there.
  await assert.rejects(run, (e: Error) => /refuses a harmless command/.test(e.message) && /jq introuvable/.test(e.message)
    && !e.message.includes("..") && e.message.includes("forge delete o/r"));
  assert.equal(fake.instances.get("agent-forge")!.get("agent-x")!.config["user.forge.repo"], undefined);
});

test("the mode is supervised, in the marker and in the metadata", async () => {
  const { fake, ctx, run } = provision();
  await run();
  assert.ok(flat(ctx).some((l) => l.includes("echo 'supervised' > /home/aiuser/.claude/forge-mode")));
  assert.equal(fake.instances.get("agent-forge")!.get("agent-x")!.config["user.forge.mode"], "supervised");
});

test("the metadata records the repo and the image's commit", async () => {
  const { fake, run } = provision();
  await run();
  const config = fake.instances.get("agent-forge")!.get("agent-x")!.config;
  assert.equal(config["user.forge.repo"], "o/r");
  assert.equal(config["user.forge.image_commit"], "IMGSHA");
});

test("Claude Code is refreshed from apt; a failure only warns", async () => {
  const { fake, ctx, run } = provision({ rules: [{ match: "apt-get update", code: 100, stderr: "E: network down\n" }] });
  await run();
  assert.ok(ctx.err_lines.some((l) => l.startsWith("WARNING") && l.includes("E: network down")), ctx.err_lines.join("\n"));
  assert.equal(fake.instances.get("agent-forge")!.get("agent-x")!.config["user.forge.repo"], "o/r");
});

test("Claude Code is upgraded only when the package lists were refreshed", async () => {
  const { ctx, run } = provision();
  await run();
  const calls = flat(ctx);
  const update = calls.findIndex((l) => l.endsWith("-- apt-get update"));
  const upgrade = calls.findIndex((l) => l.endsWith("-- apt-get install --only-upgrade -y claude-code"));
  assert.ok(update >= 0 && upgrade > update, calls.join("\n"));
});

test("provisioning prints no retrieval hint", async () => {
  const { ctx, run } = provision();
  await run();
  assert.ok(!ctx.err_lines.some((l) => l.includes("git remote add")), ctx.err_lines.join("\n"));
  assert.deepEqual(ctx.notified, []);
});

// Kept from v1: the LFS filters are fatal, the repo's own hooks best-effort,
// the .trees/ exclude a step of its own.
test("failing to install the LFS filters aborts provisioning, with git's message", async () => {
  const { run } = provision({ rules: [{ match: "lfs install --skip-repo", code: 1, stderr: "fatal: not in a git directory\n" }] });
  await assert.rejects(run, /git-lfs filters in agent-x failed: fatal: not in a git directory/);
});

// The mirror holds no LFS object: both `git lfs install` (global filters, then
// the repository's hooks, which rewrites the filters too) keep the pointers.
// Without --skip-smudge, `git worktree add` fails on the first LFS file.
test("every git lfs install keeps LFS files as pointers (--skip-smudge)", async () => {
  const { ctx, run } = provision();
  await run();
  const installs = flat(ctx).filter((l) => l.includes("git lfs install"));
  assert.equal(installs.length, 2, installs.join("\n"));
  for (const l of installs) assert.ok(l.includes("--skip-smudge"), l);
});

const HOOKS_CONFLICT: ExecRule = {
  match: "cd /workspace && git lfs install",
  code: 2,
  stderr: "Hook already exists: pre-push\n\nTo resolve this, either:\n  1: run `git lfs update --manual`\n",
};

test("a repo that manages its own hooks does not abort provisioning", async () => {
  const { fake, ctx, run } = provision({ rules: [HOOKS_CONFLICT] });
  await run();
  assert.match(ctx.err_lines.join("\n"), /Hook already exists: pre-push/);
  assert.equal(fake.instances.get("agent-forge")!.get("agent-x")!.config["user.forge.repo"], "o/r");
});

test("the worktree exclude is its own step, written even when the hooks step fails", async () => {
  const { ctx, run } = provision({ rules: [HOOKS_CONFLICT] });
  await run();
  const calls = flat(ctx);
  assert.ok(calls.some((l) => l.includes("info/exclude")));
  assert.ok(!calls.some((l) => l.includes("lfs install") && l.includes("info/exclude")));
});

test("the mirror is created on the host before the launch", async () => {
  const { ctx, run } = provision();
  await run();
  const calls = flat(ctx);
  const clone = calls.findIndex((l) => l.startsWith("git ") && l.includes("clone --bare"));
  const launch = calls.findIndex((l) => l.includes(" launch "));
  assert.ok(clone >= 0 && launch > clone, calls.join("\n"));
  assert.ok(calls[clone].endsWith(`git@github.com:o/r.git ${mirrorPath("agent-x")}`), calls[clone]);
});

test("the workspace is cloned inside the container, after both devices", async () => {
  const { fake, ctx, run } = provision();
  assert.deepEqual(await run(), { mirror: "created" });
  const devices = fake.instances.get("agent-forge")!.get("agent-x")!.devices;
  assert.deepEqual(devices.origin,
    { type: "disk", source: mirrorPath("agent-x"), path: "/forge/origin.git", readonly: "true" });
  assert.deepEqual(devices.workspace, { type: "disk", source: WORKSPACE(), path: "/workspace" });
  const calls = flat(ctx);
  const adds = calls.map((l, i) => (l.includes("device add") ? i : -1)).filter((i) => i >= 0);
  const clone = calls.findIndex((l) => l.endsWith("env GIT_LFS_SKIP_SMUDGE=1 git clone --no-local /forge/origin.git /workspace"));
  assert.equal(adds.length, 2, calls.join("\n"));
  assert.ok(clone > Math.max(...adds), calls.join("\n"));
});

test("no host git touches the workspaces, new container or reuse", async () => {
  const fresh = provision();
  await fresh.run();
  assertNoHostGitIn(fresh.ctx.calls, join(home, "workspaces"));

  seedWorkspace("README.md");
  const reuse = provision({ rules: [seedMirror("git@github.com:o/r.git")] });
  await reuse.run();
  assertNoHostGitIn(reuse.ctx.calls, join(home, "workspaces"));
});

test("a workspace with a matching mirror is reused", async () => {
  seedWorkspace("README.md");
  const { ctx, run } = provision({ rules: [seedMirror("git@github.com:o/r.git")] });
  assert.deepEqual(await run(), { mirror: "kept" });
  const calls = flat(ctx);
  assert.ok(!calls.some((l) => l.includes("clone")), calls.join("\n"));
  assert.equal(calls.filter((l) => l.endsWith("remote set-url origin /forge/origin.git")).length, 1);
  assert.equal(calls.filter((l) => l.includes("--get remote.origin.url")).length, 1, "the mirror is probed once");
});

// The refusals come before the mirror is created: a refused workspace leaves
// no new mirror behind.
test("a non-empty workspace without a mirror stops before the mirror and the launch", async () => {
  seedWorkspace("README.md");
  const { ctx, run } = provision();
  await assert.rejects(run, /no mirror of o\/r/);
  assert.ok(!flat(ctx).some((l) => l.includes("clone --bare")), flat(ctx).join("\n"));
  assert.equal(launched(ctx), false);
});

// With a non-empty workspace too, the mirror's own refusal comes first: it is
// the one that names the real cause.
test("a mirror of another repo stops before the launch, ahead of the workspace check", async () => {
  seedWorkspace("README.md");
  const { ctx, run } = provision({ rules: [seedMirror("git@github.com:a/b.git")] });
  await assert.rejects(run, /mirror of a\/b/);
  assert.equal(launched(ctx), false);
});

test("a failing clone in the container stops before the metadata", async () => {
  const { fake, run } = provision({ rules: [{ match: "git clone --no-local", code: 128, stderr: "fatal: unreadable\n" }] });
  await assert.rejects(run, /clone repository failed: fatal: unreadable/);
  assert.equal(fake.instances.get("agent-forge")!.get("agent-x")!.config["user.forge.repo"], undefined);
});

test("a failing origin realignment stops before the metadata", async () => {
  seedWorkspace("README.md");
  const { fake, run } = provision({ rules: [
    seedMirror("git@github.com:o/r.git"),
    { match: "remote set-url origin", code: 2, stderr: "error: No such remote 'origin'\n" },
  ] });
  await assert.rejects(run, /realign origin remote failed: error: No such remote/);
  assert.equal(fake.instances.get("agent-forge")!.get("agent-x")!.config["user.forge.repo"], undefined);
});

test("a failing mirror clone stops before the launch", async () => {
  const { ctx, run } = provision({ rules: [{ match: "clone --bare", code: 128, stderr: "Permission denied (publickey)\n" }] });
  await assert.rejects(run, /create mirror failed: Permission denied/);
  assert.equal(launched(ctx), false);
});

// --- strict mode ---
import { proxyPlan } from "../cli/lib/ipv4.ts";
import { egressNames } from "../cli/lib/objects.ts";
import { strictLaunchArgs } from "../cli/lib/strict.ts";

// Default config (10.77.0.1/24): no config file under this XDG dir.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "forge-prov-xdg-"));

function strictFake(opts: { acl?: boolean; proxy?: boolean; version?: string } = {}): FakeIncus {
  const fake = FakeIncus.withRuntime({ commit: "IMGSHA" });
  if (opts.version) fake.serverVersion = opts.version;
  if (opts.acl ?? true) {
    fake.acls.set("forge-egress-strict", { name: "forge-egress-strict", description: "", config: {}, ingress: [], egress: [] });
  }
  if (opts.proxy ?? true) fake.addInstance("agent-forge", "forge-proxy", { config: { "user.forge.proxy_recipe": "1" } });
  return fake;
}
const strictProvision = (opts: { rules?: ExecRule[]; fake?: FakeIncus } = {}) => {
  const fake = opts.fake ?? strictFake();
  const ctx = fakeContext({ incus: fake, rules: [...(opts.rules ?? []), ...IDENTITY, ...HOOK_BLOCKS] });
  return { fake, ctx, run: () => provisionContainer(ctx, "agent-x", "o/r", { strict: true }) };
};

test("--strict launches with every override in the same call; there is no launch without them", async () => {
  const { ctx, run } = strictProvision();
  await run();
  const launches = ctx.calls.filter((c) => c.includes("launch"));
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0], ["incus", "--project", "agent-forge", "launch", "agent-base", "agent-x", "--profile", "agent-forge",
    "-c", "user.forge.provisioning=o/r", "-c", "user.forge.provisioning_workspace=new",
    ...strictLaunchArgs(proxyPlan("10.77.0.1/24", 0), egressNames("agent-forge"))]);
});

test("--strict applies the settings right after waitReady, before the token push", async () => {
  const { ctx, run } = strictProvision();
  await run();
  const calls = flat(ctx);
  const ready = calls.findIndex((l) => l.includes("is-system-running --wait"));
  const settings = calls.findIndex((l) => l.includes("file push") && l.includes("agent-x/etc/profile.d/agent-forge-proxy.sh"));
  const token = calls.findIndex((l) => l.includes("file push") && l.includes("claude-token"));
  assert.ok(ready >= 0 && settings > ready && settings < token, calls.join("\n"));
});

for (const [what, fake] of [
  ["the gate", () => strictFake({ version: "7.0.1" })],
  ["the ACL", () => strictFake({ acl: false })],
  ["the proxy", () => strictFake({ proxy: false })],
] as const) {
  test(`--strict refuses before creating anything when ${what} is missing`, async () => {
    const { ctx, run } = strictProvision({ fake: fake() });
    await assert.rejects(run, /forge setup|7\.0\.2/);
    assert.equal(launched(ctx), false);
  });
}

test("--strict: the Claude refresh reads only Anthropic's apt source", async () => {
  const { ctx, run } = strictProvision();
  await run();
  assert.ok(flat(ctx).some((l) => l.endsWith("-- apt-get update -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/claude-code.sources " +
    "-o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0")), flat(ctx).join("\n"));
  assert.ok(flat(ctx).some((l) => l.endsWith("-- apt-get install --only-upgrade -y claude-code")));
});

test("no plugin is installed, in either mode (DX 5 decision 15)", async () => {
  for (const make of [provision, strictProvision]) {
    const { ctx, run } = make();
    await run();
    assert.ok(!flat(ctx).some((l) => l.includes("claude plugin")), flat(ctx).join("\n"));
  }
});

test("without --strict, provisioning is unchanged", async () => {
  const { ctx, run } = provision();
  await run();
  assert.ok(!flat(ctx).some((l) => l.includes(" launch ") && l.includes(" -d ")));
  assert.ok(!flat(ctx).some((l) => l.includes("agent-forge-proxy.sh")));
});

test("the container is launched with the provisioning markers", async () => {
  const { ctx, run } = provision();
  await run();
  const launch = flat(ctx).find((l) => l.includes(" launch ")) ?? "";
  assert.match(launch, /-c user\.forge\.provisioning=o\/r/);
  assert.match(launch, /-c user\.forge\.provisioning_workspace=new/);
});

test("a reused workspace is marked kept", async () => {
  seedWorkspace("README");
  const { ctx, run } = provision({ rules: [seedMirror("git@github.com:o/r.git")] });
  await run();
  assert.match(flat(ctx).find((l) => l.includes(" launch ")) ?? "", /provisioning_workspace=kept/);
});

test("the markers are removed after user.forge.repo, at the very end", async () => {
  const { ctx, run } = provision();
  await run();
  const calls = flat(ctx);
  const repo = calls.findIndex((l) => l.includes("config set agent-x user.forge.repo o/r"));
  const unset = calls.findIndex((l) => l.includes("config unset agent-x user.forge.provisioning"));
  assert.ok(repo >= 0 && unset > repo, calls.join("\n"));
  assert.equal(await provisioningMarker(ctx, "agent-x"), null);
});

test("a failed hook probe points at forge delete, not at incus", async () => {
  const { run } = provision({ rules: [{ match: "forge-hook-probe-deny", code: 0 }] });
  await assert.rejects(run, (e: Error) => /forge delete o\/r/.test(e.message) && !/incus --project/.test(e.message));
});

// Nothing that existed before the failed attempt may be deleted: a reused
// workspace can hold the only copy of unretrieved work.
test("discarding removes the instance and empties a workspace the failed attempt created", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-x", { config: { "user.forge.provisioning": "o/r", "user.forge.provisioning_workspace": "new" } });
  const dir = seedWorkspace("partial");
  await discardHalfProvisioned(fakeContext({ incus: fake }), "agent-x");
  assert.equal(fake.instances.get("agent-forge")!.has("agent-x"), false);
  assert.deepEqual(readdirSync(dir), []);
});

test("discarding keeps a workspace the failed attempt reused", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-x", { config: { "user.forge.provisioning": "o/r", "user.forge.provisioning_workspace": "kept" } });
  const dir = seedWorkspace("unretrieved");
  await discardHalfProvisioned(fakeContext({ incus: fake }), "agent-x");
  assert.equal(fake.instances.get("agent-forge")!.has("agent-x"), false);
  assert.deepEqual(readdirSync(dir), ["unretrieved"]);
});
