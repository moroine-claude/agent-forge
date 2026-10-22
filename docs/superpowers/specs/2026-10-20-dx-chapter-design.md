# agent-forge DX chapter: fixes, guided install, daily work loop — Design

**Date:** 2026-10-20
**Status:** Approved by the maintainer (2026-10-20)
**Branch:** `agent/dx-chapter`, from `main` (pull requests `--base main`)

## Context

v2 (Incus runtime, Ansible host, strict egress, herdr orchestration, local
Lima mode) was released on `main` on 2026-10-19. The maintainer's next focus
is **developer experience**. Security hardening and exhaustiveness come later:
issues #78 to #80 stay out of this chapter.

This document does two things:

- it **frames the chapter**: five sub-projects, their order, and what is left
  out (section "The chapter");
- it **designs sub-projects 1, 3 and 4**, which the maintainer expects to be
  quick. Sub-projects 5 and 2 get their own brainstorming and spec.

Sub-projects keep the numbers they had while brainstorming, so the order
reads 1, 3, 4, 5, 2.

### What exists

- `README.md`: the install guide per mode. The local quick start is seven
  manual steps, about fifteen commands: create the Lima VM, copy and edit an
  inventory, run the playbook, paste an SSH block, then on the host
  `claude auth login`, the git identity, `forge setup`, `forge image build`
  (about 10 minutes), and finally `herdr --remote <alias>
  --remote-keybindings server`.
- `forge`, the TypeScript CLI in `cli/`, runs **on the host only**: `setup`,
  `image build`, `start`, `resume`, `finish`, `stop`, `delete`, `list`,
  `egress`, `attach`, `upload-pack`.
- herdr: one workspace per repository, one tab per task; `prefix+f` opens
  `forge start` in a popup, `prefix+shift+f` runs `forge resume --all`.
- Retrieval: three git commands per container on the dev machine
  (`git remote add <c> <host>:<c>`, `remote.<c>.uploadpack = "forge
  upload-pack <c>"`, `git fetch <c>`), then the maintainer re-signs and pushes
  by hand.
- One container per repository (`agent-<owner>-<repo>`); each task is a
  worktree `/workspace/.trees/<task>` on branch `agent/<task>`.

## The chapter

| # | Sub-project | What it covers | Spec |
|---|---|---|---|
| 1 | Fixes | The `prefix+f` popup closes on success; a half-provisioned container no longer blocks `forge start` | This document |
| 3 | Guided install | A laptop-side `forge install` that replaces the manual install and update steps; `forge open` to attach herdr | This document |
| 4 | Daily work loop | `forge fetch` and `forge ship` (retrieve, re-sign, push, open the PR); Git LFS as an option, read and write | This document |
| 5 | Several agents per task | One herdr workspace per repository and task; an orchestrator agent in the container; Claude and Codex in one container talking through herdr; herdr's Claude integration | Its own, brainstormed next |
| 2 | Prebuilt images | GitHub Actions builds `agent-base`; `forge` downloads it instead of building it; only a change to the image role needs a local build | Its own, last |

Order: **1, 3, 4, 5, 2**, the maintainer's (2026-10-20). Two consequences,
accepted: until 2 lands, the guided install still runs the 10-minute image
build; and 5, which adds Codex to the image, needs a local rebuild.

### Left out of the chapter

- **HTTP preview** (reaching a dev server in a container from the laptop's
  browser). The maintainer dropped it as too tricky for now; it stays an idea
  for later.
- **GitKraken** (or any GUI git client) compatibility. The retrieval targets
  command-line git; what a GUI client does with the remote is out of scope.
- Issues #78, #79, #80 (security and hardening), unless the maintainer asks.
- Issue #77 (validating the Ubuntu local path) runs separately, the week of
  2026-10-26. `forge install` must support an Ubuntu laptop (Lima on QEMU/KVM)
  by design; its validation there follows #77.

### Notes for sub-project 5 (not designed here)

From the brainstorming, to seed its own:

- The maintainer wants **one herdr workspace per repository and task**
  (today: one per repository, one tab per task), an **orchestrator agent in
  the container**, **Claude and Codex in the same container talking to each
  other through herdr**, and `herdr integration install claude` to see the
  agents' state and sub-agents.
- The crux: the herdr server runs on the host, and herdr can run commands in
  host panes. Letting an in-container agent reach it is a channel out of the
  container. The v2 herdr spec made "herdr's Claude integration" a non-goal for
  exactly this reason (its hook would live in the container and could not
  reach the host socket). Any such channel is a change to the security
  architecture and needs the maintainer's explicit validation (`CLAUDE.md`).
- Codex needs its own credentials on the host, as Claude Code has today, and
  a change to the image. `cli/lib/agent.ts` is the seam for other agents.

### Notes for sub-project 2 (not designed here)

- GitHub Actions builds `agent-base` with `ansible/image.yml` and publishes
  it; `forge` (and `forge install`) downloads it.
- A local `forge image build` stays, for whoever changes the image role.

## Goals

- **The popup gets out of the way**: a successful `prefix+f` lands on the
  agent's tab without a keypress.
- **A failed provisioning is recoverable from `forge`**, with no raw `incus`
  command.
- **One command on the laptop installs and updates a host**, local (Lima) or
  remote, and ends with herdr attached. The only interactive moments are the
  ones a human must do: picking a key when several are loaded, `claude auth
  login`, and confirmations before touching the laptop's files.
- **Retrieval is two commands from the developer's own clone**: `forge fetch`
  to see the agents' branches, `forge ship <task>` to re-sign, push and open
  the PR.
- **Git LFS works when a repository asks for it**: the agent reads LFS files
  and can add or change them, and they reach GitHub through `forge ship`.

## Non-goals

- HTTP preview, GUI git clients (see "Left out of the chapter").
- `forge` commands that proxy the host commands from the laptop
  (`forge start` typed on the laptop). The laptop gets its own commands only;
  a host command typed there says where it runs *(implementer's call, see
  "One codebase, two sides")*.
- Installing the laptop's prerequisites (Lima, Ansible, herdr, Node, `gh`).
  `forge install` checks them and prints the command to run.
- **Adopting a host installed by hand** (the README's manual steps). The
  maintainer removes their own manual configuration and installs again;
  `forge install` refuses to touch a VM or an SSH block it did not create.
- **One host driven from several laptops.** One host, one laptop: the
  inventory's `ssh_keys` is authoritative, so a second laptop's install would
  revoke the first one's key.
- Multi-user hosts, Intel Macs, Windows: as in v2.

## Anti-goals

These would make the work a failure even if every test passed:

- **A laptop tool that changes the laptop without saying so**: no package
  installed, no `~/.ssh/config` edited, no file outside its own directory
  written without a confirmation.
- **A weaker boundary.** No credential, key or signing material enters a
  container or the image. The host still never runs git in a repository the
  agent writes. Signing happens on the laptop only.
- **Rewriting published history**: `forge ship` never force-pushes and never
  rewrites a commit already on GitHub.
- **A popup that closes over an error.**
- **A personal value in the repository** (login, host, path, identity), as in
  v2: everything personal comes from the laptop's environment or is asked.

## Decisions

| Topic | Decision | Source |
|---|---|---|
| Popup on success | Always closes, warnings included | The maintainer, 2026-10-20 (they do not read what holds it open) |
| Warnings and notices in the popup | Also shown as a herdr notification | The maintainer, 2026-10-20 |
| Popup on error | Stays open until Enter, as today | The maintainer, 2026-10-20 |
| The `git remote add …` hint after a new container | Removed; `forge fetch` replaces it | The maintainer, 2026-10-20 |
| Half-provisioned container | Recognised by a marker set at creation; `forge start` offers to recreate it, keeping the workspace and the mirror | The maintainer, 2026-10-20 |
| Install | One command on the laptop | The maintainer, 2026-10-20 |
| SSH configuration | A file of forge's own in `~/.ssh/config.d/`, included from `~/.ssh/config` | The maintainer, 2026-10-20 |
| SSH Include line | forge's file is `~/.ssh/config.d/agent-forge.config`; an existing `Include` that reads it for every host is enough, otherwise `install` adds `Include config.d/agent-forge.config` at the top of `~/.ssh/config`, after confirmation | The maintainer, 2026-10-21 ("c'est tout le point du config.d") |
| Laptop tool's language | The same TypeScript `forge`, run by Node 24 from the agent-forge checkout | Proposed; the maintainer accepted the Node 24 requirement on the laptop, reluctantly |
| Retrieval | `forge fetch` (sets up the remote, fetches), `forge ship <task>` (re-sign, push, PR) | The maintainer, 2026-10-20 |
| Where retrieval runs | In the developer's own clone of the repository, which they always have; no forge-managed copy on the laptop | The maintainer, 2026-10-20 |
| Agent's history | Kept as is: no squash | Proposed, accepted |
| Host names | `forge-local` for the Lima VM; `forge-<name>` for each remote VM, the name chosen at install | The maintainer, 2026-10-20 |
| Several hosts | Supported from the start: the maintainer expects one VM per client | The maintainer, 2026-10-20 |
| Hosts installed by hand | Not adopted: removed and installed again | The maintainer, 2026-10-20 |
| One host, several laptops | Out of scope: one host, one laptop | The maintainer, 2026-10-20 |
| Stacked tasks | A task may start from another task's `agent/<a>`; `forge ship` ships the whole chain under it, so the developer never has to ship the tasks of a chain one by one | The maintainer, 2026-10-20 |
| GitHub's SSH host keys | Written on the host in advance from GitHub's published keys, fetched over HTTPS; no more trust-on-first-use question in the popup | The maintainer, 2026-10-20 |
| herdr toasts | Turned on in the laptop's herdr config by `forge install`, not on the host | The maintainer, 2026-10-21 (real-host test) |
| LFS | Optional per repository; the agent reads **and writes** LFS files | The maintainer, 2026-10-20 |
| Command names (`install`, `open`, `fetch`, `ship`) | Provisional | Implementer's call |

This reverses one decision of the v2 local-mode spec
(`2026-10-18-v2-local-mode-docs-design.md`, "Setup: manual README steps …,
decided by the maintainer"): the maintainer now wants a setup command.

## Sub-project 1: fixes

### The popup closes on success

Today (`cli/forge.ts`, `withAttention`), a run in the herdr popup waits for
Enter when it wrote a `WARNING`/`NOTICE` line on stderr or called
`ctx.attention()`. The maintainer does not read those lines, so the wait is
pure friction.

New policy, for a run in the popup (`herdrEnv().popup`):

- **Success**: the process exits and the popup closes, whatever it printed.
- **Warnings and notices**: every `WARNING`/`NOTICE` line of the run is also
  sent as **one herdr notification** at the end of the run
  (`herdr notification show <title> --body <lines>`). Some of them matter:
  "refreshing the mirror from GitHub failed" means the task starts from stale
  code. Title, truncation of a long body, position and sound are the
  implementer's call.
- **`forge resume --all`**: its per-tab summary, which is its result, becomes
  the body of that notification instead of holding the popup.
- **Error** (an exception, a non-zero exit): unchanged, the popup prints the
  error and waits for Enter. There is no tab to land on, and the error is the
  only thing to read.
- **The provisioning hint** (the three `git remote add …` lines,
  `provision.ts`) is removed. Until sub-project 4 ships `forge fetch`, the
  README keeps documenting those three commands.
- Outside the popup (a terminal, a pane), nothing changes: the lines go to
  stderr as today. The agent tab's hold after a failed `forge attach` stays.

`herdr notification show` exists in herdr 0.9.5. If the call fails, forge
falls back to today's behaviour for that run (print and wait), so a warning is
never lost silently.

**Finding (2026-10-21, real host).** Tested with herdr 0.9.5 and a client
attached through `herdr --remote`: as soon as a client is attached,
`herdr notification show` always answers `shown: true`, whatever the
`[ui.toast]` setting of the host or the client. The toast is drawn only if the
**client's** herdr config (the laptop's `~/.config/herdr/config.toml`) has
`[ui.toast] delivery = "herdr"`; the host's config changes nothing (host
without toasts and client with them: toast shown; the other way round:
nothing). Without an attached client the server answers `shown: false`, with
reason `disabled` (host without toasts) or `no_foreground_client` (host with
them). So turning toasts on from `forge setup`'s host block (the plan's Task
7) is useless. Decision A (the maintainer): the setting lives on the laptop;
`forge install` (sub-project 3) turns it on in the laptop's herdr config,
after confirmation, unless the user already sets `[ui.toast]`; the README
explains it for a manual install. Remaining risk, documented: with toasts off
on the laptop, the popup's warnings go unseen, herdr answering `shown: true`
anyway.

### A half-provisioned container

Today a provisioning that fails after `incus launch` leaves a container
without `user.forge.repo`, which is written last. The next `forge start`
treats it as a name collision (`checkNameCollision`, `containers.ts`) and
prints a raw `incus --project agent-forge delete --force …` command;
`requireHookBlocks` does the same.

New behaviour:

- **A marker at creation.** The container is launched with a config key that
  names the repository being provisioned (for example
  `user.forge.provisioning=<owner/repo>`, set by `incus launch --config`, so
  it exists from the first instant). `user.forge.repo` stays the last key
  written; the marker is removed after it. The exact key and whether it also
  records the workspace's origin (see below) are the implementer's call.
- **`forge start` on such a container** (marker present, no
  `user.forge.repo`, same repository): it says that the previous provisioning
  did not finish and asks whether to recreate the container. Yes deletes the
  instance and provisions again; no stops with the command that does it
  (`forge delete <owner/repo>`). The question works in the popup.
- **`forge delete <owner/repo>`** accepts a half-provisioned container (with
  the marker, or with no forge metadata at all, after a confirmation for the
  latter), so no message ever points at raw `incus` again. The message in
  `requireHookBlocks` points at `forge delete` too.
- **The workspace and the mirror are kept**, as `forge delete` keeps them. A
  workspace that existed before the failed provisioning (kept from an earlier
  `forge delete`) may hold the only copy of unretrieved work: it is never
  removed. A workspace the failed provisioning created itself may hold a
  partial clone; re-provisioning must cope with it (for example by emptying
  it when the marker says the provisioning created it). The implementer picks
  the mechanism; the rule is that nothing that existed before the failed
  attempt is deleted.
- A marker for another repository is a collision, as today.

## Sub-project 3: guided install

### One codebase, two sides

`forge` gains **laptop commands**: `install`, `open` (this sub-project),
`fetch` and `ship` (sub-project 4). They run from the agent-forge checkout on
the developer's machine: `./cli/forge install` the first time. `forge install`
then offers to link `~/.local/bin/forge` to the checkout's `cli/forge`
(asking first, and printing the `PATH` line if `~/.local/bin` is not on it).

- The host commands keep running on the host, deployed by the playbook as
  today.
- Each command knows its side. A host command typed on the laptop, or a laptop
  command typed on the host, stops with one line saying where it runs (for
  `forge start` on the laptop: "press prefix+f in herdr, `forge open`
  attaches it"). How a run tells the two sides apart is the implementer's
  call. One signal already exists: the playbook installs forge under
  `/opt/agent-forge/releases/<sha>` (`ANSIBLE_RELEASES`, `cli/lib/host.ts`,
  used by `forge setup`'s bare-metal warning), while the laptop runs it from a
  git checkout.
- The laptop side requires Node 24, like the host; `cli/forge` already checks
  it.

### Laptop state

Under `~/.config/agent-forge/` on the laptop, with names distinct from the
host's `config.json` and `egress-allowlist`:

- a list of the hosts this laptop installed: name (the SSH alias), kind
  (local Lima or remote), and what `install` needs to re-run (inventory path,
  Lima instance name);
- one generated inventory per host.

Nothing of it goes in the repository.

**Host names and several hosts.** The Lima VM is `forge-local`. Each remote
VM is `forge-<name>`, `<name>` asked at install (the maintainer expects one VM
per client). The name is the SSH alias, the herdr target and the `--host`
value. With one host, every laptop command uses it. With several, `--host
<name>` selects one; without it, `forge fetch` in a clone whose remote is
already set uses that remote's host (the clone remembers its VM), and
otherwise the command asks *(implementer's call on the exact rule)*.

**Only what forge created.** `install` acts only on hosts in this list. A Lima
instance named `forge-local`, or an SSH `Host` entry with the chosen name,
that forge did not create (a manual install from the README) stops `install`
with what to remove. For a VM, that message comes with a reminder to retrieve
its work first, since its workspaces live inside it.

### `forge install` (local, the default)

The steps, each skipped when already done, so a re-run picks up after a
failure:

1. **Prerequisites.** `limactl` (2.1.2 or newer), `ansible-playbook`
   (ansible-core 2.20 or newer), `herdr`, `git`, `ssh-agent` with at least one
   key. A missing one stops the run with the command to install it (`brew
   install …` on macOS, the README's lines on Ubuntu).
2. **The key.** `ssh-add -L`; with several keys, the developer picks the one
   GitHub accepts.
3. **The VM.** `limactl create --tty=false --name forge-local
   ansible/lima/forge.yaml`, then `limactl start`. If the SSH port the
   template forwards (60022) is taken, `install` picks a free one and passes it
   with `--set '.ssh.localPort = <port>'`, then uses it in the inventory and
   the SSH configuration. Never Lima's `0`, which changes the port at each
   start. `ansible/tests/vm-test.sh` already does all of this (free port,
   `--set`, reading the port and the admin login back with `limactl list
   --format`, the admin key under `${LIMA_HOME:-~/.lima}/_config/user`,
   waiting for SSH and cloud-init): `install` mirrors it.
4. **The inventory.** Generated from the laptop, from
   `ansible/inventory.lima.example.yml`'s shape: `ansible_user` from the Lima
   admin login, the Lima admin key, `HostKeyAlias=forge-local-admin` with
   `accept-new`, `forge_exposure: local`, the port, and one forge user named
   `forge` (it must differ from `ansible_user`) whose `ssh_keys` is the chosen
   key. `ssh_keys` is authoritative: the playbook removes keys added by hand.
5. **The playbook.** `ansible-galaxy collection install -r
   ansible/requirements.yml`, then `ansible-playbook -i <inventory>
   ansible/site.yml` from the checkout (which deploys the checkout's `forge`).
6. **SSH.** Writes `~/.ssh/config.d/agent-forge.config` with the forge user's
   block (`HostName`, `Port`, `User`, `HostKeyAlias`, `ForwardAgent yes`), one
   block per installed host. The admin connection needs no block: it lives in
   the inventory (`ansible_ssh_common_args`), as today. OpenSSH reads
   `config.d/` only through an `Include`. An `Include` already in
   `~/.ssh/config` that matches forge's file (OpenSSH's glob: `config.d/*`,
   `~/.ssh/config.d/*.config`, …) and applies to every host (at the top level,
   under `Match all`, or under `Host *`) is enough: `~/.ssh/config` is not
   edited. ssh keeps the first value it reads, so settings placed before that
   `Include` would win over forge's block: `install` checks with `ssh -G
   <alias>` that forge's values are in effect, and when one of the
   developer's wins it names it and asks for the top-of-file `Include` below
   (review of #86, 2026-10-22). Otherwise `install` asks, then adds `Include
   config.d/agent-forge.config` **at the top** of `~/.ssh/config` (an
   `Include` below a `Host` line would only apply to that host). The
   maintainer, 2026-10-21: "c'est tout le point du config.d". forge rewrites
   its own file freely and never edits anything else in `~/.ssh/config`. When the
   developer's GitHub key lives in another agent (a hardware key's, a password
   manager's), the block carries the `IdentityAgent` the developer's SSH uses
   for it *(implementer's call on how it is detected or asked)*.
   `install` also turns herdr's toasts on in the laptop's herdr config
   (`~/.config/herdr/config.toml`): a block of its own, delimited, after
   confirmation, unless the laptop's config already sets `ui` or `[ui.toast]`
   (see sub-project 1, Finding).
7. **The host's account.** Over SSH, as the forge user:
   - the git identity: the laptop's `git config --global user.name` and
     `user.email`, set on the host if missing; asked if the laptop has none;
     a different identity already on the host is kept unless the developer
     says otherwise;
   - `claude auth login` with a TTY (`ssh -t`), only when
     `~/.claude/.credentials.json` is missing. This is the one step where the
     developer pastes a code from the browser.
8. **The runtime.** `forge setup`, then `forge image build` when `agent-base`
   is missing or older than the checkout's image inputs. Nothing computes
   that today: the image's `user.forge.commit` is the whole repository's
   commit, so every commit makes it differ, and the host's release has no
   `.git`. The laptop does have the checkout's history, so it can decide, for
   example by checking that the last commit touching the image's inputs
   (`ansible/image.yml`, `ansible/roles/forge_image/`, whatever else the build
   reads) is an ancestor of the image's `user.forge.commit`. The exact rule is
   the implementer's call; when in doubt, `install` asks rather than spending
   10 minutes in silence.
9. **herdr.** `forge open`. The first attach installs herdr on the host
   (herdr's own question).

**GitHub's host keys.** Today nothing pre-seeds them: the first `prefix+f` on
a repository shows ssh's host-key question inside the popup (`ensureMirror`,
`cli/lib/mirror.ts`), and answering `yes` trusts whatever key comes first. The
maintainer prefers verified keys (2026-10-20):

- GitHub's SSH host keys are fetched over HTTPS from GitHub's published list
  (`https://api.github.com/meta`, field `ssh_keys`), so their trust rests on
  TLS rather than on the first connection;
- they are written for `github.com` into the forge user's `known_hosts` on the
  host, replacing any older `github.com` entries there;
- no key is stored in the repository, and each re-run of `install` refreshes
  them, so a rotation by GitHub (as in 2023) is followed;
- a failed fetch stops the run with the error; it never falls back to
  trust-on-first-use.

Whether the playbook fetches them (on the controller, so the manual path gets
them too) or `install` fetches them and passes them to the playbook is the
implementer's call. Writing them is the playbook's job either way: it is the
host OS's configuration (the boundary rule of `CLAUDE.md`). The README's
troubleshooting entry about this question goes.

It ends with a short summary: the host's name, what was done, what was
already there.

### `forge install --remote <address>`

The same, without step 3. It asks for what it cannot guess: the admin account
Ansible logs in with (default `ubuntu`), `forge_exposure` (`public` or `lan`),
the forge user's name (default: the laptop login), and the host's `<name>`
(the alias becomes `forge-<name>`). The first SSH connection to a new host
shows OpenSSH's own host-key question, as the manual path does.

- The admin account is assumed to have passwordless sudo, as on cloud images.
  The sudo-password case (`ansible_become_exe: sudo.ws` and a vaulted
  password, `ansible/inventory.example.yml`) stays a manual inventory edit,
  documented in `ansible/README.md` *(implementer's call)*.
- **The admin key.** Cloud images are often set up with a key the provider
  generated, not the developer's GitHub key. `install` asks which key the
  admin account accepts: by default the key chosen in step 2, otherwise a
  private key file (`ansible_ssh_private_key_file`). A key that exists only
  in an agent (a hardware key) has its public half written under the laptop
  state, so that `IdentityFile` can name it. sshd allows two authentication
  attempts (`MaxAuthTries 2`) and, on `public`, fail2ban bans after repeated
  failures: the generated inventory offers exactly that one key
  (`IdentitiesOnly=yes`). *(Implementer's call, settled here.)*
- The other playbook options (`forge_ssh_port`, `forge_ssh_allowed_sources`,
  storage, fail2ban) keep their defaults; whoever needs them edits the
  generated inventory, and `install` keeps those edits on a re-run
  *(implementer's call on how)*.

### Re-running is updating

After a `git pull` of agent-forge, `forge install` (or `forge install --host
<name>`) on an existing host re-runs the playbook (which deploys the new
`forge`), `forge setup`, and the image build when the image role changed. The
README's "Updating" section becomes that one line.

### `forge open`

`herdr --remote <alias> --remote-keybindings server`, with the alias of the
selected host.

### README

The local quick start and the remote section become: clone, install the
prerequisites, `./cli/forge install`, press `prefix+f`. The manual steps move
to `ansible/README.md` (or a "What `forge install` does" section) for whoever
wants them *(implementer's call)*. "Updating" and "Get the work back" are
rewritten (the latter by sub-project 4).

## Sub-project 4: daily work loop

### `forge fetch`

Run in the developer's own clone of the repository.

- It reads `origin`'s URL (`git@github.com:<owner>/<repo>.git` or the HTTPS
  form) to get `<owner>/<repo>`, and derives the container name with the same
  code the host uses (`sanitizeContainerName`).
- It adds the remote `<container>` → `<alias>:<container>` with
  `remote.<container>.uploadpack = "forge upload-pack <container>"` if it is
  missing, or fixes it if it points elsewhere.
- It runs `git fetch <container>`. The agents' branches appear as
  `<container>/agent/<task>`. It then lists them, with how many commits each
  is ahead of its base.

The fetch path is v2's, unchanged: `forge upload-pack` serves the repository
from inside the container, and the host runs no git in the workspace.

### `forge ship <task>`

Run in the same clone, after the developer has reviewed the branch.

1. **Fetch** first, as `forge fetch`.
2. **The base.** What the task started from. `forge start` does not record it
   today (`addWorktree` starts from `origin/main`, a named ref, or an existing
   branch): it now records it at task creation, and the laptop reads it over
   SSH (through a small host command, for example). The base is one of:
   - `main` (the default, `origin/main`);
   - **another task** of the same container, when the ref is its
     `agent/<a>` (see "Stacked tasks");
   - another ref: a branch that exists on GitHub is the PR's base; a tag or a
     SHA gives `main` as the PR's base, after a confirmation.

   A task with no recorded base (created before this change) uses `main`,
   after a confirmation. *(The recording and the read are the implementer's
   call.)*
3. **Re-sign.** The agent's commits not yet shipped (those of
   `<container>/agent/<task>` that are neither on the base nor already on
   GitHub's `origin/agent/<task>` by patch) are replayed **on top of GitHub's
   `origin/agent/<task>`** when it exists, on top of the base otherwise, and
   signed with the developer's own signing configuration. Authors stay; the
   content does not change. This happens in a temporary worktree, never in the
   developer's checkout, which may be dirty or on another branch. Depending on
   the key, each commit may need a touch (a YubiKey, for example); `ship` says
   how many commits it will sign before starting.
4. **Push** `agent/<task>` to `origin`. Because the replay starts from
   GitHub's branch, the push is always a fast-forward. **Never a force-push.**
   Commits that reached GitHub's branch from outside the agent (a review
   suggestion, "Update branch", a fix the developer pushed) become the parent
   of the replay. If the replay conflicts, `ship` stops, leaves GitHub as it
   was, and says which commit conflicts. *(Implementer's call, settled here:
   the agent's branch in the container stays as it is; to hand the agent
   GitHub's branch, start a new task from it.)*
5. **The PR.** None open for the branch: `gh pr create --base <base> --head
   agent/<task>`, title and body filled from the commits *(implementer's
   call)*, and the URL printed. One already open: the push updated it; the URL
   is printed.
6. The developer's local branch `agent/<task>`, if any, is left alone, or
   fast-forwarded when that is possible *(implementer's call)*.

**Shipping twice.** After a ship, the agent keeps its unsigned commits in the
container, and GitHub has their signed copies. When the agent works on, the
next `ship` signs and pushes only the new commits, replayed onto GitHub's
branch (the commits whose patch is already there are dropped). The
implementer must cover this case, and the outside-commit and conflict cases,
in the tests.

**Stacked tasks.** The maintainer starts tasks from other tasks' branches
(task B from `agent/a`, in the container, through "other branch…") and must
never be the bottleneck of a chain of PRs (2026-10-20). So:

- `forge ship b` ships **the whole chain under B**, from the bottom: A first
  (if it has commits not yet shipped), then B. The developer can let A, B, C
  pile up and ship only the top one, or ship any task of the chain at any
  time.
- A task's **own commits** are those on its branch in the container that are
  not on its base task's branch in the container. This keeps the definition
  independent of what GitHub did with A (signed copies, a squash merge).
- Each task's own commits are replayed on top of the GitHub branch of the
  task below it (A's signed `agent/a`), then signed, then pushed, as in steps
  3 and 4. So A's unsigned commits never reach GitHub through B, and are never
  signed twice into B's PR.
- B's PR targets `agent/a`; the bottom task's PR targets its own base. When
  A's PR is already merged and its branch is gone, B's own commits are
  replayed onto A's base instead, and B's PR targets that base
  *(implementer's call on how a merged task is detected)*.
- A conflict anywhere stops the chain at that task, leaving the tasks above it
  unshipped and GitHub consistent.
- Starting B on top of A could get its own entry in `forge start`'s menu
  ("new task on top of <a>"), next to "other branch…" *(implementer's call,
  proposed)*.

`gh` becomes a laptop prerequisite for `ship` (checked by `ship`, not by
`install`).

### Git LFS, optional

Today the mirror holds no LFS object, the container clones with
`GIT_LFS_SKIP_SMUDGE=1` (`mirror.ts`), and LFS files stay pointers.

**Turning it on.** Per repository. At the first `forge start` of a repository
whose `.gitattributes` uses the LFS filter, forge asks whether to fetch LFS
files for the agent, and records the answer on the container. A command (or a
flag) changes it later *(implementer's call)*.

**Read.** When it is on:

- the host fetches the LFS objects into the mirror, with the developer's
  forwarded agent, at provisioning and at each `forge start` (which refs is
  the implementer's call: the base branch and `origin/agent/*` are the useful
  ones);
- the container gets LFS content from the read-only mirror, through
  git-lfs's local-path transfer, and checks it out normally (no
  `GIT_LFS_SKIP_SMUDGE`). No credential enters the container, and strict
  containers need no new allowlist entry, since nothing goes to the network.

**Write.** The agent commits LFS files normally: the filters are already
installed (`git lfs install --skip-repo`). The new LFS objects must reach
GitHub through `forge ship`, before the git push. Two candidate mechanisms,
to be settled by a **spike** before the plan's LFS tasks:

- an LFS equivalent of `forge upload-pack`: the laptop's git-lfs downloads the
  objects from the container through a forge host command that runs inside
  the container;
- the host copies the new objects out of the container, checks that each
  file's SHA-256 is its object id, and uploads them to GitHub from the mirror
  with the forwarded agent.

Constraints on both: no credential in the container; the host never runs git
in the workspace; every object is checked against its id before it leaves the
host.

**Off.** Today's behaviour: pointers, and a commit that touches an LFS file
keeps a pointer.

The README's "Large files" line is rewritten accordingly.

## Testing

- **Unit tests**, with the existing fakes (fake `incus`, fake herdr) and new
  ones for the laptop side: `limactl`, `ansible-playbook`, `ssh`, `git`, `gh`.
  They fit `tests/lib/fake-context.ts`'s rule table, with two limits to keep
  in mind: an unmatched non-incus call succeeds silently, and one `attachCode`
  answers every `attach`. Files the laptop side writes (`~/.ssh/`, the
  inventory, the laptop state) go through path overrides and temporary
  directories, as `paths.ts` does for the host.
  The popup policy (success, warning, error, notification failure), the
  half-provisioned paths (same repository, other repository, no metadata,
  reused workspace), the SSH `Include` placement, the inventory generation,
  the re-run after each failed step, the refusal of a VM or SSH entry forge
  did not create, several hosts and `--host`, the GitHub host keys (written,
  refreshed, fetch failure), the `ship` cases (first ship, second ship after
  more agent commits, outside commits on GitHub's branch, a conflicting
  replay, no base recorded, a chain of two and three tasks shipped from the
  top, a chain whose bottom task is already merged).
- **Integration** (`FORGE_INTEGRATION=1`, a disposable Incus): the marker and
  recreate flow; LFS read and write against a test repository.
- **End to end**: `forge install` on a fresh Lima VM through
  `ansible/tests/vm-test.sh --lima` or a new mode of it *(implementer's
  call)*.
- **The maintainer's walk-through**: on the Mac, `forge install` from a fresh
  clone, a task from `prefix+f`, then `forge fetch` and `forge ship` with the
  YubiKey. Only the maintainer can run the credentialed steps.

## Delivery

- One pull request per sub-project, in the order 1, 3, 4, from `agent/<task>`
  branches off `main`, `--base main`. The LFS part of 4 may be its own pull
  request after its spike.
- Commits are signed with the maintainer's YubiKey: the maintainer is present when they
  are made.
- `CLAUDE.md` and `README.md` are updated in the pull request that changes
  what they describe.
