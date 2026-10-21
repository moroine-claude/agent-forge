# agent-forge

Run Claude Code agents in sealed Incus system containers, one container per
repository and one git worktree per task, on a hardened host that you reach
from your own machine with [herdr](https://herdr.dev).

```
your machine                     host (a VM)                          containers
┌──────────────────────┐  ssh    ┌───────────────────────────┐        ┌──────────────────────┐
│ herdr client         │───────▶ │ herdr server              │ incus  │ agent-<owner>-<repo> │
│ git, ssh (your key)  │         │ forge, Incus, Claude login│──────▶ │ Claude Code, Docker, │
│ Ansible (provisions) │◀─────── │ ~/workspaces/<container>  │  exec  │ Chrome, /workspace   │
└──────────────────────┘  fetch  └───────────────────────────┘        └──────────────────────┘
```

- **The host** is an Ubuntu 26.04 VM that `ansible/site.yml` provisions and
  hardens: a cloud VM or a LAN machine (remote mode), or a Lima VM on your own
  Mac or Ubuntu machine (local mode).
- **The containers** hold no SSH key and no GitHub credential. The host clones
  and fetches with your forwarded SSH agent; agents commit locally and never
  push. You fetch their work from your machine, review it, sign it and push
  it yourself.
- **herdr** keeps every agent in a tab of a session that survives your laptop
  closing. One key opens a new task.

The [security model](#security-model) says what this protects against and
what it does not.

## Choose your setup

| | Local | Remote |
|---|---|---|
| Where the host runs | A Lima VM on your Mac (Apple Silicon) or Ubuntu machine | A cloud VM or a machine on your LAN |
| Best for | Trying agent-forge, working on one machine | Agents that keep running while your laptop is off |
| Guide | [Quick start: local](#quick-start-local) | [Remote host](#remote-host) |

Both end the same way: you SSH to the host once to log in and build the
image, then you work from herdr on your machine.

## Quick start: local

About an hour, most of it waiting for the playbook and the image build. The
VM takes 4 CPUs, 6 GiB of memory and a sparse 60 GiB disk (about 11 GiB used
after the first image build); change them with `limactl edit`.

Validated on an Apple Silicon Mac. The Ubuntu 24.04 path is
**not yet validated** on a real machine: report what breaks.

### 1. Install the tools on your machine

**macOS:**

```bash
brew install lima ansible herdr
```

**Ubuntu 24.04:** Lima runs its VMs with QEMU and KVM. Lima itself comes from
its release archive (2.1.2 or newer, see https://github.com/lima-vm/lima/releases),
and Ubuntu's own ansible is too old:

```bash
sudo apt install qemu-system-x86 qemu-utils pipx
sudo usermod -aG kvm "$USER"          # then log out and back in; /dev/kvm must be writable
curl -fsSL https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Linux-x86_64.tar.gz \
  | sudo tar -C /usr/local -xz
pipx install ansible-core             # 2.20 or newer
```

Install herdr from its releases (https://herdr.dev).

**Both:** you need git, and an SSH key that GitHub accepts, loaded in the
agent that ssh uses by default (`ssh-add -L` lists it). The host clones your
repositories with it, through agent forwarding.

### 2. Create the VM

```bash
git clone https://github.com/moroine/agent-forge.git
cd agent-forge
limactl create --tty=false --name forge-local ansible/lima/forge.yaml
limactl start forge-local
```

`--tty=false` skips `limactl create`'s question (proceed, edit the configuration, or pick another
template): the template is meant to be used as is.

The template (`ansible/lima/forge.yaml`) runs Lima in plain mode: no shared
folder, no port forwarding besides SSH on `127.0.0.1:60022`. Workspaces live
inside the VM. If port 60022 is taken, create the VM with another one, then
use that port as `ansible_port` in the inventory and as `Port` in the SSH
block below:

```bash
limactl create --tty=false --name forge-local --set '.ssh.localPort = 60122' ansible/lima/forge.yaml
```

### 3. Provision it

```bash
cp ansible/inventory.lima.example.yml ~/forge-local-inventory.yml
```

Edit `~/forge-local-inventory.yml`:

- `ansible_user`: your login name on this machine (`whoami`); Lima created
  that account in the VM;
- `ssh_keys`: the public key you use for GitHub (`ssh-add -L`).

Then run the playbook from the checkout (it deploys `forge` from its HEAD):

```bash
ansible-galaxy collection install -r ansible/requirements.yml
ansible-playbook -i ~/forge-local-inventory.yml ansible/site.yml
```

A second run must report `changed=0`. `ansible/README.md` covers the
playbook's options and what it hardens.

### 4. Reach the VM over SSH

Add this to `~/.ssh/config`:

```
Host forge-local
  HostName 127.0.0.1
  Port 60022
  User forge
  HostKeyAlias forge-local
  ForwardAgent yes
```

`forge` is the forge user the playbook created. `ForwardAgent yes` lets the
host clone your repositories with your key. OpenSSH forwards the agent it
uses for that host, the one named by `IdentityAgent` (or `SSH_AUTH_SOCK`):
if your GitHub key lives in another agent (a hardware key's, a password
manager's), set `IdentityAgent` to it in this block.

### 5. Log in and build the image

```bash
ssh forge-local                        # accept the host key once
claude auth login
git config --global user.name "Alice Example"
git config --global user.email "alice@example.com"
forge setup
forge image build                      # about 10 minutes
exit
```

- `claude auth login` logs Claude Code in on the host; every new container
  reuses those credentials.
- The git identity is the one the agents' commits carry.
- `forge setup` creates forge's Incus objects, the egress proxy and its
  allowlist when Incus is recent enough (see
  [Strict egress mode](#strict-egress-mode)), and forge's herdr key bindings.
  Run it again after changing forge's configuration. On a fresh host, two
  notices are expected:

  ```
  NOTICE: Incus 7.0.1 is too old for strict mode, which needs 7.0.2 or later on the 7.0 LTS line ...
  NOTICE: herdr is not installed on this host yet, which is expected before your first attach ...
  ```

  The first goes away once Zabbly publishes Incus 7.0.2 and you re-run the
  playbook; the second at your first `herdr --remote` (step 6).
- `forge image build` builds `agent-base`, the image every container starts
  from.

### 6. Start a task from herdr

In a real terminal (the first attach asks to install herdr on the host):

```bash
herdr --remote forge-local --remote-keybindings server
```

`--remote-keybindings server` is required: forge's keys live on the host.
Press `prefix+f` (herdr's prefix is `ctrl+b`). A popup asks for the repository
(`owner/repo`, the first time) and the task:

- the first `prefix+f` on a repository creates its container, clones it on the
  host and accepts GitHub's host key once, in the popup;
- each task gets a worktree, `/workspace/.trees/<task>` on branch
  `agent/<task>`, and its own tab running Claude Code.

The popup waits for Enter when it has something to show you, such as the
retrieval commands after a new container.

### 7. Get the work back

On your machine, in your own clone of the repository:

```bash
git remote add agent-acme-widgets forge-local:agent-acme-widgets
git config remote.agent-acme-widgets.uploadpack "forge upload-pack agent-acme-widgets"
git fetch agent-acme-widgets
```

`forge start` prints these three lines for each new container, with
`<forge-host>` where your SSH alias goes. The fetch runs `forge upload-pack` on
the host, which serves the repository from inside the container: the host
never runs git in the agent's workspace. Review the branch, then sign and push
it yourself.

### The local VM day to day

- `limactl stop forge-local` / `limactl start forge-local`. Agents stop with
  the VM; after a start, attach again and press `prefix+shift+f` to bring them
  back with their conversation.
- To start over: fetch every branch you want first (workspaces live in the
  VM), then `limactl delete forge-local`, and
  `ssh-keygen -R forge-local; ssh-keygen -R forge-local-admin` for the old host
  keys.

## Remote host

The same steps, on a VM that you create:

1. **The VM.** Ubuntu 26.04, at least 2 vCPU, 4 GB of memory and a 40 GB disk
   (more for several agents), with a sudo account Ansible can log in to with
   your key (`ubuntu` on most cloud images). Let SSH (port 22) through the
   provider's firewall.
2. **The inventory.** Copy `ansible/inventory.example.yml` outside the
   repository and set:
   - the VM's address, and the admin account as `ansible_user`;
   - `forge_exposure: public` for a cloud VM, `lan` for a machine on your
     network;
   - your forge user: a name of your choice and your GitHub public key.

   Then run the playbook, as in [step 3](#3-provision-it).
   `ansible/README.md` covers the options (SSH sources, storage pool, a sudo
   password).
3. **The SSH alias.** The port stays 22 unless you set `forge_ssh_port`:

   ```
   Host forge-vm
     HostName 203.0.113.10
     User alice
     ForwardAgent yes
   ```

Then follow steps [5](#5-log-in-and-build-the-image) to
[7](#7-get-the-work-back) with `forge-vm` in place of `forge-local`:
`herdr --remote forge-vm --remote-keybindings server`, and
`git remote add <container> forge-vm:<container>`.

## Daily use

### Keys

| Key | What it does |
|---|---|
| `prefix+f` | `forge start` in a popup: pick a repository and a task; opens or focuses the task's tab. One herdr workspace per repository, one tab per task |
| `prefix+shift+f` | `forge resume --all`: after a herdr server restart or a VM reboot, relaunches the agent in every forge tab left as a bare shell, with its conversation |

Agents keep running when you detach. In remote mode they also run while
your laptop sleeps; in local mode they pause with the VM.

### Commands

Run on the host (in a herdr pane, or over `ssh`):

| Command | What it does |
|---|---|
| `forge start [--strict] [<owner/repo>] [<task>]` | Create the container if needed, then open the task. `--strict` creates a new container in strict egress mode |
| `forge resume [<owner/repo>] [<task>]` | Re-attach a task's agent, with no fetch; `--all` for every forge tab (inside herdr) |
| `forge finish [<owner/repo>] [<task>]` | Stop the task's agent and remove its worktree, refused on uncommitted changes unless `--force`. The branch `agent/<task>` stays; a task name reused later starts a fresh conversation |
| `forge list` | Every container: repository, mode, egress, state, image build |
| `forge stop [<owner/repo>] [--force]` | Stop a container; refused while a task has uncommitted changes, unless `--force`. Commits are not checked: fetch them first |
| `forge delete [<owner/repo>] [--force]` | Delete a container, with the same guard. Its workspace and the host's mirror stay, and `forge start` reuses them |
| `forge egress [<owner/repo>] [strict\|open]` | Show or switch a stopped container's egress |
| `forge egress log [<owner/repo>]` | The egress proxy's recent requests |
| `forge attach <container> <task>` | Run a task's agent in this terminal: what herdr tabs run |
| `forge image build` | Rebuild `agent-base` |
| `forge completion bash` | Bash completion (already installed on the host by Ansible) |

A bracketed argument left out is asked for, as a numbered menu.

**Outside herdr** (plain `ssh`), `forge start` and `forge resume` run the
agent in the foreground and say
`outside herdr: the agent stops when this terminal closes`: no persistence.

### Rules for getting work back

- **Never run git yourself in `~/workspaces/<container>` on the host,** and do
  not `cd` there with a git-aware prompt. The agent controls that repository,
  hooks and `.git/config` included, and host git would run its commands as
  you. Fetch from your machine, as in step 7.
- **Review agent code before running it on your machine.** Checking out an
  agent branch and running its scripts (`npm install`, test runners) runs the
  agent's code there.
- **Large files:** Git LFS content is not available inside containers; files
  are checked out as pointers.

Inside the container, `origin` is a read-only mirror the host refreshes at
each `forge start`: the agent can `git fetch origin`, never push.

### Strict egress mode

By default a container reaches the internet, but not private, link-local,
CGNAT or multicast ranges (your LAN, the cloud metadata service, the host, the
other containers). Strict mode is per container: it reaches only the domains
on your allowlist, through a filtering proxy (`forge-proxy`) that
`forge setup` manages, and it fails closed: a program that ignores the proxy
reaches nothing.

- **The allowlist** is `~/.config/agent-forge/egress-allowlist` on the host,
  one domain per line (`example.com`, or `.example.com` for its subdomains
  too). `forge setup` creates it with Claude Code's own domains active and
  common ones (GitHub, npm, PyPI, Docker Hub) commented out, each with what
  it lets a hijacked agent do. Edit it, then run `forge setup` to apply it.
- `forge start --strict <owner/repo>` creates a container strict from its
  first boot.
- `forge egress <owner/repo> strict` or `open` switches a stopped container
  (`forge stop` first); `forge egress` alone shows it.
- `forge egress log` shows what was allowed and refused: use it to find the
  domain to add.
- Docker in a strict container pulls through the proxy; builds and containers
  get no proxy unless you pass `HTTPS_PROXY` to them.
- Strict mode needs Incus 7.0.2 or newer on the 7.0 LTS line, or 7.5.0 or
  newer. 7.0.2 is not published yet on Zabbly's lts-7.0 channel, which the
  playbook installs from (October 2026): until it is, `forge setup` prints a
  notice and skips the strict objects, and `forge start --strict` is refused.
  Re-running the playbook upgrades Incus once 7.0.2 is out.

### Docker, Compose and the browser

- **Docker and Compose** run rootless inside every container, as the agent's
  own unprivileged user, for repositories that need a database or other
  services. `pre-bash.sh` blocks `--privileged`, host namespaces and bind
  mounts outside `/workspace`.
- **Chrome DevTools MCP** is configured in every container. The agent drives
  headless Chrome to check a running app: navigation, screenshots, console
  and network.

### The image

`forge list` shows `behind` in the BUILD column when a container was created
from an older `agent-base` than the latest build. After `forge image build`,
existing containers keep their image until recreated: `forge delete`, then
`forge start` (the workspace is kept).

## Updating

From your machine, in the agent-forge checkout:

```bash
git pull
ansible-playbook -i ~/forge-local-inventory.yml ansible/site.yml
```

The playbook deploys the checkout's `forge` and upgrades Incus within its
channel. Then on the host run `forge setup`, and `forge image build` when the
image changed.

## Configuration

Both files live on the host and are optional; `forge setup` reads them.

- **`~/.config/agent-forge/config.json`**, with its defaults:

  ```json
  {
    "network": { "ipv4Address": "10.77.0.1/24" },
    "storagePool": "default",
    "limits": { "cpu": null, "memory": "75%", "processes": 10000, "rootDisk": "50GiB" }
  }
  ```

  - `network.ipv4Address`: the bridge's address, a /27 or wider inside
    `10.0.0.0/8`, `172.16.0.0/12` or `192.168.0.0/16`;
  - `limits`: per container. `cpu` is `null` (no limit), a number or a CPU
    set; `memory` a size or a percentage of the host's; `rootDisk` is a guard
    rail, not a hard limit.

  An unknown key or an invalid value stops `forge setup` with the file and
  the key.
- **`~/.config/agent-forge/egress-allowlist`**: see
  [Strict egress mode](#strict-egress-mode).

## Security model

| Threat | What stands in the way |
|---|---|
| An agent escapes its container | Unprivileged container, seccomp, capability drops, Incus' AppArmor profile. It lands in the host VM, not on your machine |
| A container reaches your LAN, the cloud metadata service, the host or another container | The `forge-egress` network ACL rejects private, link-local, CGNAT and multicast ranges; IPv6 is off on the bridge |
| An agent sends code or tokens out | Accepted in the default open mode. Strict mode limits egress to your allowlist |
| An agent publishes to GitHub | No GitHub credential in containers; `pre-bash.sh` blocks `git push` and `gh` |
| An agent drives other agents' tabs | herdr's control socket lives on the host, outside every container |
| SSH brute force on the host | Keys only, fail2ban (not in local mode), a connection rate limit (`public`), an optional source restriction |
| Your forwarded agent is abused on the host | Containers never receive it; a hardware key asks for a touch per use |

Known limits:

- **Local mode:** the Lima VM can reach your machine's localhost and your LAN
  (containers cannot). An agent that escaped its container into the VM could
  too.
- **DNS:** a container can still tunnel data through DNS queries to the
  bridge, in both modes.
- **Strict mode** does not inspect TLS: an allowed domain that accepts uploads
  (a package registry, an API with another key) is still a way out.
- **Escape sequences:** agent output reaches herdr and your terminal (window
  titles, clipboard).
- The forge user on the host is root-equivalent through Incus (one user per
  VM).

## Troubleshooting

- **A container was half provisioned** (provisioning stopped midway):
  `forge delete` cannot find it and `forge start` refuses to reuse it. Delete
  it on the host with
  `incus --project agent-forge delete --force <container>`; its workspace
  survives.
- **Provisioning says the security hook refuses a harmless command:** the
  image predates a change to it. Run `forge image build`, then recreate the
  container.
- **`REMOTE HOST IDENTIFICATION HAS CHANGED`** after recreating the VM:
  `ssh-keygen -R forge-local` (and `forge-local-admin` for Ansible).
- **The host cannot clone** (`Permission denied (publickey)` or
  `Error connecting to agent`): the agent is not forwarded. Check
  `ForwardAgent yes` and `IdentityAgent` in your SSH config, and that you are
  attached: with no client attached, the host has no agent.
- **`herdr --remote` fails the first time:** run it in a real terminal; it
  asks before installing herdr on the host.
- **The first clone of a repository stops on GitHub's host key:** the popup
  shows GitHub's key fingerprint. Check it against GitHub's published SSH
  fingerprints and answer `yes`; answering no ends in
  `Host key verification failed`, and the next `prefix+f` asks again.
- **`Too many authentication failures`** from `ssh forge-local` or
  `ssh forge-vm`: sshd allows two attempts, which an agent holding several
  keys uses up. Add `IdentityFile ~/.ssh/<your key>.pub` and
  `IdentitiesOnly yes` to the Host block.
- **A repository whose default branch is not `main`:** new tasks start from
  `origin/main`, so such a repository is not supported yet.
- **`forge setup` warns that forge runs directly on this machine:** you ran it
  outside a VM. Use the Lima VM: nothing would stand between an escaped agent
  and your machine.

## Developing agent-forge

- `npm test` (unit, contract and bash tests), `npm run check` (types),
  `npm run test:ansible` (the playbook's unit tests) and
  `ansible-lint ansible/`.
- `FORGE_INTEGRATION=1 npm run test:integration` runs against a real,
  throwaway Incus.
- `ansible/tests/vm-test.sh` provisions a fresh machine twice, verifies it,
  reboots it and verifies again: `--lima` for a throwaway Lima VM, `--host`
  for a fresh cloud VM, or a VM on an Incus host with KVM. See
  `ansible/README.md`.
- Designs and plans live in `docs/superpowers/`.
