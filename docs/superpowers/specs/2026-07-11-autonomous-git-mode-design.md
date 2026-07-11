# Autonomous Git Mode — Design

**Date:** 2026-07-11
**Status:** Approved pending user review
**Sub-project:** 1 of 3 in the agent-forge DX overhaul

## Context

agent-forge runs Claude Code agents in isolated LXD containers on a dedicated
Ubuntu server. Today the agent can commit locally (signed as the bot) but the
`pre-bash.sh` hook hard-blocks `git push`, the deploy key is read-only, and
there is no PR flow. Getting agent work onto GitHub requires manual
intervention every time.

The DX overhaul was decomposed into three sub-projects:

1. **Autonomous git mode** (this spec) — agent pushes its branch and opens a
   PR by itself.
2. **Supervised git mode** — for sensitive repos: container gets no write
   credential at all; the user fetches the agent's local commits (the
   workspace already lives on the host), rebases with `--reset-author`,
   YubiKey-signs, and pushes under their own identity, from the host or
   laptop. Bot identity never appears in these repos' history.
3. **Repo registry + `forge` CLI + session visibility** — central config
   mapping repo → mode → credentials, a single `forge` command with bash
   completion replacing the loose scripts, and at-a-glance agent status.

This ordering was chosen so future agent-forge work can itself run through
autonomous mode.

## Decisions

| Decision | Choice |
|---|---|
| Mode granularity | Per repo, fixed policy. Formalized later by the registry; in this sub-project the mode is implicit (this script provisions autonomous containers) and the repo is an explicit argument. |
| Credential | Fine-grained PAT on the **bot account**, scoped to the single target repo. Permissions: Contents read/write, Pull requests read/write, Metadata read. Max expiry (1 year). |
| Token creation | Web UI of the bot account, from the user's laptop. The user's personal credentials never touch the host or containers. (GitHub exposes no API to mint fine-grained PATs, so this step is inherently manual.) |
| Token storage | **Paste per container.** `new-agent-container.sh` prompts for the token at creation and pipes it into `gh auth login --with-token` inside the container. The token is never written to host disk. |
| Push/PR plumbing | `gh auth setup-git` makes the one token serve both git-over-HTTPS and `gh pr create`. The SSH deploy key is removed from autonomous containers. |
| Identity | Pushes and PRs appear as the bot. The user reviews and approves as themselves, keeping required-review branch protection usable (GitHub forbids approving your own PR). The SSH signing key stays; commits remain signed as the bot. |

## Design

### Credential & auth flow

Per target repo, once: create a fine-grained PAT on the bot account (web UI,
laptop), scoped to that repo with Contents RW + Pull requests RW + Metadata R.
The bot account must be a collaborator with write access on the repo.

Per container, at creation: `new-agent-container.sh` pauses with a clear
banner, reads the token from stdin (no echo), and runs inside the container:

```
gh auth login --hostname github.com --with-token   # token on stdin
gh auth setup-git
```

From then on the agent pushes over HTTPS and opens PRs with `gh`, all with the
one token. No GitHub write credential ever exists on the host.

Token renewal (fine-grained PATs expire ≤ 1 year): create a new PAT in the web
UI and re-run the same `gh auth login --with-token` inside the affected
container via `lxc exec`. Documented in README; no tooling in this
sub-project.

### `new-agent-container.sh` changes

New usage: `new-agent-container.sh <project-name> <owner/repo>`.

- The repo is an explicit argument. The current detection hack (`ssh -T
  git@github.com` + parsing the deploy-key greeting) is removed.
- The deploy-key push (`github_agents` → `id_ed25519`) is removed. The
  signing-key push stays.
- New interactive step: prompt for the bot PAT, feed it to `gh auth login
  --with-token`, then `gh auth setup-git`.
- Clone becomes `git clone https://github.com/<owner/repo>.git /workspace`,
  then create branch `agent/<project-name>` as today.
- Precondition checks at the top (per repo conventions): both args present,
  `agent-base` image exists, container name not already taken.

### Base image

Add the `gh` CLI (official GitHub apt repo) to the base-image build steps in
README, with a note that `agent-base` must be rebuilt for autonomous
containers to work.

### Guardrails

Server-side enforcement is primary; the hook is defense-in-depth.

**Branch protection (setup prerequisite, documented in README):** on each
autonomous repo, protect `main`: require a pull request with at least one
approval before merging. This is the real boundary — even a leaked token
cannot land code on `main`.

**`pre-bash.sh` hook changes:**

- Replace the blanket `git push` block with:
  - **allow** pushes whose target is `agent/*` on `origin` (covers
    `git push origin agent/x`, `git push -u origin agent/x`);
  - **block** force pushes (`-f`, `--force`, `--force-with-lease`);
  - **block** branch deletion (`--delete`, `-d`, `:ref` refspecs);
  - **block** any push not explicitly targeting `origin agent/*`
    (default-deny, consistent with the hook's style).
- New blocks: `gh pr merge`, `gh api`, `gh repo` — the agent creates and
  updates PRs, never merges, never talks to the raw API.
- All existing blocks stay (checkout main, merge, rebase, hooksPath, rm -rf,
  sudo, curl/wget upload whitelist).

**`templates/CLAUDE.md` rewrite (git section):** stay on `agent/<project>`;
signed conventional commits; push the branch with `git push -u origin
agent/<project>`; open a PR with `gh pr create --base main`; never merge;
address review feedback by pushing new commits to the same branch.

### README updates

- Autonomous-mode workflow section (PAT creation walkthrough, container
  creation, PR flow, token renewal).
- Branch-protection prerequisite.
- `gh` added to base-image build; rebuild note.
- Remove/adjust the deploy-key section: the read-only deploy key is no longer
  used by autonomous containers (it returns in supervised mode as the
  fetch-only credential; note kept for context).

## Verification checklist (run on the server, not the laptop)

This repo is edited on the laptop; the LXD host is the server. After applying
the changes there, on a scratch repo:

1. Fine-grained PAT on the bot account can target a repo owned by the user
   (bot as write collaborator). **Open risk:** cross-owner support for
   fine-grained PATs is recent; if it fails, fall back to a classic PAT
   (`repo` scope) on the bot — same effective boundary since the bot is only
   invited to agent-approved repos.
2. `new-agent-container.sh test-project <owner/scratch-repo>` end to end:
   paste PAT, clone succeeds, branch `agent/test-project` created.
3. Inside the container: commit, `git push -u origin agent/test-project`,
   `gh pr create --base main` all succeed; the PR shows the bot as author and
   commits show **Verified**.
4. Hook blocks each forbidden case: `git push origin main`, `git push
   --force origin agent/test-project`, `git push origin :agent/test-project`,
   `gh pr merge`, `gh api user`, `gh repo view`.
5. With branch protection on, confirm the bot cannot merge its own PR and the
   user can approve and merge.

## Out of scope

- **Supervised mode** (sub-project 2): fetch-only credential, user-side
  rebase/re-author/sign/push flow, `forge review` helper. Nothing in this
  spec grants supervised repos any write credential.
- **Repo registry, `forge` CLI, bash completion** (sub-project 3): until
  then, mode is implied by which script you run and the repo is a CLI
  argument.
- **Session visibility / notifications** (sub-project 3).
- Automated PAT renewal tooling.
