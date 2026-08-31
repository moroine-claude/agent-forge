# agent-forge

Infrastructure for running Claude Code agents in isolated LXD containers on a dedicated Ubuntu server.

## Architecture

```
SSH (port 2222, Ed25519, no password)
└── UFW (deny all, allow 2222, LXD isolated from LAN)
    └── Fail2ban (5 retries, 30 day ban)
        └── LXD container (2CPU, 4GB RAM, 20GB disk)
            └── aiuser (no sudo, /workspace only)
                └── Claude Code (Claude Pro, full permissions)
```

## Prerequisites

- Ubuntu 24.04 fresh install
- SSH access (keyboard/screen) for initial setup
- Claude Pro account
- GitHub bot account, invited as a **write collaborator** on each target repo

## Setup

### 1. SSH

Install and generate host keys:

```bash
sudo apt update && sudo apt install -y openssh-server
sudo ssh-keygen -A
```

Copy `config/sshd_config` to `/etc/ssh/sshd_config`, then validate and restart:

```bash
sudo sshd -t
sudo systemctl restart ssh
```

### 2. Firewall

```bash
sudo apt install -y ufw

# Détecter l'interface sortante (wlo1 pour WiFi, eth0/enp3s0 pour filaire)
IFACE=$(ip route get 8.8.8.8 | awk '{print $5; exit}')

sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 2222/tcp comment "SSH"

# Bloquer les containers LXD depuis toutes les plages privées/spéciales (IPv4)
# Empêche un container compromis d'atteindre le LAN ou des services internes
sudo ufw route deny in on lxdbr0 out on "$IFACE" to 10.0.0.0/8      comment "Block RFC1918 10/8"
sudo ufw route deny in on lxdbr0 out on "$IFACE" to 172.16.0.0/12   comment "Block RFC1918 172.16/12"
sudo ufw route deny in on lxdbr0 out on "$IFACE" to 192.168.0.0/16  comment "Block RFC1918 192.168/16"
sudo ufw route deny in on lxdbr0 out on "$IFACE" to 169.254.0.0/16  comment "Block link-local"
sudo ufw route deny in on lxdbr0 out on "$IFACE" to 100.64.0.0/10   comment "Block CGNAT"
sudo ufw route deny in on lxdbr0 out on "$IFACE" to 224.0.0.0/4     comment "Block multicast"

# Bloquer les plages privées IPv6 (le bridge lxdbr0 a IPv6 NAT activé par défaut)
sudo ufw route deny in on lxdbr0 out on "$IFACE" to fc00::/7        comment "Block IPv6 ULA"
sudo ufw route deny in on lxdbr0 out on "$IFACE" to fe80::/10       comment "Block IPv6 link-local"
sudo ufw route deny in on lxdbr0 out on "$IFACE" to ff00::/8        comment "Block IPv6 multicast"

# Autoriser internet (GitHub, Anthropic API, etc.)
sudo ufw route allow in on lxdbr0 out on "$IFACE" to any            comment "Allow internet"

sudo ufw enable
```

Optionnel — désactiver IPv6 sur le bridge LXD pour éliminer toute surface d'attaque IPv6 :

```bash
lxc network set lxdbr0 ipv6.address none
lxc network set lxdbr0 ipv6.nat false
```

### 3. Fail2ban

```bash
sudo apt install -y fail2ban
sudo cp config/jail.local /etc/fail2ban/jail.local
sudo systemctl enable --now fail2ban
```

### 4. System

Disable sleep and switch to headless mode:

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo systemctl set-default multi-user.target
sudo reboot
```

### 5. LXD

```bash
sudo snap install lxd
sudo lxd init --minimal
sudo usermod -aG lxd $USER
newgrp lxd
```

Build the base image:

```bash
./scripts/forge image build
```

(Aliased as `forge image update` — same command, use whichever name you find
more intuitive for a rebuild.) This scripts the same steps every time:
launches a scratch `agent-base-setup` container, installs Node LTS, `pnpm`,
Claude Code, `gh`, Chrome, `chrome-devtools-mcp`,
Docker (rootless) and Compose, and the
`next-task` helper, creates `aiuser`, sets
up `/workspace`/`.ssh`/`.claude` ownership, then publishes the `agent-base`
alias and cleans up the scratch container. Only affects containers created
*after* the rebuild — already-running containers keep their existing image
until you delete and `forge start` them again. Safely re-runnable: a leftover
`agent-base-setup` from a previous failed build is deleted first.

> **Note:** if you built `agent-base` before `gh` was part of the build, rebuild it — autonomous containers need the GitHub CLI.

Create the agent LXD profile:

```bash
lxc profile create agent
lxc profile edit agent
```

Paste the content of `config/lxd-agent-profile.yaml`.

This enables `security.nesting` (needed for rootless Docker inside each
container — see "Docker/Compose access" below) on top of an otherwise
unprivileged container, and sizes the root disk at 100GB to leave room for
Docker images/volumes.

### 6. GitHub bot account: signing key, PAT, branch protection

#### Signing key

Generate the commit-signing key on the server:

```bash
ssh-keygen -t ed25519 -C "agents-server-signing@github" -f ~/.ssh/github_agents_signing -N ""
```

On the GitHub bot account, add `github_agents_signing.pub` as a **Signing Key** under Settings → SSH and GPG keys. Agent commits then show as **Verified**.

> The old read-only deploy key (`~/.ssh/github_agents`) is no longer used by
> either mode — autonomous containers authenticate with a PAT over HTTPS,
> and supervised containers get no credential at all (the host clones over
> SSH using your own forwarded agent instead; see §7 and "Supervised mode"
> below). It can be removed if you don't need it for anything else.

#### Fine-grained PAT (one per target repo)

Created from **your laptop**, in the **bot account's** web UI — your personal
credentials never touch the server or the containers. GitHub has no API to
mint fine-grained PATs, so this step is manual:

1. Invite the bot account as a collaborator with **write** access on the target repo (and accept the invitation as the bot).
2. Logged in as the bot: Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
3. Resource owner: the repo's owner. Repository access: **Only select repositories** → the target repo.
4. Permissions: **Contents: Read and write**, **Pull requests: Read and write**, **Metadata: Read** (added automatically).
5. Expiration: maximum (1 year).
6. Keep the token in your password manager; you'll paste it when creating the container.

> **Fallback:** fine-grained PATs targeting a repo owned by another account
> are recent on GitHub's side. If token creation or usage fails cross-owner,
> use a classic PAT (`repo` scope) on the bot instead — same effective
> boundary, since the bot is only invited to agent-approved repos.

#### Branch protection (required before the first autonomous container)

On each autonomous repo, protect `main`: Settings → Branches → Add branch
ruleset (or classic protection rule) on `main`, with **Require a pull request
before merging** and **Require approvals: 1**.

This is the real security boundary — even a leaked token cannot land code on
`main`, and since GitHub forbids approving your own PR, the bot can never
merge its own work. You review and approve as yourself.

### 7. SSH Agent Forwarding (YubiKey)

On the server, add to `sshd_config`:

```
Match User moroine
    AllowAgentForwarding yes
Match User *
    AllowAgentForwarding no
```

On your local machine, add to `~/.ssh/config`:

```
Host omen
  HostName 192.168.1.177
  Port 2222
  User moroine
  ForwardAgent yes
```

Configuration de git host

```
git config --global user.name "Ton Nom"
git config --global user.email "ton@email.com"
git config --global gpg.format ssh
git config --global user.signingkey "$(ssh-add -L | head -1)"
git config --global commit.gpgsign true
```

## Usage

### Start a container (creates it on first use)

```bash
./scripts/forge start <owner/repo> [task-name]
```

Container identity is derived from `owner/repo` — no project name to choose
or remember. If no container exists yet for that repo, `forge start`
provisions one first:
- Prompts for the container's mode: **autonomous** (bot pushes and opens PRs itself) or **supervised** (no GitHub credential ever touches the container — see "Supervised mode" below)
- Creates an LXD container from `agent-base`
- Mounts `/workspace` with correct permissions (no `sudo` required — LXD idmap shifting handles the UID mapping, scoped to that one mount)
- Copies the signing key and configures git (signed commits)
- Reuses your Claude Code credentials from the host (`~/.claude/.credentials.json`), so the container starts already authenticated — no Remote Control pairing needed
- Pre-accepts onboarding and installs the `superpowers` plugin, so the first `claude` launch skips the setup questions
- **Autonomous:** prompts for the bot's fine-grained PAT (see setup §6), authenticates `gh` inside the container — the token is never written to host disk — and clones `https://github.com/<owner/repo>.git` inside the container
- **Supervised:** no token prompt; clones `git@github.com:<owner/repo>.git` on the host over SSH, using your own forwarded agent (§7) — the container never receives any GitHub credential
- Creates branch `agent/<task-name>` (`task-name` defaults to `init`, i.e. `agent/init`, if omitted)
- Records `owner/repo` and mode on the container itself (LXD config keys) — there's no separate registry file; `forge list` and future `forge start` calls discover containers this way

Either way (freshly provisioned or already existing), `forge start` then
starts the container if it's stopped and attaches a `claude` session in
`auto` permission mode inside tmux — autonomous by default, but the
auto-mode classifier pauses for confirmation on sensitive actions (credential
handling, irreversible deletion, pushes to protected branches, etc.). A
session URL and QR code are displayed at startup. Running it again on a
repo that already has a container just starts/attaches — no re-provisioning,
no re-pasting the PAT.

### Autonomous PR flow

The agent works on `agent/<task-name>`, pushes with
`git push -u origin agent/<task-name>` and opens a PR with
`gh pr create --base main`, all authenticated as the bot. The `pre-bash.sh`
hook only allows pushes to `origin agent/*` (no force, no delete) and blocks
`gh pr merge`, `gh api`, `gh repo`, `gh alias`, `gh extension` and
`gh auth token`. You review, approve and merge the PR as yourself.

### Supervised mode

For repos where no standing GitHub credential should ever exist inside a
container. The container gets no PAT and no `gh auth` — `pre-bash.sh`
blocks every `git push` and every `gh` subcommand unconditionally, and
`templates/CLAUDE.md` tells the agent to commit locally (signed) and stop
when the task is done, never attempting to publish.

Retrieving and publishing the work is a manual, laptop-side flow — every
line the agent wrote gets reviewed before it's re-authored as your own:

```bash
git remote add <container> ssh://moroine@<host>:2222/home/moroine/workspaces/<container>
git fetch <container> agent/<task-name>:agent/<task-name>
git log -p main..agent/<task-name>          # review before doing anything else
git checkout agent/<task-name>
git rebase --reset-author main
git push origin agent/<task-name>            # your identity, YubiKey-signed
```

`forge start`'s supervised path prints the exact `git remote add` command
(container name filled in) at the end of provisioning.

Reusing a supervised container for a new task (`!next-task <short-name>`)
skips the unpushed-commits check (there's no "pushed" concept without a
credential) and skips `git fetch origin` (no credential to fetch with) — if
you want an up-to-date `main` first, fetch it yourself from a host shell in
the workspace directory before running `next-task`.

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

### Browser automation (Chrome DevTools MCP)

Every agent container gets `chrome-devtools-mcp` wired up globally as an MCP
server — no `.mcp.json` needed per repo. It drives the headless
`google-chrome-stable` already installed in the image, letting the agent
navigate to a locally running dev server, take screenshots, and read
console/network output — the tool needed to follow the "verify UI changes in
a browser before reporting done" guidance in a container with no display and
no `claude-in-chrome` extension pairing.

Only reaches *new* containers: the binary is baked into the image at `forge
image build` time, and the MCP server declaration is pushed to
`~/.claude.json` once, at initial provisioning — neither refreshes on an
already-existing container. Rebuild the image and recreate (`forge delete`
+ `forge start`) to pick it up on a container that predates this change.

### Token renewal

Fine-grained PATs expire (max 1 year). To renew: create a new PAT in the bot's
web UI (same repo, same permissions), then re-authenticate the affected
container:

```bash
read -r -s TOKEN && printf '%s' "$TOKEN" | lxc exec agent-<owner>-<repo> -- su - aiuser -c "gh auth login --hostname github.com --with-token"; unset TOKEN
```

(`read -r -s` keeps the token out of your shell history and off the terminal.)

### Remote access

Once the session is running, connect from any device:

- **Browser**: open the session URL printed at startup, or go to [claude.ai/code](https://claude.ai/code) and find the session by repo name
- **Mobile app**: tap **Code** in the Claude app navigation

The session stays accessible as long as the container is running and the `claude` process is alive in tmux. If the Remote Control connection times out (network outage >10 min), re-run `forge start <owner/repo>` to start a fresh session — or type `/remote-control` inside an existing session to re-enable it.

**Requirements**: the host must be authenticated with a claude.ai account (`claude auth login`). API key auth does not support Remote Control. New containers reuse this credential automatically at provisioning time (see "Start a container" above); if you re-authenticate on the host afterward, existing containers keep their own copy until recreated.

### tmux cheatsheet

| Action | Command |
|--------|---------|
| Detach | `Ctrl+b d` |
| Reattach | `./scripts/forge start <owner/repo>` |
| List sessions | `./scripts/forge list` |
| Kill session | `lxc exec agent-<owner>-<repo> -- su - aiuser -c "tmux kill-session -t claude"` |

### Stop / list / delete containers

```bash
./scripts/forge stop <owner/repo> [--force]    # refuses on dirty/unpushed WIP unless --force; workspace/auth/tmux state persists
./scripts/forge list                           # repo, mode, LXD state, and session-alive status for every container
./scripts/forge delete <owner/repo> [--force]  # refuses on dirty/unpushed WIP unless --force (skipped if already stopped)
```

### Reusing a container for a new task

Once a task is done, committed, and pushed, reuse the same container instead
of recreating it: inside the live session, run `!next-task <short-name>`
(the `!` prefix runs it as a plain shell command, not an agent action). It
refuses if `/workspace` has uncommitted changes or commits not yet pushed to
`origin` (unless the current branch has no commits ahead of `origin/main` —
e.g. a fresh container that has done no work yet); otherwise it fetches
`origin`, checks out a fresh `agent/<short-name>` branch from `origin/main`,
and prints the new branch name so you can tell the agent to start fresh. `next-task` is baked into the `agent-base` image (see `forge
image build` above) — changes to it require an image rebuild plus
recreating affected containers.

### Bash completion

Completion is registered for the bare command name `forge`, not a path — if
you invoke the CLI as `./scripts/forge` (this README's convention),
tab-completion won't trigger unless `forge` also resolves on your `PATH`.
Add an alias alongside the `eval` line so both work the same way:

```bash
alias forge=/home/moroine/agent-forge/scripts/forge
eval "$(forge completion bash)"
```

Add those two lines to `~/.bashrc` to get `<owner/repo>` tab-completion on
`forge start`/`stop`/`delete`, sourced dynamically from `forge list`.
