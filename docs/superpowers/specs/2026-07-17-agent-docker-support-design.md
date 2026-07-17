# Docker/Compose Support for Agent Containers — Design

**Date:** 2026-07-17
**Status:** Approved pending user review
**Sub-project:** 1 of 2 in the "more agent features" round (the second being
Chrome/browser access, brainstormed separately).

## Context

Agents currently can't run backing services their target repos depend on —
no MongoDB, Postgres, Redis, etc. — whether for integration tests or for
running the app itself to verify a change end-to-end. The LXD profile
(`config/lxd-agent-profile.yaml`) currently sets `security.nesting: "false"`,
which rules out running Docker (or any nested container runtime) inside the
agent container at all.

The goal is general Docker/Compose capability — not a curated Mongo-only
integration — so agents can `docker compose up` whatever a given repo
already ships, the same way a human developer would.

## Decisions

| Decision | Choice |
|---|---|
| Scope | On by default for every agent container (not opt-in per container) — same posture as Chrome, part of the base image and profile. |
| Nesting | `security.nesting: "true"` in the shared `agent` LXD profile. `security.privileged` stays `"false"`; this is the LXD-documented safe pattern for running Docker inside a container (unprivileged + nesting, not privileged + nesting). The existing `raw.lxc` capability drops (`sys_ptrace`, `mac_admin`, `bpf`, `sys_module`, etc.) and `security.syscalls.deny_default: "true"` are untouched — nesting only relaxes the specific syscalls nested namespaces need (`mount`, `unshare`, `setns`, `pivot_root`), it doesn't re-grant anything explicitly dropped. |
| Docker mode | **Rootless**, not rootful. A rootless daemon runs entirely as `aiuser` with no privileged daemon and no `docker` group ambient authority. This matters specifically because `aiuser` has no sudo and no root today: rootful Docker would hand the agent a new root-inside-the-container ceiling; rootless keeps the ceiling at `aiuser` even in a worst-case container-escape (runc/containerd bug), identical to what the agent already has via its normal Bash tool. No new privilege level is created. |
| Disk | Root disk bumped from `20GB` to `100GB` in the profile. Sized against the operator's 1TB host disk with up to ~6 concurrent containers (100GB × 6 = 600GB ceiling, leaving headroom for the host OS and other containers). LXD's storage pool is thin-provisioned, so this is a ceiling, not reserved-upfront space. |
| Guardrails | New `pre-bash.sh` blocks, same regex/default-allow pattern as the existing `sudo`/`rm -rf`/git-push rules, applied identically in both `autonomous` and `supervised` mode (unrelated to git credentials): block `--privileged`, block `--pid=host`/`--network=host` (blurs the Docker-sandbox/outer-container boundary), block bind-mounts of paths outside `/workspace`. These are defense-in-depth on top of the namespace containment nesting already provides, not the primary boundary — same framing as the hook's existing comments. |
| Networking | No changes needed. Docker's internal bridge lives entirely inside the container's own network namespace, invisible to host UFW rules (which filter `lxdbr0`) — image pulls go out through the container's existing internet-allowed egress, and Docker-internal traffic (agent process ↔ Mongo container) never touches the host network stack at all. |
| Service curation | None — general `docker`/`docker compose` capability, not a pre-wired Mongo integration. Repos bring their own `docker-compose.yml`. |

## What stays identical

Everything else in the LXD profile (`raw.idmap`, all `raw.lxc` capability
drops, `security.syscalls.deny_default`), all existing `pre-bash.sh` rules
(git push/merge/rebase policy, `sudo`, `rm -rf`, `core.hooksPath` tampering,
curl/wget upload whitelist), and the autonomous/supervised mode machinery.
None of this is touched by this design.

## Design

### 1. LXD profile (`config/lxd-agent-profile.yaml`)

```yaml
security.nesting: "true"     # was "false"
devices:
  root:
    size: 100GB               # was 20GB
```

Existing containers need `lxc profile edit agent` re-applied plus a restart
(nesting takes effect on container start) to pick up the profile change —
but since Docker itself only exists in the rebuilt `agent-base` image,
existing containers practically need to be recreated anyway, same as any
other base-image change (Chrome, `gh`).

### 2. `agent-base` image build (`scripts/lib/forge-image.sh`)

Added after the existing `gh`/Chrome install steps, before the `aiuser`
creation step (so root-level setup like subuid ranges and linger happen
cleanly):

- `apt install -y uidmap` (`newuidmap`/`newgidmap`, required by rootless Docker)
- Official rootless install: `curl -fsSL https://get.docker.com/rootless | sh` run as `aiuser` (or `dockerd-rootless-setuptool.sh install` after a normal `get-docker.sh` package install — exact invocation confirmed during implementation), plus the `docker-compose-plugin` package
- Configure `aiuser`'s subuid/subgid ranges (`usermod --add-subuids`/`--add-subgids`, or confirm the install script's defaults are sane)
- `loginctl enable-linger aiuser` — keeps the rootless daemon alive across tmux detach/reattach and SSH sessions ending, without requiring an active login session
- `systemctl --user enable --now docker` (as `aiuser`) — daemon starts automatically, no manual step needed before the agent's first `docker` command
- Add `DOCKER_HOST=unix:///run/user/1001/docker.sock` and the rootless Docker `PATH` entries to `aiuser`'s `.bashrc`

### 3. `pre-bash.sh` guardrails

New block, alongside the existing `sudo`/`rm -rf` rules, unconditional (no
`FORGE_MODE` branching — this isn't a credential concern):

```bash
# Bloquer docker run --privileged (échappe au confinement du conteneur imbriqué)
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])docker([[:space:]]+[a-z-]+)*[[:space:]]+run([[:space:]].*)?[[:space:]]--privileged([[:space:]]|$)'; then
  block "docker run --privileged non autorisé."
fi

# Bloquer --pid=host / --network=host (brouille la frontière conteneur Docker / conteneur agent)
if echo "$COMMAND" | grep -qE '(--pid(=|[[:space:]]+)host|--network(=|[[:space:]]+)host)'; then
  block "docker --pid=host / --network=host non autorisé."
fi

# Bloquer les bind-mounts hors /workspace
if echo "$COMMAND" | grep -qE '(-v|--volume|--mount)[[:space:]=]+[^[:space:]]*:?/(etc|home|root|var|usr|boot|proc|sys)([:[:space:]]|$)' \
   || echo "$COMMAND" | grep -qE '(-v|--volume)[[:space:]=]+/:[^[:space:]]*'; then
  block "Bind-mount Docker hors /workspace non autorisé."
fi
```

(Exact regexes to be hardened against real-world flag ordering/edge cases
during implementation and testing — the intent above is normative, the
patterns are a starting point.)

### 4. `templates/CLAUDE.md`

New short section under the existing environment/scope description: Docker
and Compose are available (rootless), and `--privileged`,
`--pid=host`/`--network=host`, and bind-mounts outside `/workspace` are
blocked — so compose files should use named volumes or `/workspace`-relative
bind mounts.

### 5. README

Update §5 (image build) to mention Docker/Compose alongside Chrome/`gh` in
the list of what `forge image build` installs, and note the profile's
`security.nesting`/disk-size changes in the profile-creation step.

## Verification checklist

1. Rebuild `agent-base`, update the `agent` profile, recreate a test
   container: `docker run hello-world` succeeds as `aiuser`, no sudo used
   anywhere in the chain.
2. `docker compose up -d` with a small MongoDB compose file; a Node/Python
   script inside the container connects to `localhost:27017` successfully.
3. Detach tmux (`Ctrl+b d`), reattach via `forge start`: the Mongo container
   from step 2 is still running (confirms `loginctl enable-linger` +
   `systemctl --user enable` work as intended).
4. `docker run --privileged ...`, `docker run --pid=host ...`, and
   `docker run -v /:/host ...` are each blocked by `pre-bash.sh`; a plain
   `docker run`, `docker compose up`, and a bind-mount under `/workspace`
   are all allowed.
5. `tests/test-pre-bash.sh` gains cases for all four guardrail checks above
   (3 blocked forms + non-blocked forms) and passes.
6. Confirm `raw.lxc` capability drops are unaffected: `capsh --print` (or
   equivalent) inside the container still shows `sys_ptrace`, `mac_admin`,
   `bpf`, etc. as absent from the effective set, post-nesting.

## Out of scope

- **Opt-in per container** — rejected; Docker is on for every container by
  default, same posture as Chrome.
- **Rootful Docker** — rejected in favor of rootless, specifically to avoid
  creating a new root-inside-container privilege ceiling for `aiuser`.
- **Curated service images (Mongo-only helper, `forge db start`, etc.)** —
  rejected; general Docker/Compose capability covers this and more without
  agent-forge needing to maintain a service catalog.
- **Reaching services outside the container (host-run or LAN-run
  MongoDB, etc.)** — out of scope; host UFW already blocks all LAN/private
  ranges from containers, and this design doesn't touch that boundary.
  Everything a container needs lives inside its own Docker, in its own
  netns.
- **Chrome/browser access** — separate design, brainstormed independently.
