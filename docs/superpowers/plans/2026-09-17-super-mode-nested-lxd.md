# Super Mode (Nested LXD) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third container mode, `super`, that embeds a nested LXD so an agent can self-host agent-forge (run `forge`/`lxc`/real integration tests) from inside its container.

**Architecture:** `super` reuses the autonomous provisioning path verbatim (PAT, `gh auth`, HTTPS clone, PR flow) and adds exactly two things: it launches from a dedicated `agent-base-super` image under a less-hardened `agent-super` LXD profile, and it runs `lxd init --minimal` inside the container after launch. Everywhere else in the CLI, `super` behaves like `autonomous`.

**Tech Stack:** TypeScript run directly by Node 24 (no build step), bash for the image build and security hook, LXD 5.21, `node:test` for unit/contract/integration tests.

## Global Constraints

- **Git discipline unchanged for super.** `.claude/hooks/pre-bash.sh` is not modified: push only to `origin agent/*`, PR flow, `gh` subcommands bridled. The "super" is LXD capability, not git freedom.
- **Mode letters:** `[a]` autonomous, `[s]` supervised, `[u]` super (default stays autonomous).
- **The `agent-super` profile = `agent` minus three capability drops only:** it must NOT drop `sys_ptrace`, `mac_override`, `mac_admin`. Everything else identical, in particular `security.privileged: "false"` and `security.syscalls.deny_default: "true"` stay.
- **Base images per mode:** `agent-base-super` for super, `agent-base` for autonomous/supervised.
- **Bash strict mode** (`set -e`), quote all variables, in every shell script.
- **Never touch `main`** — work commits on the `agent/super-mode` branch. Interactive session: do not push without asking.
- Tests run via `npm test` (`test:unit` = `node --test tests/*.test.ts`, `test:contract`, `test:bash` = every `tests/test-*.sh`). Type-check with `npm run check` (`tsc --noEmit`).

---

### Task 1: `agent-super` LXD profile

**Files:**
- Create: `config/lxd-agent-super-profile.yaml`
- Test: `tests/test-lxd-agent-super-profile.sh`

**Interfaces:**
- Produces: a profile file whose `raw.lxc` keeps `sys_ptrace`, `mac_override`, `mac_admin`. Consumed by Task 4 (build container) and Task 5 (super container launch) as the profile name `agent-super`.

- [ ] **Step 1: Write the failing structural test**

Create `tests/test-lxd-agent-super-profile.sh`:

```bash
#!/bin/bash
# Tests structurels de config/lxd-agent-super-profile.yaml : profil du mode
# super, identique à agent SAUF qu'il restaure trois capabilities requises par
# le LXD imbriqué (snapd/snap-confine). Voir
# docs/superpowers/specs/2026-09-17-super-mode-nested-lxd-design.md.
# Lancer : bash tests/test-lxd-agent-super-profile.sh
set -e

FILE="$(cd "$(dirname "$0")/.." && pwd)/config/lxd-agent-super-profile.yaml"
PASS=0
FAIL=0

assert_contains() {
  if grep -qF -- "$1" "$FILE"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL (attendu présent): $1"; fi
}
assert_not_contains() {
  if grep -qF -- "$1" "$FILE"; then FAIL=$((FAIL + 1)); echo "FAIL (attendu absent): $1"; else PASS=$((PASS + 1)); fi
}

# Durcissement conservé
assert_contains 'security.privileged: "false"'
assert_contains 'security.nesting: "true"'
assert_contains 'security.syscalls.deny_default: "true"'

# Les trois capabilities que super doit GARDER (le LXD imbriqué en dépend) :
# elles ne doivent apparaître dans AUCUNE ligne de drop.
assert_not_contains 'lxc.cap.drop = sys_module sys_rawio sys_boot sys_ptrace sys_pacct'
assert_not_contains 'mac_override mac_admin'
# La forme attendue de la première ligne de drop, ptrace retiré
assert_contains 'lxc.cap.drop = sys_module sys_rawio sys_boot sys_pacct'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/test-lxd-agent-super-profile.sh`
Expected: FAIL — the profile file does not exist yet (`grep` errors / assertions fail).

- [ ] **Step 3: Create the profile file**

Create `config/lxd-agent-super-profile.yaml` — a copy of `config/lxd-agent-profile.yaml` with two edits in `raw.lxc` (first drop line loses `sys_ptrace`; the `mac_override mac_admin` line is removed) and an explanatory header comment:

```yaml
name: agent-super
description: Agent profile (super mode — nested LXD)
config:
  environment.HOME: /home/aiuser
  limits.cpu: "8"
  limits.memory: 12GB
  # Mode super : identique au profil `agent` SAUF que trois capabilities
  # retirées par `agent` sont ici conservées, parce que le LXD imbriqué en a
  # besoin (prouvé par le spike du 2026-09-17, voir la spec) :
  #   - mac_admin + mac_override : snapd (snap-confine) charge/empile des
  #     profils AppArmor imbriqués ; sans elles → "apparmor_parser: Access
  #     denied. You need policy admin privileges to manage profiles".
  #   - sys_ptrace : exigée explicitement par snap-confine ("required
  #     permitted capability cap_sys_ptrace not found").
  # Ces caps restent namespacées au container (unprivileged + userns) :
  # security.privileged reste "false" et deny_default reste "true".
  security.privileged: "false"
  security.nesting: "true"
  security.syscalls.deny_default: "true"
  raw.idmap: |
    uid 1000 1001
    gid 1000 1001
  # sys_ptrace, mac_override et mac_admin NE SONT PAS droppés ici (cf. commentaire ci-dessus).
  raw.lxc: |
    lxc.cap.drop = sys_module sys_rawio sys_boot sys_pacct
    lxc.cap.drop = net_broadcast
    lxc.cap.drop = bpf perfmon
    lxc.cap.drop = audit_control audit_read
    lxc.cap.drop = wake_alarm block_suspend
    lxc.cap.drop = linux_immutable lease ipc_lock ipc_owner
    lxc.cap.drop = syslog
devices:
  eth0:
    name: eth0
    network: lxdbr0
    type: nic
  root:
    path: /
    pool: default
    size: 100GB
    type: disk
project: default
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash tests/test-lxd-agent-super-profile.sh`
Expected: `PASS=6 FAIL=0`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add config/lxd-agent-super-profile.yaml tests/test-lxd-agent-super-profile.sh
git commit -m "feat: agent-super LXD profile (keeps caps nested LXD needs)"
```

---

### Task 2: Per-mode base image helpers (`containers.ts`)

**Files:**
- Modify: `scripts/lib/containers.ts`
- Test: `tests/containers.test.ts`

**Interfaces:**
- Consumes: `imageProperty` (already imported from `./lxd.ts`).
- Produces:
  - `baseImageFor(mode: string): string` → `"agent-base-super"` when `mode === "super"`, else `"agent-base"`.
  - `latestImageCommitFor(ctx: Context, mode: string): Promise<string>` → the `user.forge.commit` property of that base image.
  - `currentImageCommit(ctx)` stays as-is for now (removed in Task 5).

- [ ] **Step 1: Write the failing tests**

Append to `tests/containers.test.ts`:

```ts
import { baseImageFor, latestImageCommitFor } from "../scripts/lib/containers.ts";

test("baseImageFor maps super to agent-base-super, everything else to agent-base", () => {
  assert.equal(baseImageFor("super"), "agent-base-super");
  assert.equal(baseImageFor("autonomous"), "agent-base");
  assert.equal(baseImageFor("supervised"), "agent-base");
  assert.equal(baseImageFor(""), "agent-base");
});

test("latestImageCommitFor reads the commit of the mode's base image", async () => {
  const ctx = fakeContext({
    rules: [
      { match: "image get-property agent-base-super", stdout: "SUPERSHA\n" },
      { match: "image get-property agent-base", stdout: "BASESHA\n" },
    ],
  });
  assert.equal(await latestImageCommitFor(ctx, "super"), "SUPERSHA");
  assert.equal(await latestImageCommitFor(ctx, "autonomous"), "BASESHA");
});
```

Note: the `agent-base-super` rule is listed FIRST because `fakeContext` matches by substring and `"image get-property agent-base"` is a substring of the super query — first match wins.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/containers.test.ts`
Expected: FAIL — `baseImageFor`/`latestImageCommitFor` are not exported.

- [ ] **Step 3: Add the helpers**

In `scripts/lib/containers.ts`, add after `currentImageCommit` (around line 83):

```ts
// L'image de base dépend du mode : super embarque un LXD imbriqué, livré par
// une image dédiée agent-base-super (voir la spec super mode). Autonomous et
// supervised partagent agent-base.
export function baseImageFor(mode: string): string {
  return mode === "super" ? "agent-base-super" : "agent-base";
}

export function latestImageCommitFor(ctx: Context, mode: string): Promise<string> {
  return imageProperty(ctx, baseImageFor(mode), "user.forge.commit");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/containers.test.ts` → all pass.
Run: `npm run check` → no type errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/containers.ts tests/containers.test.ts
git commit -m "feat: baseImageFor/latestImageCommitFor — per-mode base image"
```

---

### Task 3: `forge list` BUILD column per mode (`list.ts`)

**Files:**
- Modify: `scripts/lib/commands/list.ts`
- Test: `tests/list.test.ts`

**Interfaces:**
- Consumes: `latestImageCommitFor` (Task 2), `containerMode`, `buildStatus` (existing).

- [ ] **Step 1: Write the failing test**

Append to `tests/list.test.ts` (mirror the existing helper style in that file — reuse its container list / mode / config-get rules). Add a super container whose image commit is compared against `agent-base-super`:

```ts
test("forge list compares a super container against agent-base-super", async () => {
  const LIST = JSON.stringify([{ name: "agent-o-r", status: "Running" }]);
  const ctx = fakeContext({
    rules: [
      { match: "lxc list", stdout: LIST },
      // super listé en premier : "image get-property agent-base" est un
      // sous-chaîne de la requête agent-base-super (première règle gagne).
      { match: "image get-property agent-base-super", stdout: "SUPERSHA" },
      { match: "image get-property agent-base", stdout: "BASESHA" },
      { match: "agent-o-r user.forge.repo", stdout: "o/r" },
      { match: "agent-o-r user.forge.mode", stdout: "super" },
      { match: "agent-o-r user.forge.image_commit", stdout: "SUPERSHA" },
      { match: "sessions", stdout: "" },
    ],
  });
  await cmdList(ctx);
  const row = ctx.out_lines.find((l) => l.includes("o/r"));
  assert.ok(row, "super container row present");
  assert.ok(row.includes("super"), "MODE column shows super");
  assert.ok(row.includes("ok"), "BUILD is ok when stamp matches agent-base-super");
});
```

(If the existing tests set up `taskNames`/`sessionStates` rules differently, follow that file's established pattern; the key assertions are the three: mode shown, and BUILD `ok` because the stamp matches the *super* image commit, not `agent-base`.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/list.test.ts`
Expected: FAIL — today `list.ts` compares every container against `agent-base` (`currentImageCommit`), so a super stamp of `SUPERSHA` vs `BASESHA` reads `behind`, not `ok`.

- [ ] **Step 3: Update `list.ts`**

Replace the import of `currentImageCommit` and the single `latest` with per-mode lookups. Change the import block (lines 9-12) to import `latestImageCommitFor` instead of `currentImageCommit`:

```ts
import {
  buildStatus, containerImageCommit, containerMode, containerRepo,
  latestImageCommitFor, forgeContainerNames,
} from "../containers.ts";
```

Replace line 26 (`const latest = await currentImageCommit(ctx);`) with the two distinct base commits computed once:

```ts
  // Deux images de base seulement : agent-base (autonomous/supervised) et
  // agent-base-super (super). On lit chaque commit une fois, puis on choisit
  // par mode dans la boucle — pas de requête image par container.
  const latestByBase = new Map<string, string>([
    ["agent-base", await latestImageCommitFor(ctx, "autonomous")],
    ["agent-base-super", await latestImageCommitFor(ctx, "super")],
  ]);
```

Inside the loop, after `const mode = await containerMode(ctx, name);`, compute the right latest. Replace the `buildLabel(buildStatus(stamp, latest))` cell with:

```ts
    const latest = latestByBase.get(mode === "super" ? "agent-base-super" : "agent-base") ?? "";
```

and use `buildLabel(buildStatus(stamp, latest))` in the `cells` array as before.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/list.test.ts` → all pass (new + existing).
Run: `npm run check` → clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/commands/list.ts tests/list.test.ts
git commit -m "feat: forge list compares super containers against agent-base-super"
```

---

### Task 4: `forge image build super` (dispatch + image command + build script)

**Files:**
- Modify: `scripts/forge.ts:42`
- Modify: `scripts/lib/commands/image.ts`
- Modify: `scripts/lib/forge-image.sh`
- Test: `tests/image.test.ts` (create), `tests/test-forge-image-super.sh` (create)

**Interfaces:**
- Consumes: `ctx.attach` (existing).
- Produces: an `agent-base-super` LXD image alias stamped with `user.forge.commit`. `cmdImage(ctx, sub, target?)` gains an optional third arg.

- [ ] **Step 1: Write the failing unit test for the image command**

Create `tests/image.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { cmdImage } from "../scripts/lib/commands/image.ts";

test("forge image build passes only the sub to the bash script", async () => {
  const ctx = fakeContext();
  await cmdImage(ctx, "build");
  const call = ctx.calls[0];
  assert.equal(call[0], "bash");
  assert.equal(call.at(-1), "build");
});

test("forge image build super passes build + super to the bash script", async () => {
  const ctx = fakeContext();
  await cmdImage(ctx, "build", "super");
  const call = ctx.calls[0];
  assert.equal(call.at(-2), "build");
  assert.equal(call.at(-1), "super");
});

test("forge image build with an unknown target is rejected", async () => {
  await assert.rejects(() => cmdImage(fakeContext(), "build", "nope"), /Usage: forge image/);
});

test("forge image with an unknown sub is rejected", async () => {
  await assert.rejects(() => cmdImage(fakeContext(), "bogus"), /Usage: forge image/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/image.test.ts`
Expected: FAIL — `cmdImage` takes no third arg and does not validate a target.

- [ ] **Step 3: Update `image.ts` and the dispatcher**

In `scripts/lib/commands/image.ts`, replace the body:

```ts
export async function cmdImage(ctx: Context, sub: string | undefined, target?: string): Promise<number> {
  if (sub !== "build" && sub !== "update") {
    throw new ForgeError("Usage: forge image build|update [super]");
  }
  if (target !== undefined && target !== "super") {
    throw new ForgeError("Usage: forge image build|update [super]");
  }
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "forge-image.sh");
  // attach, pas exec : le build est long et sa sortie doit défiler en direct.
  const scriptArgs = target ? [sub, target] : [sub];
  return ctx.attach(["bash", script, ...scriptArgs]);
}
```

In `scripts/forge.ts:42`, pass the third positional:

```ts
    case "image": return cmdImage(ctx, a, b);
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `node --test tests/image.test.ts` → all pass.
Run: `npm run check` → clean.

- [ ] **Step 5: Write the failing structural test for the build script**

Create `tests/test-forge-image-super.sh`:

```bash
#!/bin/bash
# Vérifie que forge-image.sh sait construire agent-base-super : profil correct,
# snapd démarré + seedé, snap LXD installé, aiuser dans le groupe lxd, image
# publiée et tamponnée. Lancer : bash tests/test-forge-image-super.sh
set -e

FILE="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/forge-image.sh"
PASS=0
FAIL=0
assert_contains() {
  if grep -qF -- "$1" "$FILE"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL (attendu présent): $1"; fi
}

assert_contains '_forge_image_build_super'
assert_contains 'agent-super-setup'
assert_contains '--profile agent-super'
assert_contains 'snap wait system seed.loaded'
assert_contains 'snap install lxd'
assert_contains 'usermod -aG lxd aiuser'
assert_contains '--alias agent-base-super'
assert_contains 'lxc image set-property agent-base-super user.forge.commit'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 6: Run to verify it fails**

Run: `bash tests/test-forge-image-super.sh`
Expected: FAIL — none of the super build strings exist in `forge-image.sh` yet.

- [ ] **Step 7: Implement the super build in `forge-image.sh`**

Replace `cmd_forge_image()` (lines 14-24) so `build|update` dispatches on a second argument:

```bash
cmd_forge_image() {
  case "${1:-}" in
    build|update)
      case "${2:-}" in
        "") _forge_image_build ;;
        super) _forge_image_build_super ;;
        *) echo "Usage: forge image build|update [super]" >&2; return 1 ;;
      esac
      ;;
    *)
      echo "Usage: forge image build|update [super]" >&2
      return 1
      ;;
  esac
}
```

Add `_forge_image_build_super()` after `_forge_image_build()` (after line 114):

```bash
_forge_image_build_super() {
  local setup="agent-super-setup"

  # agent-base-super se construit EN COUCHE par-dessus agent-base : on le bâtit
  # d'abord s'il manque, plutôt que d'échouer.
  if ! lxc image info agent-base > /dev/null 2>&1; then
    echo "agent-base image missing; building it first..."
    _forge_image_build
  fi

  if lxc info "$setup" > /dev/null 2>&1; then
    echo "Removing leftover $setup container from a previous failed build..."
    lxc delete "$setup" --force
  fi

  echo "Launching scratch container $setup from agent-base (profile agent-super)..."
  # Le profil agent-super garde mac_admin/mac_override/sys_ptrace : sans elles,
  # snap-confine ne peut pas charger ses profils AppArmor et `snap install lxd`
  # échoue (prouvé par le spike du 2026-09-17).
  lxc launch agent-base "$setup" --profile agent-super

  # snapd est présent dans agent-base mais ni démarré ni seedé : on le démarre
  # et on attend le seed avant d'installer le snap LXD.
  echo "Starting snapd and installing nested LXD..."
  lxc exec "$setup" -- systemctl start snapd.socket snapd.service
  lxc exec "$setup" -- snap wait system seed.loaded
  lxc exec "$setup" -- snap install lxd
  # aiuser pilote le socket LXD interne sans sudo.
  lxc exec "$setup" -- usermod -aG lxd aiuser

  lxc stop "$setup"
  lxc image delete agent-base-super 2>/dev/null || true
  lxc publish "$setup" --alias agent-base-super
  lxc delete "$setup"

  # Même tampon que agent-base : `forge list` compare le container à ce commit.
  local build_commit
  build_commit=$(git -C "$FORGE_REPO_DIR" rev-parse HEAD)
  lxc image set-property agent-base-super user.forge.commit "$build_commit"

  echo "Image agent-base-super published (build $build_commit)."
}
```

- [ ] **Step 8: Run the structural test and type-check**

Run: `bash tests/test-forge-image-super.sh` → `PASS=8 FAIL=0`.
Run: `npm run check` → clean.
Run (syntax only, does not execute the build): `bash -n scripts/lib/forge-image.sh` → no output, exit 0.

- [ ] **Step 9: Commit**

```bash
git add scripts/forge.ts scripts/lib/commands/image.ts scripts/lib/forge-image.sh tests/image.test.ts tests/test-forge-image-super.sh
git commit -m "feat: forge image build super — layered agent-base-super with nested LXD"
```

---

### Task 5: Provision super containers (`provision.ts`)

**Files:**
- Modify: `scripts/lib/commands/provision.ts`
- Modify: `scripts/lib/containers.ts` (remove now-unused `currentImageCommit`)
- Test: `tests/provision.test.ts`

**Interfaces:**
- Consumes: `baseImageFor`, `latestImageCommitFor` (Task 2).
- Produces: super containers launched from `agent-base-super`/`agent-super`, with a nested `lxd init`, stamped with the super image commit and `user.forge.mode = super`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/provision.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/provision.test.ts`
Expected: FAIL — super is parsed as autonomous today, so it launches `agent-base`/`agent`, never inits LXD, and stamps `agent-base`'s commit.

- [ ] **Step 3: Add the mode helper and third prompt option**

In `scripts/lib/commands/provision.ts`, update the imports (line 10):

```ts
import { baseImageFor, latestImageCommitFor } from "../containers.ts";
```

Replace the mode prompt block (lines 28-32) with a three-way choice and a helper:

```ts
  ctx.err("Mode for this container?");
  ctx.err("  [a] autonomous — bot pushes commits and opens PRs itself");
  ctx.err("  [s] supervised — no credential; you retrieve and publish the work yourself");
  ctx.err("  [u] super — autonomous + nested LXD (self-host agent-forge: run forge/lxc/integration tests)");
  const choice = (await ctx.prompt.ask("Choice [a/s/u]")) ?? "a";
  const mode = modeFromChoice(choice);
```

Add near the bottom of the file (next to `remoteRepo`):

```ts
// a/s/u -> autonomous/supervised/super. Défaut autonomous.
function modeFromChoice(choice: string): string {
  const c = choice.trim().toLowerCase();
  if (c.startsWith("s")) return "supervised";
  if (c.startsWith("u")) return "super";
  return "autonomous";
}
```

- [ ] **Step 4: Move the image check to be mode-aware, and launch the right image/profile**

Delete the early image check (lines 21-23, the `agent-base not found` block). After the mode is computed (right before `ctx.out(\`Creating container...\`)`), insert a mode-aware check and compute the launch inputs:

```ts
  const baseImage = baseImageFor(mode);
  if ((await ctx.exec(["lxc", "image", "info", baseImage])).code !== 0) {
    const target = mode === "super" ? "forge image build super" : "forge image build";
    throw new ForgeError(`image ${baseImage} not found. Run '${target}' first.`);
  }
  const profile = mode === "super" ? "agent-super" : "agent";
```

Replace the launch line (old line 35):

```ts
  ctx.out(`Creating container ${container}...`);
  await mustSucceed("lxc launch", ctx.exec(["lxc", "launch", baseImage, container, "--profile", profile]));
```

- [ ] **Step 5: Initialise the nested LXD for super, right after the cloud-init cleanup**

Immediately after the `remove cloud-init sudoers file` block (old line 44), insert:

```ts
  // Super mode : initialise le LXD imbriqué. snapd + le snap LXD sont déjà
  // dans l'image (forge image build super) ; on attend le seed puis on
  // initialise un pool `dir` + un bridge internes, une fois par container.
  if (mode === "super") {
    ctx.out("Initializing the nested LXD daemon...");
    await mustSucceed("wait nested snapd seed",
      ctx.exec(["lxc", "exec", container, "--", "snap", "wait", "system", "seed.loaded"]));
    await mustSucceed("nested lxd init",
      ctx.exec(["lxc", "exec", container, "--", "/snap/bin/lxd", "init", "--minimal"]));
  }
```

- [ ] **Step 6: Stamp the super image commit**

Replace the stamp call (old line 157-158) to use the mode's base image:

```ts
  ctx.out("Stamping the image build this container came from...");
  await mustSucceed("stamp image commit",
    configSet(ctx, container, "user.forge.image_commit", await latestImageCommitFor(ctx, mode)));
```

- [ ] **Step 7: Remove the now-unused `currentImageCommit`**

Confirm nothing references it, then delete it from `scripts/lib/containers.ts` (the function at lines 81-83):

Run: `grep -rn "currentImageCommit" scripts tests`
Expected: no matches after removing the definition (Task 3 switched `list.ts`; this task switched `provision.ts`). Delete the function.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test tests/provision.test.ts` → all pass (new + existing: the autonomous/supervised tests still launch `agent-base`/`agent` because their `IMAGE_OK` rule matches `image info agent-base`, and the moved check runs after the mode prompt).
Run: `npm run check` → clean.

- [ ] **Step 9: Commit**

```bash
git add scripts/lib/commands/provision.ts scripts/lib/containers.ts tests/provision.test.ts
git commit -m "feat: provision super containers (nested LXD, super image/profile)"
```

---

### Task 6: Documentation — both CLAUDE.md files, README, USAGE

**Files:**
- Modify: `templates/CLAUDE.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `scripts/forge.ts` (USAGE text, line ~24)
- Test: `tests/test-readme-docs.sh`

**Interfaces:** documentation only — no code interfaces produced.

- [ ] **Step 1: Add super-mode assertions to the README docs test (failing first)**

In `tests/test-readme-docs.sh`, add before the summary block (after line 54):

```bash
assert_contains 'forge image build super'
assert_contains 'agent-super'
assert_contains 'nested LXD'
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash tests/test-readme-docs.sh`
Expected: FAIL — README does not yet mention super mode.

- [ ] **Step 3: Document super mode in `README.md`**

Add a "Super mode" subsection under Usage (after the "Supervised mode" section, near line 392) and mention `forge image build super` in the image section (near line 115). The subsection must contain the strings the test asserts. Suggested content:

```markdown
### Super mode

For self-hosting agent-forge itself: a super container is an **autonomous
container plus a nested LXD**, so an agent can run `forge`, `lxc`, and the real
integration tests (`FORGE_INTEGRATION=1 npm run test:integration`) against a
live LXD fully isolated from the host's. Git discipline is identical to
autonomous mode (push `agent/*`, open a PR, human merges).

Setup (once), in order — the profile must exist before the image, because the
build container itself needs its capabilities:

```bash
lxc profile create agent-super
lxc profile edit agent-super   # paste config/lxd-agent-super-profile.yaml
./scripts/forge image build super
```

`agent-super` is `agent` with three capabilities restored
(`mac_admin`, `mac_override`, `sys_ptrace`) that the nested LXD's snapd needs;
`security.privileged` stays `false` and the seccomp blocklist stays on. The
nested LXD (`agent-base-super` image) cannot see the host's LXD — the agent's
`lxc` only drives its own nested daemon.

Pick super at `forge start` (the `[u]` choice). Everything else — PAT prompt,
`gh auth`, HTTPS clone, PR flow — is the autonomous path.
```

In the image section, add a line noting `forge image build super` builds the
layered `agent-base-super` image (base + nested LXD).

- [ ] **Step 4: Run the README test to verify it passes**

Run: `bash tests/test-readme-docs.sh` → `FAIL=0`.

- [ ] **Step 5: Add the super-mode block to `templates/CLAUDE.md`**

Insert a section after the `## Docker` block (after line 32):

```markdown
## Super mode (LXD imbriqué)
- Si `/home/aiuser/.claude/forge-mode` contient `super`, ce container embarque un **LXD imbriqué** : tu peux lancer `forge`, `lxc`, et surtout les tests d'intégration réels (`FORGE_INTEGRATION=1 npm run test:integration`) contre un vrai LXD, isolé de l'hôte.
- Le `lxc` de ce container ne pilote **que** le LXD imbriqué — il ne voit jamais le LXD de l'hôte.
- La discipline git ne change pas : mode `super` = mode `autonomous` côté publication. Pousse `agent/<task>` et ouvre une PR (jamais de merge toi-même). Relis la section Git ci-dessus.
```

- [ ] **Step 6: Explain super mode in the repo `CLAUDE.md`**

Add to `/home/<user>/agent-forge/CLAUDE.md`, in the Conventions/Git area (after the autonomous-mode paragraph), a short block:

```markdown
### Mode super (self-hosting)
`super` est un troisième mode container (à côté d'`autonomous`/`supervised`),
sélectionnable au `forge start` via `[u]`. Il embarque un LXD imbriqué pour
développer agent-forge depuis un container : `forge`, `lxc`, et les tests
d'intégration réels tournent contre un LXD interne isolé de l'hôte. Côté git,
`super` se comporte exactement comme `autonomous` (push `agent/*`, flux PR,
jamais de merge par l'agent). Il s'appuie sur l'image `agent-base-super`
(`forge image build super`) et le profil `agent-super`, qui restaure
volontairement trois capabilities (`mac_admin`, `mac_override`, `sys_ptrace`)
dont le LXD imbriqué a besoin — `security.privileged` reste `false`. Voir
`docs/superpowers/specs/2026-09-17-super-mode-nested-lxd-design.md`.
```

- [ ] **Step 7: Update the CLI USAGE text**

In `scripts/forge.ts` (line ~24), change the image usage line to mention super:

```ts
  image build|update [super]        Rebuild agent-base (or, with super, agent-base-super = base + nested LXD)
```

- [ ] **Step 8: Run the full suite and type-check**

Run: `npm test` → all unit, contract, and bash tests pass.
Run: `npm run check` → clean.

- [ ] **Step 9: Commit**

```bash
git add templates/CLAUDE.md CLAUDE.md README.md scripts/forge.ts tests/test-readme-docs.sh
git commit -m "docs: document super mode (README, both CLAUDE.md, USAGE)"
```

---

### Task 7: Opt-in integration test reproducing the spike

**Files:**
- Create: `tests/integration/super-lxd.test.ts`

**Interfaces:** consumes the real `lxc` and the `agent-base-super` image / `agent-super` profile. Skips cleanly when integration is disabled or when the super image/profile are absent.

- [ ] **Step 1: Write the integration test**

Create `tests/integration/super-lxd.test.ts`. It launches a real super container, initialises the nested LXD, launches a nested container, asserts it runs, then tears everything down. It skips (never fails) when `FORGE_INTEGRATION` is unset or when `agent-base-super`/`agent-super` don't exist on the host yet:

```ts
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
```

- [ ] **Step 2: Verify it skips cleanly with integration disabled**

Run: `node --test tests/integration/super-lxd.test.ts`
Expected: the suite is skipped (no host LXD required), exit 0.
Run: `npm run check` → clean.

- [ ] **Step 3: (On a real LXD host, after Tasks 1 & 4 are applied) run it for real**

Prerequisites: `lxc profile create agent-super` + paste the profile, then
`./scripts/forge image build super`. Then:

Run: `FORGE_INTEGRATION=1 npm run test:integration`
Expected: the nested-container test passes (mirrors the manual spike); the container is deleted in `after()`.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/super-lxd.test.ts
git commit -m "test: opt-in integration test for nested LXD in super mode"
```

---

## Self-Review

**Spec coverage:**
- Third generic mode `super` → Tasks 5 (prompt/launch), 3/2 (CLI awareness). ✓
- Autonomous git discipline kept, `pre-bash.sh` untouched → no task modifies the hook; asserted implicitly (super reuses autonomous path). ✓
- Dedicated `agent-base-super` image, layered, explicit `forge image build super` → Task 4. ✓
- `agent-super` profile = agent minus three cap drops → Task 1. ✓
- Nested `lxd init --minimal` at provisioning; snapd start + seed → Tasks 4 (build) & 5 (provision). ✓
- Versioning per mode (`baseImageFor`, `forge list` BUILD) → Tasks 2 & 3. ✓
- `wip.ts` unchanged (super falls through to autonomous) → no task needed; behaviour preserved (super has a credential). ✓
- Docs: both CLAUDE.md, README, USAGE → Task 6. ✓
- Tests: unit, bash, opt-in integration → Tasks 1-7. ✓

**Placeholder scan:** none — every step has concrete code/commands and expected output.

**Type consistency:** `baseImageFor(mode: string): string` and `latestImageCommitFor(ctx, mode): Promise<string>` are defined in Task 2 and consumed with those exact names/signatures in Tasks 3 and 5. `cmdImage(ctx, sub, target?)` defined in Task 4 matches the `cmdImage(ctx, a, b)` dispatch call. `modeFromChoice` is local to `provision.ts`. Mode string values (`"super"`, `"autonomous"`, `"supervised"`) are used consistently.
