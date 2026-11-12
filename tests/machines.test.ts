import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { machineName, syncMachines, viaCommand } from "../cli/lib/laptop/machines.ts";
import type { LaptopHost } from "../cli/lib/laptop/state.ts";

const host = { name: "forge-local" } as LaptopHost;
const via = (container: string) => viaCommand("forge-local", container);

test("machine names drop the agent- prefix of the container, after the host alias", () => {
  assert.equal(machineName("forge-local", "agent-web-dev-1"), "forge-local-web-dev-1");
});

test("syncMachines adds the missing, removes the ones of removed members, never another tool's or another host's", async () => {
  const listed = {
    machines: [
      { name: "forge-local-web-dev-1", target: via("agent-web-dev-1") },
      { name: "forge-local-web-dev-9", target: via("agent-web-dev-9") },
      { name: "other-x", target: "ssh other" },
      // Named like ours, but not reached by forge's transport for this alias.
      { name: "forge-local-mine", target: "ssh somewhere" },
      // Another alias that begins with this one's name.
      { name: "forge-local-2-web-lead", target: viaCommand("forge-local-2", "agent-web-lead") },
    ],
  };
  const ctx = fakeContext({ rules: [{ match: "hc machine ls --json", stdout: JSON.stringify(listed) }] });
  const out = await syncMachines(ctx, host, ["agent-web-lead", "agent-web-dev-1"]);
  assert.deepEqual(out, { added: ["forge-local-web-lead"], removed: ["forge-local-web-dev-9"] });
  const hc = ctx.calls.filter((c) => c[0] === "hc" && c[2] !== "ls");
  assert.deepEqual(hc, [
    ["hc", "machine", "rm", "forge-local-web-dev-9"],
    ["hc", "machine", "add", "--name", "forge-local-web-lead", "--via", via("agent-web-lead"), "--json"],
  ]);
  assert.ok(!ctx.calls.some((c) => c.includes("--install")));
});

test("a machine whose command is stale is replaced", async () => {
  const listed = { machines: [{ name: "forge-local-web-lead", target: "'/old/forge' hc-via forge-local agent-web-lead" }] };
  const ctx = fakeContext({ rules: [{ match: "hc machine ls --json", stdout: JSON.stringify(listed) }] });
  const out = await syncMachines(ctx, host, ["agent-web-lead"]);
  assert.deepEqual(out, { added: ["forge-local-web-lead"], removed: [] });
  assert.ok(ctx.calls.some((c) => c.join(" ").startsWith("hc machine rm forge-local-web-lead")));
});
