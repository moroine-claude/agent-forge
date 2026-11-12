import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, parseConfig } from "../cli/lib/config.ts";

const PATH = "/home/u/.config/agent-forge/config.json";
const parse = (raw: unknown) => parseConfig(PATH, raw);

// Every config error starts with the file, then names the key.
function rejects(raw: unknown, pattern: RegExp) {
  assert.throws(() => parse(raw), (e: Error) => {
    assert.ok(e.message.startsWith(`${PATH}: `), e.message);
    assert.match(e.message, pattern);
    return true;
  });
}

const web = (roles: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ teams: { web: { repo: "o/web", roles, ...extra } } });

test("no team and no pilot by default", () => {
  assert.deepEqual(DEFAULT_CONFIG.teams, {});
  assert.equal(DEFAULT_CONFIG.pilot, null);
  assert.deepEqual(parse({}).teams, {});
});

test("a team parses, and its optional fields default", () => {
  const cfg = parse({
    pilot: { capabilities: ["assign"], talkTo: ["web"] },
    teams: {
      web: {
        repo: "o/web",
        roles: {
          lead: { capabilities: ["repo", "assign"], talkTo: ["dev", "team"] },
          dev: { count: 3, memory: "8GiB", capabilities: ["repo", "publish"], talkTo: ["lead"] },
        },
      },
    },
  });
  assert.deepEqual(cfg.teams.web.roles.lead,
    { count: null, capabilities: ["repo", "assign"], talkTo: ["dev", "team"], strict: false, memory: null, cpu: null, plugins: [] });
  assert.equal(cfg.teams.web.roles.dev.count, 3);
  assert.equal(cfg.teams.web.roles.dev.memory, "8GiB");
  assert.equal(cfg.teams.web.prompts, null);
  assert.equal(cfg.teams.web.gitIdentity, null);
  assert.deepEqual(cfg.pilot, { capabilities: ["assign"], talkTo: ["web"], strict: false, memory: null, plugins: [], prompt: null });
});

test("a team is refused when a field is wrong", () => {
  rejects(web({ dev: { capabilities: ["push"] } }), /teams\.web\.roles\.dev\.capabilities/);
  rejects(web({ dev: { count: 0 } }), /teams\.web\.roles\.dev\.count/);
  rejects(web({ Dev: {} }), /teams\.web\.roles\.Dev/);
  rejects({ teams: { Web: { repo: "o/web", roles: {} } } }, /teams\.Web/);
  rejects({ teams: { web: { repo: "web", roles: {} } } }, /teams\.web\.repo/);
  rejects(web({ dev: { colour: "red" } }), /unknown key teams\.web\.roles\.dev\.colour/);
  rejects(web({ dev: { talkTo: ["qa"] } }), /teams\.web\.roles\.dev\.talkTo/);
  rejects(web({ dev: { memory: "lots" } }), /teams\.web\.roles\.dev\.memory/);
  rejects(web({ dev: { plugins: ["a b"] } }), /teams\.web\.roles\.dev\.plugins/);
});

test("the pilot talks to teams only", () => {
  rejects({ pilot: { talkTo: ["nobody"] }, teams: {} }, /pilot\.talkTo/);
  rejects({ pilot: { capabilities: ["push"] } }, /pilot\.capabilities/);
});
