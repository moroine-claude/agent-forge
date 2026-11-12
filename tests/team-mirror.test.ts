import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { assertNoHostGitIn } from "./lib/host-git.ts";
import { parseConfig } from "../cli/lib/config.ts";
import { workspacesDir } from "../cli/lib/paths.ts";
import { refreshTeamMirror } from "../cli/lib/team-mirror.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "forge-team-mirror-"));
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
  process.env.FORGE_MIRRORS = join(home, "mirrors");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.FORGE_WORKSPACES;
  delete process.env.FORGE_MIRRORS;
});

const cfg = parseConfig("/c.json", {
  teams: {
    web: {
      repo: "o/web",
      roles: {
        dev: { count: 2, capabilities: ["repo", "publish"] },
        reviewer: { capabilities: ["repo", "read-team"] },
      },
    },
  },
});

test("each developer's fetch carries exactly the refspecs of the tasks it owns", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-web-dev-1", { status: "Running", config: { "user.forge.base.fix-login": "origin/main" } });
  fake.addInstance("agent-forge", "agent-web-dev-2", { status: "Running", config: { "user.forge.base.export-csv": "origin/main" } });
  fake.addInstance("agent-forge", "agent-web-reviewer", { status: "Running", config: { "user.forge.base.nope": "origin/main" } });
  const ctx = fakeContext({ incus: fake });
  const out = await refreshTeamMirror(ctx, cfg, "web");
  assert.deepEqual(out, { fetched: ["agent-web-dev-1", "agent-web-dev-2"], failed: [] });
  const fetches = ctx.calls.filter((c) => c[0] === "git" && c.includes("fetch"));
  assert.equal(fetches.length, 2);
  const refspecs = (argv: string[]) => argv.slice(argv.indexOf("src") + 1);
  assert.deepEqual(refspecs(fetches[0]), ["+refs/heads/agent/fix-login:refs/heads/agent/fix-login"]);
  assert.deepEqual(refspecs(fetches[1]), ["+refs/heads/agent/export-csv:refs/heads/agent/export-csv"]);
  assert.ok(fetches[0].includes("core.hooksPath=/dev/null"));
  assert.ok(fetches[0].some((a) => a.startsWith("remote.src.uploadpack=FORGE_SIDE=host ") && a.endsWith(" upload-pack agent-web-dev-1")));
  assertNoHostGitIn(ctx.calls, workspacesDir());
});

test("a member whose fetch fails is reported and the others still run", async () => {
  const fake = FakeIncus.withRuntime();
  fake.addInstance("agent-forge", "agent-web-dev-1", { status: "Running", config: { "user.forge.base.a": "origin/main" } });
  fake.addInstance("agent-forge", "agent-web-dev-2", { status: "Running", config: { "user.forge.base.b": "origin/main" } });
  const ctx = fakeContext({ incus: fake, rules: [{ match: "upload-pack agent-web-dev-1", code: 128 }] });
  const out = await refreshTeamMirror(ctx, cfg, "web");
  assert.deepEqual(out, { fetched: ["agent-web-dev-2"], failed: ["agent-web-dev-1"] });
});
