import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdHcVia } from "../cli/lib/commands/hc-via.ts";
import { cmdHcExec } from "../cli/lib/commands/hc-exec.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-hc-transport-"));
  mkdirSync(join(home, "agent-forge"), { recursive: true });
  writeFileSync(join(home, "agent-forge", "config.json"), JSON.stringify({
    teams: { web: { repo: "o/web", roles: { dev: { count: 1, capabilities: ["repo"] } } } },
  }));
  process.env.XDG_CONFIG_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

test("hc-via runs the host's hc-exec over ssh, the line as one quoted word, no agent, nothing asked", async () => {
  const ctx = fakeContext();
  const line = `sh -c 'hc serve; echo "$HOME"'`;
  await cmdHcVia(ctx, "forge-local", "agent-web-dev-1", line);
  assert.deepEqual(ctx.attachCalls[0].argv, [
    "ssh", "-T", "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "forge-local", "--",
    `'forge' 'hc-exec' 'agent-web-dev-1' '${line.replaceAll("'", "'\\''")}'`,
  ]);
});

test("hc-via refuses an alias that would be an ssh option, and a name that is not a container", () => {
  assert.throws(() => cmdHcVia(fakeContext(), "-oProxyCommand=x", "agent-web-dev-1", "hc"), /Usage/);
  assert.throws(() => cmdHcVia(fakeContext(), "forge-local", "agent-web-dev-1;id", "hc"), /container must be/);
});

test("hc-exec serves a declared container: su - aiuser -c <line>, non-interactive", async () => {
  const ctx = fakeContext();
  await cmdHcExec(ctx, "agent-web-dev-1", "hc get agent");
  assert.deepEqual(ctx.attachCalls[0].argv,
    ["incus", "--project", "agent-forge", "exec", "-T", "agent-web-dev-1", "--", "su", "-", "aiuser", "-c", "hc get agent"]);
});

test("hc-exec refuses an undeclared or malformed container before any incus call", async () => {
  for (const name of ["agent-o-r", "agent-web-dev-1;id", "agent-web-dev-9"]) {
    const ctx = fakeContext();
    await assert.rejects(() => cmdHcExec(ctx, name, "hc ls"));
    assert.deepEqual(ctx.calls, []);
    assert.deepEqual(ctx.attachCalls, []);
  }
});
