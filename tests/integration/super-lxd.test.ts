// Couche 3 (opt-in) : reproduit le spike du 2026-09-17 — LXD-dans-LXD sur un
// vrai hôte. Skippe proprement si l'intégration est désactivée ou si l'image
// agent-base-super / le profil agent-super n'existent pas encore.
//   FORGE_INTEGRATION=1 npm run test:integration
import { test, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const ENABLED = process.env.FORGE_INTEGRATION === "1";
let container = "";
let ready = false;

function lxc(args: string[]) {
  return spawnSync("lxc", args, { encoding: "utf8" });
}
function raw(label: string, r: { status: number | null; stdout: string; stderr: string }) {
  return `${label}\n  exit=${r.status}\n  stdout=${JSON.stringify(r.stdout)}\n  stderr=${JSON.stringify(r.stderr)}`;
}

before((t) => {
  if (!ENABLED) return (t as TestContext).skip("set FORGE_INTEGRATION=1 to run against a real LXD host");
  const haveImage = lxc(["image", "info", "agent-base-super"]).status === 0;
  const haveProfile = lxc(["profile", "show", "agent-super"]).status === 0;
  if (!haveImage || !haveProfile) {
    return (t as TestContext).skip("build agent-base-super and create the agent-super profile first");
  }
  container = `superspike-selftest-${Math.random().toString(36).slice(2, 8)}`;
  const launched = lxc(["launch", "agent-base-super", container, "--profile", "agent-super"]);
  assert.equal(launched.status, 0, raw("launch agent-base-super failed", launched));
  // Attendre que le LXD imbriqué soit prêt, puis l'initialiser.
  const seed = lxc(["exec", container, "--", "snap", "wait", "system", "seed.loaded"]);
  assert.equal(seed.status, 0, raw("nested snapd never seeded", seed));
  const init = lxc(["exec", container, "--", "/snap/bin/lxd", "init", "--minimal"]);
  assert.equal(init.status, 0, raw("nested lxd init failed", init));
  ready = true;
});

after(() => {
  if (container) lxc(["delete", container, "--force"]);
});

test("a nested container launches and runs inside a super container", { skip: !ENABLED }, () => {
  if (!ready) return; // before() skipped (image/profile absent)
  const launch = lxc(["exec", container, "--", "/snap/bin/lxc", "launch", "ubuntu:24.04", "nested1"]);
  assert.equal(launch.status, 0, raw("nested launch failed", launch));
  const hello = lxc(["exec", container, "--", "/snap/bin/lxc", "exec", "nested1", "--",
    "sh", "-c", "echo HELLO_NESTED"]);
  assert.equal(hello.status, 0, raw("exec inside nested container failed", hello));
  assert.match(hello.stdout, /HELLO_NESTED/, raw("nested container did not run", hello));
});
