import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeContext } from "./lib/fake-context.ts";
import { provisionContainer } from "../scripts/lib/commands/provision.ts";

let home: string;

function setup() {
  home = mkdtempSync(join(tmpdir(), "forge-prov-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
  writeFileSync(join(home, ".ssh", "github_agents_signing"), "key");
  process.env.FORGE_HOME = home;
  process.env.FORGE_REPO_DIR = process.cwd();
  process.env.FORGE_WORKSPACES = join(home, "workspaces");
}

function teardown() {
  rmSync(home, { recursive: true, force: true });
  delete process.env.FORGE_HOME;
  delete process.env.FORGE_REPO_DIR;
  delete process.env.FORGE_WORKSPACES;
}

const IMAGE_OK = { match: "image info", code: 0 };

test("provisioning refuses without host Claude credentials", async () => {
  setup();
  rmSync(join(home, ".claude", ".credentials.json"));
  try {
    await assert.rejects(
      () => provisionContainer(fakeContext({ rules: [IMAGE_OK], answers: ["a"] }), "agent-x", "o/r"),
      /credentials.json not found/,
    );
  } finally { teardown(); }
});

test("provisioning refuses when agent-base is missing", async () => {
  setup();
  try {
    await assert.rejects(
      () => provisionContainer(fakeContext({ rules: [{ match: "image info", code: 1 }] }), "agent-x", "o/r"),
      /image agent-base not found/,
    );
  } finally { teardown(); }
});

test("autonomous mode reads the token without echoing and never puts it in argv", async () => {
  setup();
  try {
    const c = fakeContext({ rules: [IMAGE_OK], answers: ["a", "ghp_secret"] });
    await provisionContainer(c, "agent-x", "o/r");
    // Le token part sur stdin de `gh auth login`, jamais en argv : argv est
    // visible dans ps.
    assert.ok(!c.calls.some((call) => call.join(" ").includes("ghp_secret")));
    const loginIdx = c.calls.findIndex((call) => call.join(" ").includes("gh auth login"));
    assert.ok(loginIdx >= 0);
    // Et le token doit réellement partir sur stdin de cet appel précis, pas
    // seulement être absent d'argv : sans ceci, un régression qui cesserait
    // de passer { input: token } à ctx.exec passerait ce test.
    assert.equal(c.execOptions[loginIdx]?.input, "ghp_secret");
    assert.ok(c.calls.some((call) => call.join(" ").includes("git clone https://github.com/o/r.git")));
  } finally { teardown(); }
});

test("autonomous mode refuses an empty token", async () => {
  setup();
  try {
    await assert.rejects(
      () => provisionContainer(fakeContext({ rules: [IMAGE_OK], answers: ["a", null] }), "agent-x", "o/r"),
      /empty token/,
    );
  } finally { teardown(); }
});

test("the plugin marketplace is added over HTTPS, never over SSH", async () => {
  setup();
  try {
    const c = fakeContext({ rules: [IMAGE_OK], answers: ["s"] });
    await provisionContainer(c, "agent-x", "o/r");
    const add = c.calls.map((call) => call.join(" ")).find((l) => l.includes("plugin marketplace add"));
    assert.ok(add, "no marketplace add issued");
    // Le container n'a aucune confiance SSH envers GitHub, et c'est voulu :
    // en autonome il passe par HTTPS + PAT, en supervised il n'a aucune
    // credential. La forme raccourcie owner/repo est resolue en SSH par
    // claude, d'ou un echec de verification de cle hote.
    assert.ok(add.includes("https://github.com/anthropics/claude-plugins-official"),
      `marketplace add must use an explicit HTTPS URL, got: ${add}`);
    assert.ok(!add.includes("git@github.com"), `marketplace add must not use SSH, got: ${add}`);
    assert.ok(!/add anthropics\/claude-plugins-official/.test(add),
      `the owner/repo shorthand resolves to SSH, got: ${add}`);
  } finally { teardown(); }
});

test("supervised mode never asks for a token and clones on the host", async () => {
  setup();
  try {
    const c = fakeContext({ rules: [IMAGE_OK], answers: ["s"] });
    await provisionContainer(c, "agent-x", "o/r");
    assert.ok(!c.calls.some((call) => call.join(" ").includes("gh auth")));
    assert.ok(c.calls.some((call) => call.join(" ").includes("git@github.com:o/r.git")));
    assert.ok(c.err_lines.some((l) => l.includes("git remote add agent-x")));
  } finally { teardown(); }
});

test("forge metadata is recorded after the clone, not before", async () => {
  setup();
  try {
    const c = fakeContext({ rules: [IMAGE_OK], answers: ["s"] });
    await provisionContainer(c, "agent-x", "o/r");
    const flat = c.calls.map((call) => call.join(" "));
    const clone = flat.findIndex((l) => l.includes("git clone"));
    const meta = flat.findIndex((l) => l.includes("user.forge.repo"));
    assert.ok(clone >= 0 && meta > clone, "les métadonnées doivent suivre le clone");
  } finally { teardown(); }
});

test("git-lfs failure aborts provisioning", async () => {
  setup();
  try {
    const c = fakeContext({ rules: [IMAGE_OK, { match: "git lfs install", code: 1 }], answers: ["s"] });
    await assert.rejects(() => provisionContainer(c, "agent-x", "o/r"), /git-lfs setup failed/);
  } finally { teardown(); }
});

test("a failing clone aborts provisioning before metadata is recorded", async () => {
  setup();
  try {
    const c = fakeContext({
      rules: [IMAGE_OK, { match: "git clone git@github.com", code: 1, stderr: "Permission denied (publickey)" }],
      answers: ["s"],
    });
    await assert.rejects(() => provisionContainer(c, "agent-x", "o/r"), /clone/i);
    // Sans le fail-fast, l'exécution retombait sur git-lfs puis sur les
    // configSet forge.*, timbrant un container vide comme provisionné —
    // exactement l'état que checkNameCollision (Task 6) traite comme
    // réutilisable. C'est le filet de régression pour cette propriété.
    assert.ok(!c.calls.some((call) => call.join(" ").includes("user.forge.repo")));
    assert.ok(!c.calls.some((call) => call.join(" ").includes("git lfs install")));
  } finally { teardown(); }
});
