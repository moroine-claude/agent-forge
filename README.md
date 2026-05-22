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
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 2222/tcp comment "SSH"
sudo ufw route deny in on lxdbr0 out on wlo1 to 192.168.1.0/24
sudo ufw route allow in on lxdbr0 out on wlo1 to any
sudo ufw enable
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
