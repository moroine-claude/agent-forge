import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { parseConfig } from "../cli/lib/config.ts";
import { memberNamed } from "../cli/lib/team.ts";
import { hcArgv, sessionState, startSession } from "../cli/lib/hc-session.ts";

const cfg = parseConfig("/c.json", {
  teams: { web: { repo: "o/web", roles: { dev: { count: 1, capabilities: ["repo", "publish"] } } } },
});
const DEV = "agent-web-dev-1";

function setup(rules: ExecRule[] = []) {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", DEV, { status: "Running" });
  return { fake, ctx: fakeContext({ incus: fake, rules }) };
}

test("hcArgv runs hc as the agent, in /workspace, with the core's session bus", () => {
  assert.deepEqual(hcArgv(DEV, ["get", "agent"]), [
    "incus", "--project", "agent-forge", "exec", DEV,
    "--user", "1001", "--group", "1001", "--cwd", "/workspace",
    "--env", "HOME=/home/aiuser",
    "--env", "XDG_RUNTIME_DIR=/run/user/1001",
    "--env", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus",
    "--", "hc", "get", "agent",
  ]);
});

test("startSession: old session removed, instruction pushed as a file, then hc run; the text is in no argv", async () => {
  const { fake, ctx } = setup();
  const text = "Corrige le login $(id) 'quoted'";
  await startSession(ctx, memberNamed(cfg, DEV), "fix-login", text);
  const calls = ctx.calls.map((c) => c.join(" "));
  const kill = calls.findIndex((c) => c.endsWith("-- hc kill agent"));
  const rm = calls.findIndex((c) => c.endsWith("-- hc rm agent"));
  const push = calls.findIndex((c) => c.includes("file push") && c.includes("/home/aiuser/.forge/instruction.md"));
  const run = calls.findIndex((c) => c.includes("-- hc run --bg --name agent --cwd /workspace forge-agent"));
  assert.ok(kill >= 0 && rm > kill && push > rm && run > push, calls.join("\n"));
  assert.ok(calls[run].endsWith(
    `forge-agent --forge-task ${DEV}-fix-login --permission-mode auto --instruction-file /home/aiuser/.forge/instruction.md`));
  const file = fake.files.get(`agent-forge/${DEV}/home/aiuser/.forge/instruction.md`)!;
  assert.deepEqual([file.content, file.uid, file.mode], [text, "1001", "600"]);
  assert.ok(!ctx.calls.some((c) => c.some((a) => a.includes("Corrige"))));
});

test("startSession: a task without a branch is marked <container>-session; a failing kill is ignored", async () => {
  const { ctx } = setup([{ match: "hc kill agent", code: 1 }, { match: "hc rm agent", code: 1 }]);
  await startSession(ctx, memberNamed(cfg, DEV), "-", "Relis");
  assert.ok(ctx.calls.some((c) => c.join(" ").includes(`--forge-task ${DEV}-session `)));
});

test("sessionState maps hc get to a state", async () => {
  const get = (rule: ExecRule) => sessionState(setup([rule]).ctx, DEV);
  assert.equal(await get({ match: "hc get agent", stdout: '{"status":{"app":"claude-code","state":"working"}}' }), "working");
  assert.equal(await get({ match: "hc get agent", stdout: '{"status":{"state":"done"}}' }), "done");
  assert.equal(await get({ match: "hc get agent", code: 1 }), "none");
  assert.equal(await get({ match: "hc get agent", stdout: "not json" }), "unknown");
});
