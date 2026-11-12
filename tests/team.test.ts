import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../cli/lib/config.ts";
import { members, memberNamed, PILOT } from "../cli/lib/team.ts";

const cfg = (teams: Record<string, unknown>, pilot: unknown = { talkTo: ["web"] }) =>
  parseConfig("/c.json", {
    pilot,
    teams,
  });

const WEB = {
  web: {
    repo: "o/web",
    prompts: "/p",
    roles: {
      lead: { capabilities: ["repo", "assign"], talkTo: ["pilot", "team"] },
      dev: { count: 2, capabilities: ["repo", "publish"], talkTo: ["lead"] },
      reviewer: { capabilities: ["repo", "read-team"] },
    },
  },
};

test("members: the pilot first, then the team's roles, one container per count", () => {
  assert.deepEqual(members(cfg(WEB)).map((m) => m.name),
    [PILOT, "agent-web-lead", "agent-web-dev-1", "agent-web-dev-2", "agent-web-reviewer"]);
});

test("talkTo resolves to container names", () => {
  const byName = Object.fromEntries(members(cfg(WEB)).map((m) => [m.name, m]));
  assert.deepEqual(byName["agent-web-lead"].talkTo,
    ["agent-pilot", "agent-web-dev-1", "agent-web-dev-2", "agent-web-reviewer"]);
  assert.deepEqual(byName["agent-web-dev-1"].talkTo, ["agent-web-lead"]);
  assert.deepEqual(byName[PILOT].talkTo, ["agent-web-lead"]);
});

test("repo only for members with the repo capability, prompt from the team's directory", () => {
  const byName = Object.fromEntries(members(cfg(WEB)).map((m) => [m.name, m]));
  assert.equal(byName["agent-web-dev-1"].repo, "o/web");
  assert.equal(byName[PILOT].repo, null);
  assert.equal(byName["agent-web-dev-1"].prompt, "/p/dev.md");
  assert.equal(byName[PILOT].prompt, null);
});

test("a name over 63 characters is refused, naming the member", () => {
  const long = "a".repeat(50);
  assert.throws(() => members(cfg({ [long]: { repo: "o/x", roles: { developer: {} } } }, null)),
    /agent-a{50}-developer/);
});

test("memberNamed lists the declared names when the name is unknown", () => {
  assert.throws(() => memberNamed(cfg(WEB), "agent-web-dev-9"), /agent-web-dev-9.*agent-pilot, agent-web-lead/);
  assert.equal(memberNamed(cfg(WEB), "agent-web-dev-2").index, 2);
});
