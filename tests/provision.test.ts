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
    await assert.rejects(() => provisionContainer(c, "agent-x", "o/r"), /git-lfs setup in agent-x failed/);
  } finally { teardown(); }
});

// Ce site d'appel avait été oublié par le passage à mustSucceed (c89dbf4) :
// l'opérateur recevait « git-lfs setup failed in <container>. » et rien
// d'autre, alors que la seule information utile — pourquoi git a refusé — est
// dans le stderr que ctx.exec capture. Sans elle, l'échec n'est pas
// diagnosticable depuis la sortie de `forge start`.
test("a git-lfs failure reports git's own message, not just the step name", async () => {
  setup();
  try {
    const c = fakeContext({
      rules: [IMAGE_OK, {
        match: "git lfs install",
        code: 1,
        stderr: "Hook already exists: pre-push\n",
      }],
      answers: ["s"],
    });
    await assert.rejects(() => provisionContainer(c, "agent-x", "o/r"), /Hook already exists: pre-push/);
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

// ~/workspaces/<container> survit à `forge delete` : le re-provisioning
// tombait sur `git clone` dans un répertoire non vide, APRÈS avoir créé le
// container et fait coller le PAT. Ces tests verrouillent les deux moitiés du
// fix : réutiliser le clone du bon repo, et trancher avant toute création.
function seedWorkspace(container: string, ...files: string[]) {
  const dir = join(home, "workspaces", container);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), "x");
  return dir;
}

const ORIGIN = (url: string) => ({ match: "remote get-url", stdout: `${url}\n` });

test("un workspace laissé par un container supprimé est réutilisé au lieu de casser le clone", async () => {
  setup();
  try {
    seedWorkspace("agent-x", "README.md");
    const c = fakeContext({ rules: [IMAGE_OK, ORIGIN("git@github.com:o/r.git")], answers: ["s"] });
    await provisionContainer(c, "agent-x", "o/r");
    const flat = c.calls.map((call) => call.join(" "));
    assert.ok(!flat.some((l) => l.includes("git clone")), "pas de clone par-dessus un clone existant");
    assert.ok(flat.some((l) => l.includes("remote set-url origin git@github.com:o/r.git")));
    assert.ok(flat.some((l) => l.includes("user.forge.repo")), "le provisioning doit aller au bout");
  } finally { teardown(); }
});

test("la réutilisation réaligne le remote sur le mode autonome (https, pas ssh)", async () => {
  setup();
  try {
    seedWorkspace("agent-x", "README.md");
    const c = fakeContext({ rules: [IMAGE_OK, ORIGIN("git@github.com:o/r.git")], answers: ["a", "ghp_secret"] });
    await provisionContainer(c, "agent-x", "o/r");
    const flat = c.calls.map((call) => call.join(" "));
    assert.ok(!flat.some((l) => l.includes("git clone")));
    assert.ok(flat.some((l) => l.includes("remote set-url origin https://github.com/o/r.git")));
    // Le container a toujours besoin de gh auth pour pousser, clone ou pas.
    assert.ok(flat.some((l) => l.includes("gh auth login")));
  } finally { teardown(); }
});

test("un workspace non vide appartenant à un autre repo arrête tout avant de créer le container", async () => {
  setup();
  try {
    seedWorkspace("agent-x", "README.md");
    const c = fakeContext({ rules: [IMAGE_OK, ORIGIN("git@github.com:someone/else.git")], answers: ["s"] });
    await assert.rejects(() => provisionContainer(c, "agent-x", "o/r"), /not a clone of o\/r/);
    assert.ok(!c.calls.some((call) => call.join(" ").includes("lxc launch")), "rien ne doit être créé");
  } finally { teardown(); }
});

test("un workspace non vide qui n'est pas un dépôt git arrête tout avant de créer le container", async () => {
  setup();
  try {
    seedWorkspace("agent-x", "notes.txt");
    const c = fakeContext({ rules: [IMAGE_OK, { match: "remote get-url", code: 128 }], answers: ["s"] });
    await assert.rejects(() => provisionContainer(c, "agent-x", "o/r"), /not a clone of o\/r/);
    assert.ok(!c.calls.some((call) => call.join(" ").includes("lxc launch")));
  } finally { teardown(); }
});

test("le pré-vol ne demande même pas le mode quand le workspace est inutilisable", async () => {
  setup();
  try {
    seedWorkspace("agent-x", "notes.txt");
    const c = fakeContext({ rules: [IMAGE_OK, { match: "remote get-url", code: 128 }], answers: ["s"] });
    await assert.rejects(() => provisionContainer(c, "agent-x", "o/r"));
    assert.ok(!c.err_lines.some((l) => l.startsWith("Choice")), "pas de question posée pour rien");
  } finally { teardown(); }
});

test("un répertoire workspace vide se clone normalement", async () => {
  setup();
  try {
    seedWorkspace("agent-x");
    const c = fakeContext({ rules: [IMAGE_OK], answers: ["s"] });
    await provisionContainer(c, "agent-x", "o/r");
    assert.ok(c.calls.some((call) => call.join(" ").includes("git clone git@github.com:o/r.git")));
  } finally { teardown(); }
});

test("super mode launches agent-base-super under agent-super and inits nested LXD", async () => {
  setup();
  try {
    const c = fakeContext({ rules: [IMAGE_OK], answers: ["u", "ghp_secret"] });
    await provisionContainer(c, "agent-x", "o/r");
    const flat = c.calls.map((call) => call.join(" "));
    assert.ok(flat.some((l) => l.includes("lxc launch agent-base-super agent-x --profile agent-super")));
    assert.ok(flat.some((l) => l.includes("lxd init --minimal")), "nested LXD initialised");
    // super garde le flux autonome : credential + clone https
    assert.ok(flat.some((l) => l.includes("gh auth login")));
    assert.ok(flat.some((l) => l.includes("git clone https://github.com/o/r.git")));
    assert.ok(c.calls.some((call) => call.join(" ").includes("user.forge.mode super")));
  } finally { teardown(); }
});

test("super mode stamps the agent-base-super image commit", async () => {
  setup();
  try {
    const c = fakeContext({
      rules: [IMAGE_OK, { match: "image get-property agent-base-super", stdout: "SUPERSHA\n" }],
      answers: ["u", "ghp_secret"],
    });
    await provisionContainer(c, "agent-x", "o/r");
    assert.ok(c.calls.some((call) => call.join(" ").includes("user.forge.image_commit SUPERSHA")));
  } finally { teardown(); }
});

test("super mode refuses when agent-base-super is missing", async () => {
  setup();
  try {
    const c = fakeContext({ rules: [{ match: "image info agent-base-super", code: 1 }], answers: ["u"] });
    await assert.rejects(() => provisionContainer(c, "agent-x", "o/r"), /image agent-base-super not found/);
  } finally { teardown(); }
});
