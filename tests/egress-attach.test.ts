// Sub-project 3's egress hooks on the paths to the agent. Every start goes
// through ensureRunning (the version gate, the marker/NIC check, the proxy),
// every session through startSession (the strict settings follow the mode).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext, type ExecRule } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { ensureRunning } from "../cli/lib/session.ts";
import { startSession } from "../cli/lib/hc-session.ts";
import type { Member } from "../cli/lib/team.ts";

// The proxy plan comes from the user's config: never the real one.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "forge-egress-attach-xdg-"));

const STRICT_NIC = {
  type: "nic", network: "forgebr0", "security.acls": "forge-egress-strict",
  "security.acls.default.egress.action": "reject", "security.acls.default.ingress.action": "reject",
};

type Status = "Running" | "Stopped";

function egressFake(opts: {
  mode?: "strict" | "open"; status?: Status; version?: string; nic?: "strict"; proxy?: Status;
} = {}): FakeIncus {
  const fake = FakeIncus.withRuntime();
  if (opts.version) fake.serverVersion = opts.version;
  fake.acls.set("forge-egress-strict", { name: "forge-egress-strict", description: "", config: {}, ingress: [], egress: [] });
  fake.addInstance("agent-forge", "forge-proxy", { status: opts.proxy ?? "Running", config: { "user.forge.proxy_recipe": "1" } });
  fake.addInstance("agent-forge", "agent-x", {
    status: opts.status ?? "Stopped",
    config: { "user.forge.repo": "o/x", ...(opts.mode ? { "user.forge.egress": opts.mode } : {}) },
    // Un container strict l'est aussi par sa NIC, pas seulement par son marqueur.
    devices: opts.mode === "strict" || opts.nic === "strict" ? { eth0: STRICT_NIC } : {},
  });
  return fake;
}

const MEMBER: Member = {
  name: "agent-x", team: "t", role: "dev", index: null, repo: "o/x", capabilities: ["repo", "publish"], talkTo: [],
  strict: false, memory: null, cpu: null, plugins: [], prompt: null,
};
const AGENT_RULES: ExecRule[] = [];
const lines = (c: ReturnType<typeof fakeContext>) => c.calls.map((x) => x.join(" "));
const started = (c: ReturnType<typeof fakeContext>, name: string) =>
  lines(c).findIndex((l) => l.endsWith(` start ${name}`));
const proxyPush = (l: string) => l.includes("file push") && l.includes("agent-forge-proxy.sh");
const agentRun = (l: string) => l.includes("-- hc run ");

test("ensureRunning refuses a strict container on an Incus below the gate, before any start", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "strict", version: "7.0.1" }) });
  await assert.rejects(() => ensureRunning(c, "agent-x"), /7\.0\.2/);
  assert.equal(started(c, "agent-x"), -1, lines(c).join("\n"));
});

test("ensureRunning checks the gate even on a running container", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "strict", status: "Running", version: "7.0.1" }) });
  await assert.rejects(() => ensureRunning(c, "agent-x"), /7\.0\.2/);
});

test("ensureRunning refuses a container whose marker and NIC disagree, naming forge egress", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "open", nic: "strict" }) });
  await assert.rejects(() => ensureRunning(c, "agent-x"), /refusing to start agent-x: .*eth0 is strict.*forge egress o\/x strict/);
  assert.equal(started(c, "agent-x"), -1, lines(c).join("\n"));
});

test("ensureRunning starts a strict container's stopped proxy first", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "strict", proxy: "Stopped" }) });
  await ensureRunning(c, "agent-x");
  const proxy = started(c, "forge-proxy");
  assert.ok(proxy >= 0 && proxy < started(c, "agent-x"), lines(c).join("\n"));
});

test("startSession applies the strict settings before running the agent", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "strict", status: "Running" }), rules: AGENT_RULES });
  await startSession(c, MEMBER, "cli", "x");
  const l = lines(c);
  const push = l.findIndex(proxyPush);
  assert.ok(push >= 0 && push < l.findIndex(agentRun), l.join("\n"));
});

test("startSession removes forge's proxy files from an open container before running the agent", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "open", status: "Running" }), rules: AGENT_RULES });
  await startSession(c, MEMBER, "cli", "x");
  const l = lines(c);
  const rm = l.findIndex((x) => x.includes("rm -f"));
  assert.ok(rm >= 0 && rm < l.findIndex(agentRun), l.join("\n"));
});

test("startSession leaves a container without an egress marker alone", async () => {
  const c = fakeContext({ incus: egressFake({ status: "Running" }), rules: AGENT_RULES });
  await startSession(c, MEMBER, "cli", "x");
  assert.ok(!lines(c).some((x) => proxyPush(x) || x.includes("rm -f")), lines(c).join("\n"));
  assert.ok(lines(c).some(agentRun));
});

test("startSession of a strict container below the gate runs no agent", async () => {
  const c = fakeContext({ incus: egressFake({ mode: "strict", status: "Running", version: "7.0.1" }), rules: AGENT_RULES });
  await assert.rejects(() => startSession(c, MEMBER, "cli", "x"), /7\.0\.2/);
  assert.ok(!lines(c).some(agentRun));
});
