import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { AGENT } from "../cli/lib/agent.ts";
import { ensureRunning } from "../cli/lib/session.ts";

const P = ["incus", "--project", "agent-forge"];
const list = (status: string) => JSON.stringify([{ name: "agent-x", status }]);

test("AGENT.marker is the forge-task flag", () => {
  assert.equal(AGENT.marker("agent-x", "cli"), "--forge-task agent-x-cli");
});

test("ensureRunning starts a stopped container", async () => {
  const c = fakeContext({ rules: [{ match: "list", stdout: list("Stopped") }] });
  await ensureRunning(c, "agent-x");
  assert.ok(c.calls.some((call) => call.join(" ") === `${P.join(" ")} start agent-x`));
});

test("ensureRunning does nothing for a running container", async () => {
  const c = fakeContext({ rules: [{ match: "list", stdout: list("Running") }] });
  await ensureRunning(c, "agent-x");
  assert.ok(!c.calls.some((call) => call.includes("start")));
});

// A concurrent `incus start` can fail while the container is in fact running.
// The first two answers go to the egress check every ensureRunning begins
// with: no user.forge.egress, then the instance list.
function sequenceContext(answers: { code: number; stdout: string; stderr: string }[]) {
  const egress = [{ code: 0, stdout: "\n", stderr: "" }, { code: 0, stdout: list("Stopped"), stderr: "" }];
  const all = [...egress, ...answers];
  let n = 0;
  return { ...fakeContext(), exec: async () => all[Math.min(n++, all.length - 1)] };
}

test("ensureRunning tolerates a failed start when the container ends up Running", async () => {
  const ctx = sequenceContext([
    { code: 0, stdout: list("Stopped"), stderr: "" },
    { code: 1, stdout: "", stderr: "already starting" },
    { code: 0, stdout: list("Running"), stderr: "" },
  ]);
  await ensureRunning(ctx, "agent-x");
});

test("ensureRunning throws when the start fails and the container stays stopped", async () => {
  const ctx = sequenceContext([
    { code: 0, stdout: list("Stopped"), stderr: "" },
    { code: 1, stdout: "", stderr: "boom" },
    { code: 0, stdout: list("Stopped"), stderr: "" },
  ]);
  await assert.rejects(ensureRunning(ctx, "agent-x"), /incus start failed: boom/);
});
