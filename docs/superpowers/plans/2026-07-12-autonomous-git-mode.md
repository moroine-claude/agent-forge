# Autonomous Git Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agent containers push their `agent/*` branch to GitHub and open PRs by themselves, authenticated as the bot account via a per-container fine-grained PAT.

**Architecture:** `new-agent-container.sh` gains a `<owner/repo>` argument, drops the read-only SSH deploy key, prompts for a bot PAT at creation time (piped into `gh auth login --with-token` inside the container, never written to host disk), and clones over HTTPS. The `pre-bash.sh` hook replaces its blanket `git push` block with a default-deny policy that only allows `git push [-u] origin agent/*`, and blocks `gh pr merge` / `gh api` / `gh repo`. Server-side branch protection on `main` is the primary boundary; the hook is defense-in-depth.

**Tech Stack:** Bash, LXD (`lxc`), GitHub CLI (`gh`), jq (in hook + tests).

**Spec:** `docs/superpowers/specs/2026-07-11-autonomous-git-mode-design.md`

## Global Constraints

- Bash strict mode: `set -e` mandatory in every script.
- Variables always quoted: `"$VAR"`, never `$VAR`.
- Precondition checks at the top of scripts (verify a container/image exists before using it).
- Never hardcode credentials, keys, or tokens. The PAT is pasted at container creation and **never written to host disk**.
- PAT spec, verbatim: fine-grained PAT on the **bot account**, scoped to the single target repo, permissions **Contents read/write, Pull requests read/write, Metadata read**, max expiry (1 year).
- Git: work stays on branch `agent/agent-forge`; conventional commit messages (`feat:`, `fix:`, `chore:`, `docs:`); commits are auto-signed; **never push, never touch `main`** (per this repo's CLAUDE.md — the autonomous-push behavior being built here is for *agent containers*, not for the engineer executing this plan).
- This repo is edited on the laptop (macOS); the LXD host is the server. Nothing involving `lxc`/`gh`/containers can be executed locally. Locally testable: the hook (stdin/stdout contract, needs only `jq`) and `bash -n` syntax checks. Everything else is verified on the server (Task 6).
- The hook's regexes are POSIX ERE (`grep -qE`, `[[:space:]]` classes) — **never `grep -P` or `\s`** — so the same file works under BSD grep (laptop tests) and GNU grep (Ubuntu containers). macOS `/usr/bin/grep` has no `-P`; with it every `grep -qP` silently returns false and the hook would allow everything.
- Hook user-facing messages are in French, matching the existing hook style. Script `echo` messages are in English, matching the existing script style.

## File Structure

| File | Responsibility |
|---|---|
| `.claude/hooks/pre-bash.sh` (modify) | Per-command guardrails inside the container: git push policy, gh command blocks, existing blocks (checkout main, merge, rebase, hooksPath, rm -rf, sudo, curl/wget). |
| `tests/test-pre-bash.sh` (create) | Local test harness for the hook: feeds JSON commands on stdin, asserts allow (exit 0) vs block (exit 2). |
| `scripts/new-agent-container.sh` (modify) | Provisions an autonomous container: preconditions, workspace mount, signing key, git config, hooks, PAT auth, HTTPS clone. |
| `templates/CLAUDE.md` (modify) | Instructions given to the agent inside the container — git/PR workflow. |
| `README.md` (modify) | Operator documentation: base image build (adds `gh`), PAT walkthrough, branch protection prerequisite, usage, token renewal. |

---

### Task 1: Hook — default-deny push policy + POSIX-ERE portability

**Files:**
- Create: `tests/test-pre-bash.sh`
- Modify: `.claude/hooks/pre-bash.sh` (full rewrite — the file is 64 lines: the `git push` block is replaced by the new policy, and every existing pattern is converted from `grep -qP`/`\s` to `grep -qE`/`[[:space:]]` with identical semantics, so the hook is testable with BSD grep; see Global Constraints)
- Test: `tests/test-pre-bash.sh`

**Interfaces:**
- Consumes: `.claude/hooks/pre-bash.sh` reads JSON on stdin (`{"tool_input":{"command":"..."}}`), exits `0` to allow, exits `2` with `BLOCKED: <reason>` on stdout to block. The existing `block()` function takes one argument (the reason) and handles logging + exit.
- Produces: `tests/test-pre-bash.sh` runnable as `bash tests/test-pre-bash.sh`, exposing helpers `expect_allow "<command>"` and `expect_block "<command>"` that Task 2 extends with more cases. Push policy: only `git push [-u] origin agent/<branch>` (optionally as a `&&`/`;` chained segment) is allowed; force pushes, deletions/refspecs, and any other push are blocked. Task 2 must write its patterns in the same POSIX-ERE style.

- [ ] **Step 1: Write the failing test harness**

Create `tests/test-pre-bash.sh` with this exact content:

```bash
#!/bin/bash
# Tests du hook pre-bash.sh.
# Simule Claude Code : envoie {"tool_input":{"command":...}} sur stdin
# et vérifie allow (exit 0) vs block (exit 2).
# Prérequis : jq. Lancer : bash tests/test-pre-bash.sh
# (le hook n'utilise que grep -E POSIX : fonctionne avec BSD grep comme GNU grep)
set -e

HOOK="$(cd "$(dirname "$0")/.." && pwd)/.claude/hooks/pre-bash.sh"
PASS=0
FAIL=0

run_hook() {
  printf '{"tool_input":{"command":%s}}' "$(jq -Rn --arg c "$1" '$c')" \
    | bash "$HOOK" > /dev/null 2>&1
}

expect_allow() {
  local rc=0
  run_hook "$1" || rc=$?
  if [ "$rc" -eq 0 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu ALLOW, rc=$rc): $1"
  fi
}

expect_block() {
  local rc=0
  run_hook "$1" || rc=$?
  if [ "$rc" -eq 2 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu BLOCK, rc=$rc): $1"
  fi
}

# --- git push : seule forme autorisée = git push [-u] origin agent/* ---
expect_allow 'git push origin agent/test-project'
expect_allow 'git push -u origin agent/test-project'
expect_allow 'cd /workspace && git push -u origin agent/foo'

expect_block 'git push'
expect_block 'git push origin main'
expect_block 'git push upstream agent/test-project'
expect_block 'git push -f origin agent/test-project'
expect_block 'git push --force origin agent/test-project'
expect_block 'git push --force-with-lease origin agent/test-project'
expect_block 'git push origin agent/test-project --force'
expect_block 'git push origin --delete agent/test-project'
expect_block 'git push -d origin agent/test-project'
expect_block 'git push origin :agent/test-project'
expect_block 'git push origin main:agent/test-project'
expect_block 'git push origin agent/test-project main'

# --- commandes ordinaires : toujours autorisées ---
expect_allow 'git status'
expect_allow 'git commit -m "feat: x"'
expect_allow 'ls -la /workspace'

# --- régression : blocages existants toujours actifs ---
expect_block 'git checkout main'
expect_block 'git merge feature-x'
expect_block 'git rebase main'
expect_block 'sudo apt install foo'
expect_block 'rm -rf /workspace'

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bash tests/test-pre-bash.sh`
Expected: FAIL — the three `expect_allow 'git push …'` cases fail (current hook blocks all pushes), everything else passes. Output ends with `PASS: 20  FAIL: 3` and exit code 1.

- [ ] **Step 3: Rewrite the hook (push policy + ERE conversion)**

Replace the entire content of `.claude/hooks/pre-bash.sh` with the following. Semantics of the pre-existing blocks are unchanged — only their syntax moves from `grep -qP`/`\s`/`\S` to `grep -qE`/`[[:space:]]`/`[^[:space:]]` (BSD grep has no `-P`; see Global Constraints). The new part is the git push policy.

```bash
#!/bin/bash
# Claude Code pre-bash hook
# Bloque les commandes dangereuses avant exécution et journalise toutes les commandes.
# Input: JSON via stdin avec .tool_input.command
# Regex en ERE POSIX (grep -E) uniquement — jamais grep -P/\s : portable
# entre BSD grep (tests sur macOS) et GNU grep (containers Ubuntu).

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Journal d'audit persistant dans le workspace (survit à la suppression du container côté host)
AUDIT_LOG="/workspace/.claude/bash-audit.log"
mkdir -p "$(dirname "$AUDIT_LOG")" 2>/dev/null
printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$COMMAND" >> "$AUDIT_LOG" 2>/dev/null

block() {
  printf '%s\tBLOCKED\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$COMMAND" >> "$AUDIT_LOG" 2>/dev/null
  echo "BLOCKED: $1"
  exit 2
}

# Politique git push : default-deny.
# Seule forme autorisée : git push [-u] origin agent/<branche>
# (éventuellement comme segment d'une chaîne && ou ;).
# La vraie frontière est la branch protection sur main côté GitHub ;
# ce hook est de la défense en profondeur.
if echo "$COMMAND" | grep -qE 'git[[:space:]]+push'; then
  # Force push interdit (préserve l'historique de la branche agent)
  if echo "$COMMAND" | grep -qE 'git[[:space:]]+push[^;&|]*[[:space:]](-[A-Za-z]*f[A-Za-z]*|--force(-with-lease)?(=[^[:space:]]+)?)([[:space:]]|$)'; then
    block "git push --force non autorisé."
  fi
  # Suppression de branche distante interdite (--delete, -d, refspec :ref)
  if echo "$COMMAND" | grep -qE 'git[[:space:]]+push[^;&|]*[[:space:]](--delete|-[A-Za-z]*d[A-Za-z]*)([[:space:]]|$)' \
     || echo "$COMMAND" | grep -qE 'git[[:space:]]+push[^;&|]*[[:space:]][^[:space:]]*:'; then
    block "Suppression de branche distante / refspec non autorisée."
  fi
  # Default-deny : tout push qui n'est pas exactement origin agent/* est bloqué
  if ! echo "$COMMAND" | grep -qE '(^|[;&|][[:space:]]*)git[[:space:]]+push[[:space:]]+(-u[[:space:]]+)?origin[[:space:]]+agent/[A-Za-z0-9._/-]+[[:space:]]*([;&|]|$)'; then
    block "git push autorisé uniquement vers origin agent/*."
  fi
fi

# Bloquer le passage sur main/master
if echo "$COMMAND" | grep -qE 'git[[:space:]]+(checkout|switch)[[:space:]]+(main|master)'; then
  block "Passage sur main/master non autorisé. Rester sur la branche agent/*."
fi

# Bloquer git merge
if echo "$COMMAND" | grep -qE 'git[[:space:]]+merge([[:space:]]|$)'; then
  block "git merge non autorisé. Ouvrir une PR à la place."
fi

# Bloquer git rebase
if echo "$COMMAND" | grep -qE 'git[[:space:]]+rebase([[:space:]]|$)'; then
  block "git rebase non autorisé."
fi

# Bloquer le détournement des git hooks via git config
# Empêche: git config --global core.hooksPath /tmp
if echo "$COMMAND" | grep -qE 'git[[:space:]]+config.*core\.(hooksPath|fsmonitor|sshCommand)'; then
  block "Modification de core.hooksPath/fsmonitor/sshCommand non autorisée."
fi

# Bloquer rm -rf (suppression récursive forcée)
if echo "$COMMAND" | grep -qE 'rm[[:space:]]+.*(-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r)'; then
  block "rm -rf non autorisé."
fi

# Bloquer sudo
if echo "$COMMAND" | grep -qE '(^|[[:space:]])sudo([[:space:]]|$)'; then
  block "sudo non autorisé."
fi

# Bloquer l'upload de données via curl/wget vers des hosts non autorisés
# Whitelist : github.com, api.anthropic.com, raw.githubusercontent.com
if echo "$COMMAND" | grep -qE '(curl|wget).*(-d[[:space:]]|--data|--upload-file|--post-data|--post-file)'; then
  if ! echo "$COMMAND" | grep -qE '(github\.com|api\.anthropic\.com|raw\.githubusercontent\.com)'; then
    block "Upload curl/wget vers host non autorisé."
  fi
fi

exit 0
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bash tests/test-pre-bash.sh`
Expected: `PASS: 23  FAIL: 0`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add tests/test-pre-bash.sh .claude/hooks/pre-bash.sh
git commit -m "feat: allow git push to origin agent/* in pre-bash hook

Also converts all hook regexes from grep -P to POSIX ERE (grep -E) so the
hook behaves identically under BSD grep (local tests) and GNU grep
(Ubuntu containers), and adds a local test harness."
```

---

### Task 2: Hook — block `gh pr merge`, `gh api`, `gh repo`

**Files:**
- Modify: `.claude/hooks/pre-bash.sh` (append new blocks after the git push policy added in Task 1, before the `# Bloquer le passage sur main/master` block)
- Modify: `tests/test-pre-bash.sh` (add cases)
- Test: `tests/test-pre-bash.sh`

**Interfaces:**
- Consumes: `block()` function and the test helpers `expect_allow` / `expect_block` from Task 1 (`bash tests/test-pre-bash.sh`; helpers take the raw command string as their single argument).
- Produces: hook policy that `gh pr create` / `gh pr view` / `gh auth status` pass but `gh pr merge`, `gh api …`, `gh repo …` are blocked. `templates/CLAUDE.md` (Task 4) and README (Task 5) document exactly this policy.

- [ ] **Step 1: Add failing test cases**

In `tests/test-pre-bash.sh`, insert after the `expect_block 'git push origin agent/test-project main'` line:

```bash
# --- gh : créer/mettre à jour des PRs oui, merger/API brute/repo non ---
expect_allow 'gh pr create --base main --title "feat: x" --body "..."'
expect_allow 'gh pr view 42'
expect_allow 'gh pr list'
expect_allow 'gh auth status'

expect_block 'gh pr merge 42'
expect_block 'gh pr merge --auto --squash'
expect_block 'gh api user'
expect_block 'gh api /repos/foo/bar'
expect_block 'gh repo view'
expect_block 'gh repo delete foo/bar'
expect_block 'cd /workspace && gh pr merge 42'
```

- [ ] **Step 2: Run the tests to verify the new cases fail**

Run: `bash tests/test-pre-bash.sh`
Expected: FAIL — the 7 `expect_block 'gh …'` cases fail (nothing blocks `gh` yet), the 4 `expect_allow 'gh …'` cases pass. Output ends with `PASS: 27  FAIL: 7`, exit code 1.

- [ ] **Step 3: Add the gh blocks to the hook**

In `.claude/hooks/pre-bash.sh`, insert directly after the closing `fi` of the git push policy (added in Task 1) and before the `# Bloquer le passage sur main/master` comment:

```bash
# gh : l'agent crée et met à jour des PRs, ne merge jamais,
# ne parle jamais à l'API brute ni à l'administration de repo.
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])gh[[:space:]]+pr[[:space:]]+merge'; then
  block "gh pr merge non autorisé. La PR est revue et mergée par un humain."
fi
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])gh[[:space:]]+api([[:space:]]|$)'; then
  block "gh api non autorisé."
fi
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])gh[[:space:]]+repo([[:space:]]|$)'; then
  block "gh repo non autorisé."
fi
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bash tests/test-pre-bash.sh`
Expected: `PASS: 34  FAIL: 0`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add tests/test-pre-bash.sh .claude/hooks/pre-bash.sh
git commit -m "feat: block gh pr merge, gh api and gh repo in pre-bash hook"
```

---

### Task 3: `new-agent-container.sh` — explicit repo argument, PAT auth, HTTPS clone

**Files:**
- Modify: `scripts/new-agent-container.sh` (full rewrite — the file is 63 lines)
- Test: `bash -n scripts/new-agent-container.sh` (syntax only — `lxc` does not exist on the laptop; behavior is verified on the server in Task 6)

**Interfaces:**
- Consumes: `.claude/hooks/pre-bash.sh` and `config/claude-container-settings.json` (pushed into the container unchanged, from the repo checked out at `/home/moroine/agent-forge` on the server); `gh` CLI present in the `agent-base` image (README Task 5 adds it to the base-image build).
- Produces: usage `new-agent-container.sh <project-name> <owner/repo>`; a container named `agent-<project-name>` with `/workspace` cloned from `https://github.com/<owner/repo>.git` on branch `agent/<project-name>`, `gh` authenticated with the bot PAT and `gh auth setup-git` done. README (Task 5) documents this exact usage.

Changes vs the current script, for review orientation:
1. Second argument `<owner/repo>` required; the `ssh -T git@github.com` deploy-key detection hack is deleted.
2. Precondition checks at the top: both args, repo format, `agent-base` image exists, container name free.
3. The deploy-key push (`github_agents` → `id_ed25519`) is deleted. The signing-key push stays. The GitHub `known_hosts` block is deleted too — nothing in the container speaks SSH to GitHub anymore (signing uses the key locally, git goes over HTTPS).
4. New interactive PAT step: silent `read`, piped into `gh auth login --with-token` inside the container, then `gh auth status` (fail fast on a bad token, `set -e` aborts) and `gh auth setup-git`.
5. Clone over HTTPS.

- [ ] **Step 1: Rewrite the script**

Replace the entire content of `scripts/new-agent-container.sh` with:

```bash
#!/bin/bash
set -e

# Provisions an autonomous-mode agent container: it authenticates to GitHub
# with a fine-grained PAT from the bot account (pasted at creation time,
# never written to host disk), pushes over HTTPS and opens PRs with gh.

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: $0 <project-name> <owner/repo>"
  exit 1
fi

PROJECT="$1"
REPO="$2"
CONTAINER="agent-$PROJECT"

# Preconditions
if ! echo "$REPO" | grep -qE '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'; then
  echo "Error: repo must be <owner>/<repo>, got: $REPO"
  exit 1
fi
if ! lxc image info agent-base > /dev/null 2>&1; then
  echo "Error: image agent-base not found. Build the base image first (see README)."
  exit 1
fi
if lxc info "$CONTAINER" > /dev/null 2>&1; then
  echo "Error: container $CONTAINER already exists."
  exit 1
fi

echo "Creating container $CONTAINER..."
lxc launch agent-base "$CONTAINER" --profile agent

echo "Mounting workspace..."
if [ ! -d "/home/<user>/workspaces/$PROJECT" ]; then
  mkdir -p "/home/<user>/workspaces/$PROJECT"
  sudo chown 1001001:1001001 "/home/<user>/workspaces/$PROJECT"
  chmod 750 "/home/<user>/workspaces/$PROJECT"
fi
lxc config device add "$CONTAINER" workspace disk \
  source="/home/<user>/workspaces/$PROJECT" \
  path=/workspace

echo "Copying signing key..."
lxc file push /home/<user>/.ssh/github_agents_signing "$CONTAINER"/home/aiuser/.ssh/id_ed25519_signing --uid 1001 --gid 1001 --mode 600

echo "Configuring git..."
lxc exec "$CONTAINER" -- su - aiuser -c "
git config --global user.name 'Claude Agent'
git config --global user.email '<bot>@users.noreply.github.com'
git config --global gpg.format ssh
git config --global user.signingkey /home/aiuser/.ssh/id_ed25519_signing
git config --global commit.gpgsign true
"

echo "Installing Claude security hooks..."
lxc exec "$CONTAINER" -- su - aiuser -c "mkdir -p /home/aiuser/.claude/hooks"
lxc file push /home/moroine/agent-forge/.claude/hooks/pre-bash.sh \
  "$CONTAINER"/home/aiuser/.claude/hooks/pre-bash.sh \
  --uid 1001 --gid 1001 --mode 755
lxc file push /home/moroine/agent-forge/config/claude-container-settings.json \
  "$CONTAINER"/home/aiuser/.claude/settings.json \
  --uid 1001 --gid 1001 --mode 644

echo ""
echo "=============================================================="
echo "  GitHub token required (BOT account, fine-grained PAT)"
echo "  Scoped to: $REPO only"
echo "  Permissions: Contents RW, Pull requests RW, Metadata R"
echo "  The token is piped into the container and never written"
echo "  to host disk."
echo "=============================================================="
read -r -s -p "Paste the token (input hidden): " GH_TOKEN
echo ""
if [ -z "$GH_TOKEN" ]; then
  echo "Error: empty token."
  exit 1
fi

echo "Authenticating gh inside the container..."
printf '%s' "$GH_TOKEN" | lxc exec "$CONTAINER" -- su - aiuser -c "gh auth login --hostname github.com --with-token"
unset GH_TOKEN
# Fail fast if the token is invalid (set -e aborts on non-zero)
lxc exec "$CONTAINER" -- su - aiuser -c "gh auth status --hostname github.com"
lxc exec "$CONTAINER" -- su - aiuser -c "gh auth setup-git"

echo "Cloning $REPO and creating branch agent/$PROJECT..."
lxc exec "$CONTAINER" -- su - aiuser -c "git clone https://github.com/$REPO.git /workspace && cd /workspace && git checkout -b agent/$PROJECT"

echo "Container $CONTAINER ready."
lxc list "$CONTAINER"
```

- [ ] **Step 2: Syntax-check the script**

Run: `bash -n scripts/new-agent-container.sh`
Expected: no output, exit code 0.

- [ ] **Step 3: Verify no deploy-key / SSH-clone remnants**

Run: `grep -nE 'github_agents([^_]|$)|known_hosts|git@github|ssh -T' scripts/new-agent-container.sh`
Expected: no output, exit code 1 (`github_agents_signing` must not match — the pattern excludes it).

- [ ] **Step 4: Commit**

```bash
git add scripts/new-agent-container.sh
git commit -m "feat: provision autonomous containers with bot PAT and HTTPS clone"
```

---

### Task 4: `templates/CLAUDE.md` — rewrite the git section for the PR workflow

**Files:**
- Modify: `templates/CLAUDE.md:11-16` (the `## Git` section)
- Test: manual read-through (documentation; the hook enforcing these rules is tested in Tasks 1-2)

**Interfaces:**
- Consumes: the hook policy from Tasks 1-2 (allowed: `git push -u origin agent/<project>`, `gh pr create`; blocked: merge, force, delete, `gh pr merge`).
- Produces: the instructions file pushed to containers. Must only tell the agent to do things the hook allows.

- [ ] **Step 1: Replace the `## Git` section**

In `templates/CLAUDE.md`, replace:

```markdown
## Git
- Tu peux faire des commits — ils sont signés automatiquement (SSH signing configuré)
- Tu dois rester sur ta branche `agent/*` en permanence
- Tu ne dois **jamais** faire de `git push`
- Tu ne dois **jamais** faire de `git checkout main` ou changer de branche
- Les commits doivent avoir des messages clairs et conventionnels (`feat:`, `fix:`, `chore:`, etc.)
```

with:

```markdown
## Git
- Tu peux faire des commits — ils sont signés automatiquement (SSH signing configuré)
- Tu dois rester sur ta branche `agent/<project>` en permanence — jamais de `git checkout main`, jamais de changement de branche
- Les commits doivent avoir des messages clairs et conventionnels (`feat:`, `fix:`, `chore:`, etc.)
- Pousse ta branche avec `git push -u origin agent/<project>` — c'est la seule destination autorisée
- Quand le travail est prêt, ouvre une PR avec `gh pr create --base main`
- Ne merge **jamais** — ni `git merge`, ni `gh pr merge`. La PR est revue et mergée par un humain
- Réponds aux retours de review en poussant de nouveaux commits sur la même branche (jamais de force push, jamais de rebase)
```

- [ ] **Step 2: Commit**

```bash
git add templates/CLAUDE.md
git commit -m "docs: update agent CLAUDE.md template for autonomous git mode"
```

---

### Task 5: README — gh in base image, PAT walkthrough, branch protection, usage, token renewal

**Files:**
- Modify: `README.md` (Prerequisites; base-image build in section 5; section 6; Usage)
- Test: manual read-through; verify every command block is copy-pasteable and consistent with `scripts/new-agent-container.sh` from Task 3

**Interfaces:**
- Consumes: script usage `./scripts/new-agent-container.sh <project-name> <owner/repo>` (Task 3); hook policy (Tasks 1-2); PAT spec from Global Constraints.
- Produces: operator documentation only — no code depends on it.

- [ ] **Step 1: Update Prerequisites**

In `README.md`, replace the line:

```markdown
- GitHub bot account with Deploy Keys
```

with:

```markdown
- GitHub bot account, invited as a **write collaborator** on each target repo
```

- [ ] **Step 2: Add `gh` to the base-image build**

In `README.md` section `### 5. LXD`, in the base-image build block, insert after the line `lxc exec agent-base-setup -- npm install -g @anthropic-ai/claude-code`:

```bash
lxc exec agent-base-setup -- bash -c 'mkdir -p -m 755 /etc/apt/keyrings && wget -qO /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg'
lxc exec agent-base-setup -- bash -c 'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list'
lxc exec agent-base-setup -- bash -c 'apt update && apt install -y gh'
```

(Single quotes are deliberate: `$(dpkg --print-architecture)` must run inside the container.)

Directly after the build block (after the `lxc delete agent-base-setup` fence closes), add:

```markdown
> **Note:** if you built `agent-base` before `gh` was part of the build, rebuild it — autonomous containers need the GitHub CLI.
```

- [ ] **Step 3: Rework section 6 (keys & token)**

In `README.md`, replace the whole `### 6. GitHub Deploy Keys` section (everything between the `### 6.` heading and `### 7. SSH Agent Forwarding (YubiKey)`) with:

````markdown
### 6. GitHub bot account: signing key, PAT, branch protection

#### Signing key

Generate the commit-signing key on the server:

```bash
ssh-keygen -t ed25519 -C "agents-server-signing@github" -f ~/.ssh/github_agents_signing -N ""
```

On the GitHub bot account, add `github_agents_signing.pub` as a **Signing Key** under Settings → SSH and GPG keys. Agent commits then show as **Verified**.

> The old read-only deploy key (`~/.ssh/github_agents`) is no longer used by
> autonomous containers — they authenticate with a PAT over HTTPS. It will
> return in supervised mode as the fetch-only credential; keep it if present.

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
````

- [ ] **Step 4: Update the Usage section**

In `README.md`, replace:

````markdown
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
````

with:

````markdown
### Create a new agent container

```bash
./scripts/new-agent-container.sh <project-name> <owner/repo>
```

This will:
- Create an LXD container from `agent-base`
- Mount `/workspace` with correct permissions
- Copy the signing key and configure git (signed commits)
- Prompt for the bot's fine-grained PAT (see setup §6) and authenticate `gh` inside the container — the token is never written to host disk
- Clone `https://github.com/<owner/repo>.git` and create branch `agent/<project-name>`

### Autonomous PR flow

The agent works on `agent/<project-name>`, pushes with
`git push -u origin agent/<project-name>` and opens a PR with
`gh pr create --base main`, all authenticated as the bot. The `pre-bash.sh`
hook only allows pushes to `origin agent/*` (no force, no delete) and blocks
`gh pr merge`, `gh api` and `gh repo`. You review, approve and merge the PR
as yourself.

### Token renewal

Fine-grained PATs expire (max 1 year). To renew: create a new PAT in the bot's
web UI (same repo, same permissions), then re-authenticate the affected
container:

```bash
printf '%s' '<new-token>' | lxc exec agent-<project-name> -- su - aiuser -c "gh auth login --hostname github.com --with-token"
```
````

- [ ] **Step 5: Consistency check**

Run: `grep -nE 'github_agents([^_]|$)|Deploy Key' README.md`
Expected: matches only inside the "old read-only deploy key" context note added in Step 3 — no instruction telling the operator to create or push a deploy key remains.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: document autonomous git mode setup and workflow"
```

---

### Task 6: Server verification (manual — run by the maintainer on the LXD host, not by an agent)

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything from Tasks 1-5, deployed on the server (pull the branch into `/home/moroine/agent-forge`), plus a scratch repo on GitHub with the bot invited as write collaborator, branch protection on `main`, and a fine-grained PAT per setup §6.

This task cannot run on the laptop. It is the spec's verification checklist, to run after the PR from Tasks 1-5 is reviewed:

- [ ] **1. PAT sanity:** confirm a fine-grained PAT on the bot account can target the scratch repo owned by your user account. If cross-owner fine-grained PATs fail, fall back to a classic PAT (`repo` scope) on the bot and note it in the README.
- [ ] **2. Provisioning end to end:** rebuild `agent-base` with `gh` (README §5), then `./scripts/new-agent-container.sh test-project <owner>/<scratch-repo>` — paste the PAT; expect clone to succeed and branch `agent/test-project` to exist in `/workspace`.
- [ ] **3. Happy path inside the container:** make a commit, then `git push -u origin agent/test-project`, then `gh pr create --base main --title "test" --body "test"` — all succeed; on GitHub the PR author is the bot and the commit shows **Verified**.
- [ ] **4. Hook blocks (run inside a Claude Code session in the container, one per command):** `git push origin main`, `git push --force origin agent/test-project`, `git push origin :agent/test-project`, `gh pr merge`, `gh api user`, `gh repo view` — each answers `BLOCKED: …` and does not execute.
- [ ] **5. Boundary check:** with branch protection on, confirm the bot cannot merge its own PR (merge button disabled / `gh pr merge` would be refused server-side anyway) and that you can approve and merge as yourself.
- [ ] **6. Cleanup:** `lxc delete agent-test-project --force` and delete the scratch PR/branch.
