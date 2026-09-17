# Super Mode: Nested LXD for Self-Hosting agent-forge — Design

**Date:** 2026-09-17
**Status:** Approved pending user review

## Context

Developing agent-forge itself inside an agent container is currently
impossible. The project's real test surface needs a live LXD — the
integration layer (`FORGE_INTEGRATION=1 npm run test:integration`) launches
and deletes throwaway containers, and `forge`/`lxc` only mean anything against
a running LXD daemon. A normal agent container has none of this: it is an
unprivileged LXD guest with no nested LXD, so an agent working on agent-forge
from inside a container can edit and unit-test the TypeScript, but can never
exercise the half of the codebase that talks to LXD.

The goal is a **third container mode, `super`**, that embeds a *nested* LXD
inside the agent container — its own daemon, its own storage pool and bridge,
fully isolated from the host's LXD — so an agent can run `forge`, `lxc`, and
the real integration tests entirely self-hosted.

`super` is a generic mode selectable at `forge start` like `autonomous` and
`supervised`; it is not hard-wired to the agent-forge repo. It carries the
**same git discipline as autonomous mode** (the "super" is about LXD
capability, not about loosening git). `pre-bash.sh` is unchanged: pushes only
to `origin agent/*`, PR flow, `gh` subcommands bridled. A human still reviews
and merges every PR.

## Feasibility spike (2026-09-17)

Before committing to the design, LXD-in-LXD was proven by hand on the host
against the real `agent-base` image. Results, which drive the decisions below:

- **It works, unprivileged throughout.** A container launched from
  `agent-base` ran a nested `lxd init --minimal` (dir storage pool + internal
  `lxdbr0`) and launched a nested `ubuntu:24.04` container that executed
  commands. `security.privileged` stayed `false` the whole time.
- **The hardened `agent` profile blocks it, for two capability reasons found
  in sequence:**
  - snapd (`snap-confine`) cannot load/stack the nested AppArmor profiles it
    needs — fails with `apparmor_parser: ... Access denied. You need policy
    admin privileges to manage profiles`. Cause: `agent` drops `mac_admin`
    and `mac_override`.
  - `snap-confine` then fails with `required permitted capability
    cap_sys_ptrace not found`. Cause: `agent` drops `sys_ptrace`.
  Restoring exactly those three capabilities (`mac_admin`, `mac_override`,
  `sys_ptrace`) — and nothing else — made the full chain succeed.
- **What did *not* need relaxing** (kept for security): `security.privileged`
  stays `false`, `security.syscalls.deny_default` stays `true`, `raw.idmap`
  and every other capability drop are untouched.
- **snapd is present but neither started nor seeded in `agent-base`.** The
  super build/provision must `systemctl start snapd.socket snapd.service` and
  `snap wait system seed.loaded` before `snap install lxd`.
- **Egress works** through the existing UFW rules — the nested LXD reached the
  public image servers to pull `ubuntu:24.04`.

## Decisions

| Decision | Choice |
|---|---|
| Shape | `super` is a third `mode` value alongside `autonomous`/`supervised` (brainstorm "Approach A"). Provisioning reuses the autonomous credential/git path verbatim and only adds: super image + super profile at launch, and a nested `lxd init` afterward. No separate provisioning routine, no boolean flag. |
| Gating | Generic mode, selectable for any repo at `forge start`. Not hard-wired to agent-forge. |
| Git discipline | Identical to autonomous. `pre-bash.sh` unchanged. Push `agent/*` only, PR flow, human merges. The "super" is LXD capability, not git freedom. |
| Nested LXD delivery | Dedicated image `agent-base-super` = `agent-base` + LXD, built layered via an explicit `forge image build super`. Plain `forge image build` still builds only `agent-base`. |
| LXD profile | New `agent-super` profile, required and distinct — `agent` minus the `mac_admin`/`mac_override`/`sys_ptrace` capability drops. Everything else identical (`security.privileged: false`, `security.syscalls.deny_default: true`, `raw.idmap`, all other drops). This is the deliberate, documented security cost of self-hosting. |
| Nested storage | `dir` backend via `lxd init --minimal` (no block device, matches the spike). |
| Init timing | LXD *binaries* + seeded snapd baked into the image; per-instance `lxd init --minimal` run at provisioning time. |

## What stays identical

`pre-bash.sh` (all git/gh/docker rules), the autonomous credential machinery
(PAT prompt, `gh auth`, HTTPS clone, PR flow), `wip.ts`'s supervised special
case, the worktree/tmux/session model, and every capability the `agent`
profile keeps. `super` behaves like `autonomous` everywhere except the two
LXD-specific additions.

## Design

### 1. LXD profile (`config/lxd-agent-super-profile.yaml`)

New file, a copy of `config/lxd-agent-profile.yaml` whose `raw.lxc` no longer
drops `sys_ptrace`, `mac_override`, `mac_admin`. The first `lxc.cap.drop` line
becomes:

```
lxc.cap.drop = sys_module sys_rawio sys_boot sys_pacct
```

(`sys_ptrace` removed), and the `mac_override mac_admin` drop line is deleted.
A header comment explains *why* these three caps return — AppArmor stacking
for nested snapd/LXD, plus `snap-confine`'s explicit `cap_sys_ptrace`
requirement — and that they are namespaced to the container. Setup is manual,
like the `agent` profile: `lxc profile create agent-super` then
`lxc profile edit agent-super`.

**Ordering dependency:** this profile must exist *before* building the super
image, because the build container itself needs these caps to run
`snap install lxd`.

### 2. Super image build (`scripts/lib/forge-image.sh`, `forge image build super`)

New explicit target, layered on `agent-base`:

1. Ensure `agent-base` exists (build it first if missing).
2. Delete any leftover `agent-super-setup` from a failed run.
3. `lxc launch agent-base agent-super-setup --profile agent-super`.
4. Start snapd and wait for seed:
   `systemctl start snapd.socket snapd.service` then
   `snap wait system seed.loaded`.
5. `snap install lxd`.
6. Add `aiuser` to the `lxd` group (drive the internal socket without sudo).
7. Publish alias `agent-base-super`; stamp it with the build commit
   (`lxc image set-property agent-base-super user.forge.commit <sha>`), same as
   `agent-base`.
8. Delete the scratch container.

Re-runnable: the leftover-cleanup in step 2 makes a retried build safe.

### 3. Provisioning (`scripts/lib/commands/provision.ts`, Approach A)

- **Mode prompt** gains a third choice. To avoid colliding with supervised's
  `s`, super uses a distinct letter (`u`): `[a]` autonomous / `[s]` supervised
  / `[u]` super. Default stays autonomous.
- **Image existence check** (currently `agent-base`, `provision.ts:21`): when
  super, check `agent-base-super` and point the error at
  `forge image build super`.
- **Launch** (currently `lxc launch agent-base <container> --profile agent`,
  `provision.ts:35`): when super, `lxc launch agent-base-super <container>
  --profile agent-super`.
- **Nested LXD init:** after launch, wait for the internal LXD daemon to be
  ready, then `lxc exec <container> -- lxd init --minimal` (as root).
- **Everything else = the autonomous path, unchanged:** mode marker (`super`
  in `~/.claude/forge-mode` and `user.forge.mode`), PAT prompt, `gh auth`,
  HTTPS clone, PR flow.

### 4. CLI touchpoints

- **Image versioning** (`scripts/lib/containers.ts`): `latestImageCommit` /
  `currentImageCommit` currently hard-code `agent-base` (`containers.ts:82`).
  Introduce a `baseImageFor(mode)` helper returning `agent-base-super` for
  super, `agent-base` otherwise, so `forge list`'s `BUILD` column compares each
  container against the image it actually came from.
- **`wip.ts`**: no change. The `supervised` special case stays; `super` falls
  through to autonomous behavior (has a credential, pushes `agent/*`, fetches).
- **`resolve` / `completion` / `list`**: `super` is one more mode value;
  `list` prints it in the `MODE` column. Mechanical changes only.

### 5. Security & `pre-bash.sh`

`pre-bash.sh` is **unchanged** — same git/gh/docker guards. It does not
restrict `lxc`, which is acceptable because the container's `lxc` drives
**only** the nested LXD (no host socket is ever mounted in). The containment
argument mirrors the existing Docker rationale: a breakout from a
nested-of-nested container lands back at `aiuser` level in the super
container, no new privilege gained.

The honest security delta, to be stated plainly in docs: a super container
runs with three more capabilities than a hardened `agent` container
(`mac_admin`, `mac_override`, `sys_ptrace`). These are namespaced to the
container (unprivileged + userns; `security.privileged` stays `false`,
`security.syscalls.deny_default` stays `true`). `mac_admin` lets the container
manage AppArmor profiles *within its own AppArmor namespace* — the price of
letting nested snapd/LXD confine its own children. This is why `super` is a
distinct profile and mode, never a default.

### 6. Documentation

Three files:

1. **`templates/CLAUDE.md`** (read by the agent *inside* the container): add a
   "super mode context" block — a nested LXD is available, you may run
   `forge` / `lxc` / `FORGE_INTEGRATION=1 npm run test:integration` against a
   real, isolated LXD; the internal `lxc` cannot see the host; **git discipline
   is unchanged** (push `agent/*`, open a PR).
2. **`CLAUDE.md`** (repo root, project instructions): explain super mode for
   any future session working on agent-forge — the third mode, what it's for,
   the `agent-super` profile, and that self-hosting deliberately restores three
   capabilities.
3. **`README.md`**: document super mode, `forge image build super`, the
   `agent-super` profile setup (profile-before-image ordering), and the
   self-hosting workflow.

### 7. Testing

- **Unit:** mode parsing includes `super`; provisioning selects the super
  image/profile; `baseImageFor` maps mode → base image; `forge list` `BUILD`
  comparison per mode; `list` renders `super`.
- **Bash:** `pre-bash.sh` still allows `lxc`, still blocks the same git/gh
  patterns.
- **Integration (opt-in, real LXD):** reproduce the spike — provision a super
  container, `lxd init --minimal`, launch a nested container, assert it runs —
  inside the dedicated `forge-selftest` LXD project, matching the existing
  integration layer.

## Out of scope

- Auto-rebuild of `agent-base-super` (same manual-rebuild posture as
  `agent-base`).
- Bumping the `agent-super` root disk above the profile's inherited 100GB —
  revisit only if nested images run it out of space.
- Any change to how `autonomous`/`supervised` containers work.
