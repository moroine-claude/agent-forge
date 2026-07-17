# Docker/Compose Support for Agent Containers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every agent container rootless Docker + Compose by default, so agents can run backing services (MongoDB, Postgres, Redis, etc.) their target repos depend on, for integration tests or for running the app itself — without creating a new privilege ceiling for `aiuser` or weakening the host's own security boundary.

**Architecture:** `security.nesting: "true"` on the shared `agent` LXD profile lets each (still-unprivileged) container run nested namespaces; `agent-base` installs rootless Docker (no privileged daemon, runs entirely as `aiuser`) plus the Compose plugin; `pre-bash.sh` adds three defense-in-depth guardrails (`--privileged`, `--pid=host`/`--network=host`, bind-mounts outside `/workspace`) on top of the namespace containment that's the real boundary. Every existing capability drop, `security.privileged: "false"`, and `security.syscalls.deny_default: "true"` stay untouched.

**Tech Stack:** Bash (strict mode), LXD (`lxc`), `jq`, Docker CE CLI + `docker-ce-rootless-extras` + `docker-compose-plugin` (Docker's official `apt` repo), `systemd --user` (rootless daemon lifecycle), `grep -E` (POSIX ERE, `pre-bash.sh` guardrails).

## Global Constraints

- Bash strict mode (`set -e`) in every script; quote all variable expansions (`"$VAR"`, never `$VAR`).
- Comment non-obvious blocks; test preconditions at the top of a function before it mutates anything.
- Never hardcode credentials, keys, or tokens.
- Docker must be **rootless**: no `docker-ce` (rootful daemon) package, no `docker` group, no root-owned `dockerd`. The privilege ceiling for `aiuser` after this change must be identical to before it — this is the property every task in this plan protects.
- `security.privileged` stays `"false"` and every existing `raw.lxc` capability drop (`sys_ptrace`, `mac_admin`, `bpf`, `sys_module`, etc.) stays in place. Nesting must not be used as an excuse to loosen any of those.
- `pre-bash.sh` guardrails apply identically in both `autonomous` and `supervised` mode — this is not a credential concern, so no `FORGE_MODE` branching.
- Tests in this repo are grep-based structural assertions (`assert_contains`/`assert_not_contains`/`assert_line_before`) plus `bash -n`, run directly with `bash tests/test-*.sh` — no test runner, no CI config. `pre-bash.sh` is executed for real (it never calls `lxc`). `config/lxd-agent-profile.yaml` and `scripts/lib/forge-image.sh` remain structural-only (grep + `bash -n`) — this dev environment has no LXD access, so the actual `docker run`/`docker compose up` runtime behavior can only be confirmed on the real server (see the design spec's Verification checklist).
- Full design rationale: `docs/superpowers/specs/2026-07-17-agent-docker-support-design.md`.

---

## Task 1: LXD profile — enable nesting, size the disk for Docker

**Files:**
- Modify: `config/lxd-agent-profile.yaml`
- Create: `tests/test-lxd-agent-profile.sh`

**Interfaces:**
- Consumes: nothing (no dependency on other tasks).
- Produces: `security.nesting: "true"` and a `100GB` root disk in the shared `agent` LXD profile — the runtime precondition Task 2's rootless Docker install needs to actually work on real hardware (Task 2's own tests are structural and don't depend on this file, but the two must ship together for Docker to function).

- [ ] **Step 1: Write the failing test**

Create `tests/test-lxd-agent-profile.sh`:

```bash
#!/bin/bash
# Tests structurels de config/lxd-agent-profile.yaml : nesting activé et
# disque suffisant pour Docker rootless (voir
# docs/superpowers/specs/2026-07-17-agent-docker-support-design.md).
# Lancer : bash tests/test-lxd-agent-profile.sh
set -e

FILE="$(cd "$(dirname "$0")/.." && pwd)/config/lxd-agent-profile.yaml"
PASS=0
FAIL=0

assert_contains() {
  if grep -qF -- "$1" "$FILE"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu présent): $1"
  fi
}

assert_not_contains() {
  if grep -qF -- "$1" "$FILE"; then
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu absent): $1"
  else
    PASS=$((PASS + 1))
  fi
}

assert_contains 'security.nesting: "true"'
assert_not_contains 'security.nesting: "false"'
assert_contains 'security.privileged: "false"'
assert_contains 'size: 100GB'
assert_not_contains 'size: 20GB'

# Les capabilities explicitement retirées restent inchangées malgré le nesting
assert_contains 'lxc.cap.drop = sys_module sys_rawio sys_boot sys_ptrace sys_pacct'
assert_contains 'lxc.cap.drop = mac_override mac_admin'
assert_contains 'lxc.cap.drop = bpf perfmon'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `bash tests/test-lxd-agent-profile.sh`
Expected:
```
FAIL (attendu présent): security.nesting: "true"
FAIL (attendu absent): security.nesting: "false"
FAIL (attendu présent): size: 100GB
FAIL (attendu absent): size: 20GB

PASS=4 FAIL=4
```
(exits non-zero)

- [ ] **Step 3: Edit the profile**

In `config/lxd-agent-profile.yaml`, change:

```yaml
  # Isolation : container non privilégié, pas de containers imbriqués
  security.privileged: "false"
  security.nesting: "false"
```
to:
```yaml
  # Isolation : container non privilégié. Nesting activé pour Docker rootless
  # (voir docs/superpowers/specs/2026-07-17-agent-docker-support-design.md) —
  # security.privileged reste "false", donc root dans un conteneur Docker
  # imbriqué reste un UID namespacé sans pouvoir sur l'hôte.
  security.privileged: "false"
  security.nesting: "true"
```

And change:
```yaml
  root:
    path: /
    pool: default
    size: 20GB
    type: disk
```
to:
```yaml
  root:
    path: /
    pool: default
    size: 100GB
    type: disk
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `bash tests/test-lxd-agent-profile.sh`
Expected:
```

PASS=8 FAIL=0
```

- [ ] **Step 5: Commit**

```bash
git add config/lxd-agent-profile.yaml tests/test-lxd-agent-profile.sh
git commit -m "feat: enable nesting and grow root disk for Docker-capable agent containers"
```

---

## Task 2: Rootless Docker + Compose in the `agent-base` image

**Files:**
- Modify: `scripts/lib/forge-image.sh`
- Modify: `tests/test-forge-image.sh`

**Interfaces:**
- Consumes: nothing directly (structural tests don't depend on Task 1), but functionally requires Task 1's `security.nesting: "true"` to actually run on real hardware.
- Produces: `agent-base` images built after this change have `docker`/`docker compose` on `PATH` for `aiuser`, with the rootless daemon auto-starting via `systemd --user` — this is what Task 3's guardrails defend and what Task 4/5's documentation describe.

- [ ] **Step 1: Write the failing test**

In `tests/test-forge-image.sh`, after the existing line:
```bash
assert_line_before "$LIB" 'Removing leftover' 'lxc launch ubuntu:24.04'
```
add:
```bash
assert_contains "$LIB" 'docker-ce-rootless-extras'
assert_contains "$LIB" 'docker-compose-plugin'
assert_contains "$LIB" 'add-subuids'
assert_contains "$LIB" 'add-subgids'
assert_contains "$LIB" 'enable-linger aiuser'
assert_contains "$LIB" 'dockerd-rootless-setuptool.sh install'
assert_contains "$LIB" 'systemctl --user enable docker'
assert_contains "$LIB" 'DOCKER_HOST=unix:///run/user/1001/docker.sock'
assert_line_before "$LIB" 'useradd -m -s /bin/bash aiuser' 'add-subuids'
assert_line_before "$LIB" 'add-subuids' 'dockerd-rootless-setuptool.sh install'
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `bash tests/test-forge-image.sh 2>&1 | tail -14`
Expected:
```
FAIL (attendu présent dans .../scripts/lib/forge-image.sh): docker-ce-rootless-extras
FAIL (attendu présent dans .../scripts/lib/forge-image.sh): docker-compose-plugin
FAIL (attendu présent dans .../scripts/lib/forge-image.sh): add-subuids
FAIL (attendu présent dans .../scripts/lib/forge-image.sh): add-subgids
FAIL (attendu présent dans .../scripts/lib/forge-image.sh): enable-linger aiuser
FAIL (attendu présent dans .../scripts/lib/forge-image.sh): dockerd-rootless-setuptool.sh install
FAIL (attendu présent dans .../scripts/lib/forge-image.sh): systemctl --user enable docker
FAIL (attendu présent dans .../scripts/lib/forge-image.sh): DOCKER_HOST=unix:///run/user/1001/docker.sock
FAIL (attendu 'useradd -m -s /bin/bash aiuser' avant 'add-subuids' dans .../scripts/lib/forge-image.sh): l1=45 l2=?
FAIL (attendu 'add-subuids' avant 'dockerd-rootless-setuptool.sh install' dans .../scripts/lib/forge-image.sh): l1=? l2=?

PASS=8 FAIL=10
```

- [ ] **Step 3: Install Docker packages (apt-level, before `aiuser` exists)**

In `scripts/lib/forge-image.sh`, after the existing line:
```bash
  lxc exec "$setup" -- bash -c "wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb && apt install -y --fix-missing /tmp/chrome.deb"
```
add:
```bash
  echo "Installing Docker (rootless)..."
  lxc exec "$setup" -- apt install -y uidmap dbus-user-session
  lxc exec "$setup" -- bash -c 'mkdir -p -m 755 /etc/apt/keyrings && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && chmod a+r /etc/apt/keyrings/docker.asc'
  lxc exec "$setup" -- bash -c 'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list'
  lxc exec "$setup" -- bash -c 'apt update && apt install -y docker-ce-cli docker-ce-rootless-extras docker-compose-plugin'
```

Only `docker-ce-cli` (the CLI binary) and `docker-ce-rootless-extras` (rootless setup tool + rootless daemon wrapper) are installed — deliberately **not** `docker-ce`, which pulls in the rootful daemon.

- [ ] **Step 4: Configure the rootless daemon for `aiuser` (after `aiuser` and its dirs exist)**

In `scripts/lib/forge-image.sh`, after the existing line:
```bash
  lxc exec "$setup" -- bash -c "mkdir -p /workspace /home/aiuser/.ssh /home/aiuser/.claude /home/aiuser/.local/bin && chown aiuser:aiuser /workspace /home/aiuser/.ssh /home/aiuser/.claude /home/aiuser/.local/bin && chmod 750 /workspace && chmod 700 /home/aiuser/.ssh"
```
add:
```bash
  echo "Configuring rootless Docker for aiuser..."
  lxc exec "$setup" -- usermod --add-subuids 200000-265535 --add-subgids 200000-265535 aiuser
  lxc exec "$setup" -- loginctl enable-linger aiuser
  lxc exec "$setup" -- su - aiuser -c "dockerd-rootless-setuptool.sh install --skip-iptables"
  lxc exec "$setup" -- su - aiuser -c "systemctl --user enable docker"
  lxc exec "$setup" -- su - aiuser -c "echo 'export DOCKER_HOST=unix:///run/user/1001/docker.sock' >> /home/aiuser/.bashrc"
  lxc exec "$setup" -- su - aiuser -c "echo 'export PATH=/usr/bin:\$PATH' >> /home/aiuser/.bashrc"
```

`--skip-iptables` avoids the rootless setup tool trying to manipulate host iptables rules it has no business touching inside a container. `loginctl enable-linger` keeps the rootless daemon's `systemd --user` instance running across tmux detach/reattach and SSH sessions ending, without needing an active login session.

- [ ] **Step 5: Run the test, confirm it passes**

Run: `bash tests/test-forge-image.sh 2>&1 | tail -3`
Expected:
```

PASS=18 FAIL=0
```

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/forge-image.sh tests/test-forge-image.sh
git commit -m "feat: install rootless Docker and Compose in the agent-base image"
```

---

## Task 3: `pre-bash.sh` Docker guardrails

**Files:**
- Modify: `.claude/hooks/pre-bash.sh`
- Modify: `tests/test-pre-bash.sh`

**Interfaces:**
- Consumes: nothing (no dependency on Tasks 1–2; this hook is pure text processing, testable for real without `lxc` or a Docker install).
- Produces: `pre-bash.sh` blocks `docker run --privileged`, `--pid=host`/`--network=host`, and bind-mounts outside `/workspace` — the defense-in-depth layer that Task 4's `templates/CLAUDE.md` section tells the agent about.

- [ ] **Step 1: Write the failing tests**

In `tests/test-pre-bash.sh`, right before the final block:
```bash
echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
```
insert:
```bash
# --- docker : défense en profondeur en plus du confinement par namespaces
# (nesting non-privilégié — voir docs/superpowers/specs/2026-07-17-agent-docker-support-design.md) ---
expect_block 'docker run --privileged ubuntu'
expect_block 'docker run -it --privileged debian bash'
expect_block 'docker run --privileged ubuntu && echo done'
expect_allow 'docker run ubuntu'
expect_allow 'docker ps -a'
expect_allow 'docker compose up -d'

expect_block 'docker run --pid=host ubuntu'
expect_block 'docker run --pid host ubuntu'
expect_block 'docker run --network=host ubuntu'
expect_block 'docker run --net=host ubuntu'
expect_allow 'docker run --network=mybridge ubuntu'

expect_block 'docker run -v /etc:/etc ubuntu'
expect_block 'docker run -v /home/aiuser:/data ubuntu'
expect_block 'docker run -v /:/host ubuntu'
expect_block 'docker run --mount type=bind,source=/etc,target=/etc ubuntu'
expect_allow 'docker run -v /workspace/data:/data mongo'
expect_allow 'docker run -v mongodata:/data/db mongo'
expect_allow 'docker run --mount type=bind,source=/workspace/data,target=/data mongo'

# Ces blocages s'appliquent identiquement dans les deux modes (aucune credential en jeu)
expect_block_as supervised 'docker run --privileged ubuntu'
expect_block_as autonomous 'docker run --privileged ubuntu'
expect_allow_as supervised 'docker compose up -d'
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `bash tests/test-pre-bash.sh 2>&1 | tail -25`
Expected: 21 new `FAIL (attendu BLOCK...)` / `FAIL (attendu ALLOW...)` lines (every new `docker`-related case fails, since the hook doesn't recognize `docker` at all yet — every command is currently allowed through), ending with:
```

PASS: 73  FAIL: 21
```

- [ ] **Step 3: Add the guardrails**

In `.claude/hooks/pre-bash.sh`, right before the final line:
```bash
exit 0
```
insert:
```bash
# Docker : défense en profondeur en plus du confinement par namespaces
# (nesting non-privilégié — security.privileged reste "false", voir
# docs/superpowers/specs/2026-07-17-agent-docker-support-design.md). Ces
# règles ne sont pas la frontière réelle, qui vient du namespacing ; elles
# évitent juste que le conteneur Docker imbriqué brouille la frontière avec
# le conteneur agent lui-même.
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])docker[[:space:]].*--privileged([[:space:]]|=|$)'; then
  block "docker run --privileged non autorisé."
fi

if echo "$COMMAND" | grep -qE '(--pid|--network|--net)(=|[[:space:]]+)host'; then
  block "docker --pid=host / --network=host non autorisé."
fi

# Bind-mounts hors /workspace : /etc, /home (clé de signature, credentials
# Claude), /root, /var, /usr, /boot, /proc, /sys, ou la racine entière.
if echo "$COMMAND" | grep -qE '(-v|--volume|--mount)[[:space:]=]+[^[:space:]]*:?/(etc|home|root|var|usr|boot|proc|sys)([:/[:space:]]|$)' \
   || echo "$COMMAND" | grep -qE '(-v|--volume)[[:space:]=]+/:[^[:space:]]*'; then
  block "Bind-mount Docker hors /workspace non autorisé."
fi
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `bash tests/test-pre-bash.sh 2>&1 | tail -3`
Expected:
```

PASS: 94  FAIL: 0
```

- [ ] **Step 5: Commit**

```bash
git add .claude/hooks/pre-bash.sh tests/test-pre-bash.sh
git commit -m "feat: block docker --privileged/--pid=host/--network=host and bind-mounts outside /workspace"
```

---

## Task 4: `templates/CLAUDE.md` — tell the agent Docker is available

**Files:**
- Modify: `templates/CLAUDE.md`
- Modify: `tests/test-claude-template.sh`

**Interfaces:**
- Consumes: nothing (independent of Tasks 1–3; this is a documentation-only change with structural tests).
- Produces: agents provisioned after this change know Docker/Compose is available and what `pre-bash.sh` (Task 3) blocks, so they write compose files that avoid the guardrails by design rather than by surprise.

- [ ] **Step 1: Write the failing test**

In `tests/test-claude-template.sh`, after the existing:
```bash
assert_line_before '`autonomous`' '`supervised`'
```
add:
```bash
assert_contains '## Docker'
assert_contains 'docker compose up'
assert_contains '--privileged'
assert_line_before '## Git' '## Docker'
assert_line_before '## Docker' '## Périmètre'
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `bash tests/test-claude-template.sh 2>&1 | tail -8`
Expected:
```
FAIL (attendu présent): ## Docker
FAIL (attendu présent): docker compose up
FAIL (attendu présent): --privileged
FAIL (attendu 'Git' avant 'Docker'): l1=13 l2=?
FAIL (attendu 'Docker' avant 'Périmètre'): l1=? l2=30

PASS=9 FAIL=5
```

- [ ] **Step 3: Add the section**

In `templates/CLAUDE.md`, right before the `## Périmètre` heading, insert:
```markdown
## Docker
- Docker (rootless) et Docker Compose sont disponibles — utilise `docker compose up` / `docker run` pour les services dont dépend le repo (tests d'intégration, vérification de l'application en conditions réelles)
- `docker run --privileged`, `--pid=host`/`--network=host`, et les bind-mounts hors `/workspace` sont bloqués — utilise des volumes nommés ou des chemins sous `/workspace` dans tes fichiers `docker-compose.yml`

```
(blank line preserved before `## Périmètre`, matching the spacing between every other section in the file)

- [ ] **Step 4: Run the test, confirm it passes**

Run: `bash tests/test-claude-template.sh 2>&1 | tail -3`
Expected:
```

PASS=14 FAIL=0
```

- [ ] **Step 5: Commit**

```bash
git add templates/CLAUDE.md tests/test-claude-template.sh
git commit -m "docs: tell agents Docker/Compose is available and what pre-bash.sh blocks"
```

---

## Task 5: README — document Docker/Compose access

**Files:**
- Modify: `README.md`
- Modify: `tests/test-readme-docs.sh`

**Interfaces:**
- Consumes: nothing (independent of Tasks 1–4; documentation-only).
- Produces: the operator-facing record of this feature, consistent with how autonomous/supervised mode are documented today.

- [ ] **Step 1: Write the failing test**

In `tests/test-readme-docs.sh`, after the existing:
```bash
assert_contains 'permission mode'
```
add:
```bash
assert_contains 'Docker/Compose'
assert_contains 'rootless'
assert_contains '--privileged'
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `bash tests/test-readme-docs.sh 2>&1 | tail -6`
Expected:
```
FAIL (attendu présent): Docker/Compose
FAIL (attendu présent): rootless
FAIL (attendu présent): --privileged

PASS=18 FAIL=3
```

- [ ] **Step 3: Update the image-build description**

In `README.md`, change:
```
launches a scratch `agent-base-setup` container, installs Node LTS, `pnpm`,
Claude Code, `gh`, Chrome, and the `next-task` helper, creates `aiuser`, sets
```
to:
```
launches a scratch `agent-base-setup` container, installs Node LTS, `pnpm`,
Claude Code, `gh`, Chrome, Docker (rootless) and Compose, and the
`next-task` helper, creates `aiuser`, sets
```

- [ ] **Step 4: Note the profile change at the profile-creation step**

In `README.md`, after:
```
Paste the content of `config/lxd-agent-profile.yaml`.
```
add:
```

This enables `security.nesting` (needed for rootless Docker inside each
container — see "Docker/Compose access" below) on top of an otherwise
unprivileged container, and sizes the root disk at 100GB to leave room for
Docker images/volumes.
```

- [ ] **Step 5: Add the "Docker/Compose access" section**

In `README.md`, right before the `### Token renewal` heading, insert:
```markdown
### Docker/Compose access

Every agent container gets rootless Docker and Compose by default (baked
into `agent-base`, no opt-in) — for repos that need a backing service
(MongoDB, Postgres, Redis, ...) for tests or for running the app itself.
The daemon runs entirely as `aiuser` (no root, no `docker` group, no
privileged daemon): a worst-case container escape lands the agent back at
its own existing `aiuser` privilege level, nothing new. `pre-bash.sh` blocks
`--privileged`, `--pid=host`/`--network=host`, and bind-mounts outside
`/workspace` as defense-in-depth on top of that containment — everything
else (`docker run`, `docker compose up`, named volumes, workspace-relative
bind mounts) works normally. See
`docs/superpowers/specs/2026-07-17-agent-docker-support-design.md` for the
full design rationale.

### Token renewal
```

- [ ] **Step 6: Run the test, confirm it passes**

Run: `bash tests/test-readme-docs.sh 2>&1 | tail -3`
Expected:
```

PASS=21 FAIL=0
```

- [ ] **Step 7: Run the full suite as a final check**

Run: `for f in tests/test-*.sh; do bash "$f" > /tmp/t.out 2>&1 || { echo "=== $f FAILED ==="; cat /tmp/t.out; }; done; echo done`
Expected: `done` with no `FAILED` lines printed.

- [ ] **Step 8: Commit**

```bash
git add README.md tests/test-readme-docs.sh
git commit -m "docs: document Docker/Compose access for agent containers"
```

---

## Manual verification (not automatable in this dev environment)

This repo's tests are structural (grep + `bash -n`) because this environment has no LXD. Before considering the feature done, run the design spec's Verification checklist (`docs/superpowers/specs/2026-07-17-agent-docker-support-design.md`) on the real server: `forge image build`, update the `agent` profile, recreate a test container, and confirm `docker run hello-world`, `docker compose up -d` with a Mongo compose file, daemon survival across tmux detach/reattach, and that the three guardrails actually block real commands end-to-end.
