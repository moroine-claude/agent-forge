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
- GitHub bot account with Deploy Keys

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
lxc launch ubuntu:24.04 agent-base-setup

lxc exec agent-base-setup -- apt update
lxc exec agent-base-setup -- apt install -y git tmux curl wget unzip zip python3 python3-pip
lxc exec agent-base-setup -- bash -c "curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -"
lxc exec agent-base-setup -- apt install -y nodejs
lxc exec agent-base-setup -- npm install -g pnpm
lxc exec agent-base-setup -- npm install -g @anthropic-ai/claude-code
lxc exec agent-base-setup -- bash -c "wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb && apt install -y --fix-missing /tmp/chrome.deb"
lxc exec agent-base-setup -- useradd -m -s /bin/bash aiuser
lxc exec agent-base-setup -- bash -c "mkdir -p /workspace /home/aiuser/.ssh /home/aiuser/.claude && chown aiuser:aiuser /workspace /home/aiuser/.ssh /home/aiuser/.claude && chmod 750 /workspace && chmod 700 /home/aiuser/.ssh"

lxc stop agent-base-setup
lxc publish agent-base-setup --alias agent-base
lxc delete agent-base-setup
```

Create the agent LXD profile:

```bash
lxc profile create agent
lxc profile edit agent
```

Paste the content of `config/lxd-agent-profile.yaml`.

### 6. GitHub Deploy Keys

Generate two SSH keys on the server:

```bash
ssh-keygen -t ed25519 -C "agents-server@github" -f ~/.ssh/github_agents -N ""
ssh-keygen -t ed25519 -C "agents-server-signing@github" -f ~/.ssh/github_agents_signing -N ""
```

On your GitHub bot account:
- Add `github_agents.pub` as a **Deploy Key** (read-only) on the target repo
- Add `github_agents_signing.pub` as a **Signing Key** under Settings → SSH and GPG keys

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

### Create a new agent container

```bash
./scripts/new-agent-container.sh <project-name>
```

This will:
- Create an LXD container from `agent-base`
- Mount `/workspace` with correct permissions
- Copy GitHub SSH keys
- Configure git (signed commits)
- Clone the repo and create branch `agent/<project-name>`

### Start a Claude Code session

```bash
./scripts/start-agent.sh <project-name>
```

This starts Claude with Remote Control enabled, named after the project. A session URL and QR code are displayed at startup.

### Remote access

Once the session is running, connect from any device:

- **Browser**: open the session URL printed at startup, or go to [claude.ai/code](https://claude.ai/code) and find the session by project name
- **Mobile app**: tap **Code** in the Claude app navigation

The session stays accessible as long as the container is running and the `claude` process is alive in tmux. If the Remote Control connection times out (network outage >10 min), re-run `start-agent.sh` to start a fresh session — or type `/remote-control` inside an existing session to re-enable it.

**Requirements**: the host must be authenticated with a claude.ai account (`claude auth login`). API key auth does not support Remote Control.

### tmux cheatsheet

| Action | Command |
|--------|---------|
| Detach | `Ctrl+b d` |
| Reattach | `./scripts/start-agent.sh <project-name>` |
| List sessions | `lxc exec agent-<project> -- su - aiuser -c "tmux ls"` |
| Kill session | `lxc exec agent-<project> -- su - aiuser -c "tmux kill-session -t claude"` |

### Delete a container

```bash
lxc delete agent-<project-name> --force
```
