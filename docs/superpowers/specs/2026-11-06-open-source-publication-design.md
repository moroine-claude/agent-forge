# agent-forge goes open source — Design

**Date:** 2026-11-06
**Status:** Approved by the maintainer (2026-11-06)
**Branch:** `agent/open-source`, from `main` (pull request `--base main`)

## 1. Intent

agent-forge has lived in a private GitHub repository (`moroine/agent-forge`).
The maintainer wants to publish it as an open-source project, for two reasons:

- sharing the project (the v2 framing already aimed at "shareable, one VM per
  developer");
- unlocking the next project, a dedicated AWS VM where an agent develops
  agent-forge itself with **its own GitHub account**. That agent must
  contribute through **pull requests from a fork, with no write access** to the
  repository. On a repository owned by a personal account (not an
  organization), GitHub has no read-only collaborator role: any collaborator
  can push. A public repository lets the agent fork without any grant. And
  branch protection, which this project also wants, is only free on public
  repositories.

Success: the same repository, with its full history, issues and pull requests,
is public under AGPL-3.0; it carries a license, a security policy and a
contributing guide; secrets are kept out by a local hook, by CI and by GitHub's
own secret protection; `main` only changes through pull requests that pass CI.

## 2. Decisions made by the maintainer

- **Publish the existing repository as is. No history rewrite.** A scan on
  2026-11-06 (every blob and commit message reachable from every ref, pull
  request refs included, plus issue and pull request texts) found no secret
  and no home network data. The history does carry personal but non-secret
  data: author emails (one of them a client's domain, on most commits; a
  colleague's personal address on 5 commits), the name and private LAN address
  of a former host, `/home/<login>` paths in v1 code, and links to Claude Code
  sessions. The maintainer accepts all of it ("je m'en fiche des emails"). The
  sessions are private (checked by the maintainer); the public addresses of the
  AWS test VMs quoted in a pull request are released by the maintainer on their
  side. Rewriting would anyway not reach `refs/pull/*`, which GitHub keeps.
- **The full-history secret scan is run by the maintainer**, on their
  machine, with Betterleaks, **and again by the builder** (§4.1). A real
  secret, if any, reopens the rewrite decision with them.
- **Betterleaks**, not Gitleaks, is the project's secret scanner: as a git
  hook, and together with GitHub's secret protection.
- **License: AGPL-3.0.** The maintainer does not want agent-forge to end up in
  a closed product, and for an infrastructure tool the realistic closed use is
  a hosted service, which only the AGPL covers. The copyright belongs to the
  maintainer's company (written in a personal, not client, context) and to the
  colleagues who contributed.
- **No CLA.** Contributors are the maintainer's colleagues; any future
  relicensing would be decided with them.
- **Signed commits required for everyone, with no bypass**: colleagues, the
  dev-VM agent's account (its own signing key) and the maintainer alike. A
  pull request that carries one unsigned commit cannot be merged, squash
  included, until its commits are re-signed; the maintainer accepts that.

## 3. Goals, non-goals, anti-goals

Goals:

1. A license, a security policy and a contributing guide at the root.
2. Betterleaks in three places: a pre-commit hook a contributor installs once,
   a CI job that blocks pull requests, and its configuration (ignore file) in
   the repository.
3. A checklist the maintainer follows to flip the repository to public and turn
   on GitHub's protections.

Non-goals:

- Rewriting history, editing past issue or pull request texts.
- Translating the French parts (commit messages, issues, `CLAUDE.md`,
  `container/CLAUDE.md`). The user-facing docs are already in English.
- Betterleaks inside the `agent-base` image or on the forge host: a forge
  container's clone gets no hook. CI is the gate for agent work. The dev-VM
  project decides what its host runs.
- Dependabot version updates, release automation, a code of conduct, issue
  templates. They can come later.

Anti-goals (failure even if everything "works"):

- **A hook mechanism that runs code taken from the checked-out tree.** A
  relative `core.hooksPath` (`.githooks`), husky, lefthook or the pre-commit
  framework all run whatever the current checkout says. The maintainer may check
  out agent branches; an agent that edits the hook would get code execution on
  their machine, next to their SSH agent and signing key. `forge ship` already
  runs every git command with `core.hooksPath=/dev/null` for this exact reason
  (`cli/lib/laptop/replay.ts`), and `container/pre-bash.sh` refuses any
  `core.hooksPath` change.
- **A scan that sends secrets over the network.** Validation sends a found
  credential to its provider. In v1 it is `--validation`, off by default
  (`-v` is `--verbose`); in v2, `-v` becomes `--validate` and `-a`/`--analyze`
  implies it. Neither the hook nor CI may enable it (no `--validation`, no
  `-v` once on v2, no `BETTERLEAKS_VALIDATE`/`BETTERLEAKS_ANALYZE`). Nor may
  they pass `--trust-local-git-config` (it trusts the scanned repository's git
  config and hooks) or `--unsafe-auto-load-config`.
- A hook that blocks a contributor who has not installed Betterleaks.
- Personal values in the new files (see `CLAUDE.md`, "Sécurité").

## 4. Design

### 4.1 Full-history scan (the maintainer, independent of the pull request)

The history is scanned by the maintainer on their machine, and again by the
builder as a double check, both on a mirror clone (`git clone --mirror`) in an
empty directory outside the checkout, so that pull request refs are scanned
too, with the pinned Betterleaks (§4.2). The builder reports counts, rule IDs,
files and commits, never values (`--redact`):

```sh
betterleaks git agent-forge.git --log-opts="--all" --redact --report-format json --report-path betterleaks.json
```

`--log-opts="--all"` makes it walk every ref of the mirror, pull request refs
included. v1 scans diffs, not commit messages; the pattern scan of
2026-11-06 already covered the messages and the issue and pull request texts.
On 2026-11-06, Betterleaks 1.10.0 with its default rules found nothing
(5.88 MB scanned, every ref), in the maintainer's run and in a second run
during this design. The builder reruns it just before the switch, since
commits land in between. A real secret
stops the publication and goes back to the maintainer. Its result is a
precondition of the switch (§4.8, step 1), not of the pull request: the CI job
(§4.4) never rescans the history, so it does not depend on this scan.

### 4.2 Betterleaks configuration

- Pin the latest **stable** Betterleaks for the whole repository (hook docs and
  CI): `v1.10.0` on 2026-11-06, what Homebrew and dnf install, with a
  gitleaks-compatible CLI. v2 only exists as release candidates
  (`v2.0.0-rc.7`, 2026-11-04). Open an issue to move to v2 once 2.0.0 is
  stable: v2 changes the flags (`-v` becomes `--validate`, `--log-opts`
  becomes `--revision`), the ignore file and the fingerprint format, so the
  hook, the CI job and `.betterleaksignore` will need a pass then.
- No ignore file to start with: the default rules flag nothing in the
  repository (§4.1). When a finding that is not a secret appears later (a test
  fixture, say), it goes to `.betterleaksignore` at the root as a fingerprint,
  with a comment saying what it is. Prefer fingerprints over path exclusions,
  so that a real secret added later to a test file is still caught. The hook
  and CI pass the ignore file explicitly when it exists, and
  `CONTRIBUTING.md` says how to add an entry.
- A `betterleaks.toml` only if the default rules need tuning. Betterleaks never
  loads a policy file from history, only from the working tree.

### 4.3 Pre-commit hook

- The hook script lives in the repository (path left to the builder, e.g.
  `.githooks/pre-commit`) and is **installed as a copy** into the clone's
  common hooks directory (`git rev-parse --git-common-dir`/hooks), so that a
  checkout never changes the hook that runs. Installation is one documented
  command (an npm script or a small shell script), run from a checkout of
  `main`; it does not set `core.hooksPath`, refuses to overwrite a different
  existing `pre-commit` hook without an explicit flag, and warns if a global
  `core.hooksPath` would make `.git/hooks` ignored.
- The hook scans only the staged changes: `betterleaks git --pre-commit --staged --redact`
  in v1 (check the pinned version's `--help`).
- No Betterleaks on the machine: the hook prints one line saying how to install
  it and lets the commit through (CI is the gate). A major version other than
  the pinned one: same.
- Bash strict mode and quoting rules of `CLAUDE.md` apply.

### 4.4 CI job

- A `secrets` job in `.github/workflows/ci.yml`, next to `cli`, `ansible-lint`
  and `ansible-unit`. It installs the pinned Betterleaks release binary the way
  the `cli` job installs herdr (download by version, `sha256sum -c` against a
  checksum written in the workflow), checks out enough history, and scans
  **only the commits being added**, with `--redact` and the repository's
  `.betterleaksignore`: on a pull request, the range from the merge base with
  the base branch to the head (`--log-opts="A..B"` in v1); on a push to
  `main`, the pushed range. The past is §4.1's job.
- No validation flags (§3). Findings fail the job.
- While at it, drop the retired `next` branch from the workflow's `push`
  trigger.

### 4.5 LICENSE and notices

- `LICENSE`: the verbatim GNU AGPL v3 text, fetched from gnu.org, not typed
  from memory.
- SPDX identifier **`AGPL-3.0-only`**, in `package.json` (`"license"`; keep
  `"private": true`, the package is not published to npm).
- A "License" section at the end of `README.md`: AGPL-3.0-only, copyright "the
  agent-forge contributors", link to `LICENSE`. No per-file headers.

### 4.6 SECURITY.md

In English. It says:

- Supported: `main` (v2). v1 (LXD) is not maintained.
- How to report: GitHub's private vulnerability reporting ("Report a
  vulnerability" on the Security tab). Never in a public issue.
- What to expect: best effort from a small team; an acknowledgement target of
  7 days.
- In scope, for example: escaping a forge container, bypassing the strict
  egress allowlist or `forge-egress`, reaching the forwarded SSH agent or the
  host from a container, the laptop commands trusting agent-written data
  (`forge fetch`, `forge ship`), weaknesses of the host playbook.
- Out of scope: vulnerabilities of Incus, Claude Code, herdr, Docker or Ubuntu
  themselves (report upstream); `container/pre-bash.sh` is a guardrail for an
  agent's mistakes, not a security boundary, so getting past it alone is not a
  vulnerability; what an agent can do inside its own container by design.

### 4.7 CONTRIBUTING.md

In English, short, linking to the README and `ansible/README.md` rather than
repeating them. It covers:

- `main` is protected (§4.8) and the maintainer merges. Contributors without
  write access (and the dev-VM agent's account) open pull requests from a
  fork. People who already have write access keep it and may keep pushing
  `agent/<task>` branches to the repository, as `CLAUDE.md` and `forge ship`
  do (`forge ship` opens the pull request on `origin`'s own repository, so it
  needs write access there; fork support is out of scope).
- Commits: conventional prefixes (`feat:`, `fix:`, `chore:`, `docs:`,
  `test:`), messages in English or French, and **signed**, every one of them
  (GPG or SSH signature verified by GitHub): a pull request with one unsigned
  commit cannot be merged. Say how to set up signing (link to GitHub's guide)
  and how to re-sign a branch before pushing again
  (`git rebase --force-rebase --gpg-sign <base>`, then a push with
  `--force-with-lease` to the contributor's own branch).
- Running the tests: `npm ci`, `npm test`, `npm run check`,
  `npm run test:ansible`; the integration tests (`FORGE_INTEGRATION=1`) and
  `ansible/tests/vm-test.sh` need a disposable Incus host and are not run in
  CI.
- Installing the Betterleaks hook (§4.3).
- The project's rules worth knowing before writing code, summarized from
  `CLAUDE.md`: the Ansible/`forge` boundary, no personal values anywhere in the
  repository, Bash strict mode, comments justifying firewall and ACL rules.
- Agents: Claude Code sessions in this repository follow `CLAUDE.md`, and its
  `.claude/settings.json` hook applies to them.
- Security issues: see `SECURITY.md`.
- Contributions are licensed under the repository's license (AGPL-3.0-only).

### 4.8 The switch (maintainer's checklist, in the pull request description)

In this order, after the pull request with §4.2–4.7 is merged:

1. §4.1 done, no real secret.
2. Settings → General → Danger Zone → change visibility to public.
3. Settings → Code security: enable private vulnerability reporting, secret
   scanning with push protection, Dependabot alerts, and CodeQL default setup.
4. Settings → Actions → General: keep the workflow token read-only; require
   approval for workflows from first-time contributors' forks.
5. Settings → Rules → a ruleset on `main` with no bypass: pull request
   required (0 approvals: the maintainer cannot approve their own pull
   requests), status checks required (`cli`, `ansible-lint`, `ansible-unit`,
   `secrets`), signed commits required (§2), force pushes and deletion
   blocked. GitHub checks every commit a pull request brings: one unsigned
   commit blocks the merge, squash included, until it is re-signed.
6. Check from a logged-out browser that the repository, issues and pull
   requests are visible, and open one test pull request from a fork to see the
   ruleset and CI apply.

Existing public-facing security issues (#78, #91) become visible with the
repository. They describe limitations without an exploit; the maintainer
confirms that before step 2.

## 5. Known limits

- On a pull request, the workflow and `.betterleaksignore` come from the pull
  request's own branch. A contributor (or agent) can weaken the scan in the
  same pull request. The maintainer's review of any change to `.github/`, the
  hook, `.betterleaksignore` or `betterleaks.toml` is the safeguard; the
  `CONTRIBUTING.md` says these files get extra scrutiny.
- The hook is a convenience: `git commit --no-verify` skips it.

## 6. Left to the builder

- The Betterleaks release asset and its checksum, the hook script's path and
  installer form, the CI job's exact scan range.
- Wording of the three documents within §4.5–4.7.

## 7. Calls made while writing (not discussed with the maintainer)

- `AGPL-3.0-only` rather than `-or-later`: relicensing, even to a later AGPL,
  stays a decision of the copyright holders.
- Copyright notice "the agent-forge contributors", no per-file headers.
- No DCO: GitHub's terms already make contributions inbound = outbound.
- A Betterleaks CI job in addition to the hook and GitHub's protection: the
  hook can be skipped and GitHub only knows providers' secret formats.
- New documents in English; commits may stay French.
- Security acknowledgement target of 7 days.
- CodeQL default setup enabled.
- The hook lets commits through when Betterleaks is missing.
- Stable Betterleaks v1.10.0 pinned now, v2 once 2.0.0 is stable (§4.2):
  contributors install it with their package manager.
- CI scans only the commits being added; the history is the maintainer's
  one-time scan (§4.1).
- Collaborators keep their current write access; forks for everyone else;
  no fork support in `forge ship`.

## 8. Next

The dev-VM project (AWS `m7i.2xlarge` with nested virtualization, an agent
developing agent-forge on the host itself, its own GitHub account and fork)
resumes its brainstorm once the repository is public. Host auto-stop is
moroine/agent-forge#99, after DX 5 (#92).
