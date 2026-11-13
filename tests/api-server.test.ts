import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { FakeIncus } from "./lib/fake-incus.ts";
import { parseConfig } from "../cli/lib/config.ts";
import { Journal } from "../cli/lib/api/journal.ts";
import { REQUEST_MAX } from "../cli/lib/api/protocol.ts";
import { hostSocketPath, serveApi } from "../cli/lib/api/server.ts";

const cfg = parseConfig("/c.json", {
  teams: {
    web: {
      repo: "o/web",
      roles: {
        lead: { capabilities: ["repo", "assign", "ask-human"], talkTo: ["team"] },
        dev: { count: 2, capabilities: ["repo", "publish"], talkTo: ["lead"] },
        reviewer: { capabilities: ["repo"], talkTo: ["lead"] },
      },
    },
  },
  pilot: { capabilities: ["assign"], talkTo: ["web"] },
});
const NAMES = ["agent-pilot", "agent-web-lead", "agent-web-dev-1", "agent-web-dev-2", "agent-web-reviewer"];

let root: string;
let stop: AbortController;
let served: Promise<void>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-api-"));
  process.env.FORGE_API_RUNTIME = join(root, "run");
  const fake = FakeIncus.withRuntime();
  for (const n of NAMES) fake.addInstance("agent-forge", n, { status: "Running" });
  stop = new AbortController();
  served = serveApi({
    ctx: fakeContext({ incus: fake }), cfg, journal: Journal.open(join(root, "journal.jsonl")),
    secrets: [], now: () => new Date(),
  }, stop.signal);
  // Les sockets existent quand la dernière écoute est posée.
  for (let i = 0; i < 100 && !existsSync(hostSocketPath(NAMES.at(-1)!)); i++) await new Promise((r) => setTimeout(r, 10));
});
afterEach(async () => {
  stop.abort();
  await served;
  rmSync(root, { recursive: true, force: true });
  delete process.env.FORGE_API_RUNTIME;
});

// Envoie `payload`, lit jusqu'à la fermeture.
function talk(container: string, payload: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(hostSocketPath(container));
    let out = "";
    s.setEncoding("utf8");
    s.on("data", (c) => (out += c));
    s.on("close", () => resolve(out));
    s.on("error", (e) => (/EPIPE|ECONNRESET/.test(String(e)) ? undefined : reject(e)));
    s.write(payload);
  });
}

test("each member that needs the API has a private socket in a private directory", () => {
  for (const n of NAMES) assert.equal(statSync(hostSocketPath(n)).mode & 0o777, 0o600, n);
  assert.equal(statSync(process.env.FORGE_API_RUNTIME!).mode & 0o777, 0o700);
});

test("the caller is the socket's member: the same line gets each member's own answer", async () => {
  const rows = async (c: string) => (JSON.parse(await talk(c, '{"op":"status"}\n')) as { team: { name: string }[] }).team.map((r) => r.name);
  assert.deepEqual(await rows("agent-web-dev-1"), ["agent-web-lead"]);
  assert.deepEqual(await rows("agent-web-lead"), ["agent-web-dev-1", "agent-web-dev-2", "agent-web-reviewer"]);
});

test("a line that never ends is refused at the cap, and the connection closes", async () => {
  const out = await talk("agent-web-dev-1", Buffer.alloc(REQUEST_MAX + 1, 0x61));
  assert.equal(out, '{"ok":false,"error":"request too long"}\n');
});

test("a socket path over the Unix limit is refused", () => {
  process.env.FORGE_API_RUNTIME = "/run/user/1000/" + "d".repeat(35);
  assert.throws(() => hostSocketPath("agent-" + "x".repeat(56)), /longer than 107 bytes/);
});

test("aborting closes every listener and removes the socket files", async () => {
  const paths = NAMES.map(hostSocketPath);
  stop.abort();
  await served;
  assert.ok(paths.every((p) => !existsSync(p)));
});
