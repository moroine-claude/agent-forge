# agent-forge goes open source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the files and checks that let the maintainer flip `moroine/agent-forge` to public: AGPL-3.0 license, security policy, contributing guide, a Betterleaks pre-commit hook installed as a copy, and a Betterleaks CI job that scans the commits being added.

**Architecture:** Two small Bash scripts carry the logic and are tested with a fake `betterleaks` on `PATH`: `.githooks/pre-commit` (scans staged changes) with its installer `.githooks/install.sh` (copies it into the clone's common hooks directory, never touches `core.hooksPath`), and `.github/scripts/scan-secrets.sh` (scans a commit range in CI). `ci.yml` only installs the pinned binary and calls the script. Documents are plain files checked by a Bash test.

**Tech Stack:** Bash (strict mode), Betterleaks 1.10.0 (gitleaks-compatible CLI), GitHub Actions, Node 24 (`npm test` runs `tests/test-*.sh`).

**Spec:** `docs/superpowers/specs/2026-11-06-open-source-publication-design.md` (approved 2026-11-06). Read it first: §3's anti-goals are requirements.

## Global Constraints

- Betterleaks pin: version `1.10.0`, major `1`. CI asset `https://github.com/betterleaks/betterleaks/releases/download/v1.10.0/betterleaks_1.10.0_linux_x64.tar.gz`, SHA-256 `9d9ad503cd5d80d18a939352266c3fcca52f10da9b83cd5cfe646989b13940fe` (from the release's `checksums.txt`; the archive holds `betterleaks`, `LICENSE`, `README.md` at its root). `betterleaks version` prints `1.10.0`.
- Never pass `--validation`, `-v`/`--verbose`, `--trust-local-git-config` or `--unsafe-auto-load-config` to Betterleaks; run it with `BETTERLEAKS_VALIDATE` and `BETTERLEAKS_ANALYZE` removed from the environment (`env -u`).
- Never set `core.hooksPath`. `container/pre-bash.sh` blocks any Bash command whose text contains `git config … core.hooksPath`, and any command containing `rm -rf`: write files with such text through the file tools, and run tests as `bash tests/<file>.sh`.
- Bash: `set -e`, every variable quoted, comments on non-obvious blocks, preconditions checked first (`CLAUDE.md`, "Scripts").
- No personal value in any file (name, login, path, host, address, email); `github.com/moroine/agent-forge` is the one allowed project address.
- License identifier `AGPL-3.0-only`; copyright notice "the agent-forge contributors"; no per-file headers.
- New documents in English. Bash test comments in English or French, like their neighbours.
- Commits: conventional prefixes, on `agent/open-source`, signed with the maintainer's YubiKey: ask the maintainer to be at the key before each commit (unsigned only if they explicitly allow it for the batch). Never push or open the pull request without the maintainer's confirmation.

## Review Focus

1. **A linked worktree** (the maintainer works in `.claude/worktrees/*`): the installer must write into the common hooks directory, and the hook must scan the worktree it runs in. Test I4 in Task 2.
2. **A repository path with a space**: every path in the hook and installer quoted. Test H7 in Task 2.
3. **A global `core.hooksPath`** set by another tool: git then ignores `.git/hooks`, so the installer must say the hook will not run. Test I5 in Task 2.
4. **A push whose `before` is all zeros or unknown** (first push of a branch, force-push): the CI script must fall back to the full history, not fail. Tests S2–S4 in Task 3.
5. **Betterleaks upgraded to 2.x by Homebrew** (where `-v` means `--validate`): the hook must skip with a message instead of calling v1 flags. Test H2 in Task 2.

---

### Task 1: Commit the spec and the plan

**Files:**
- Add: `docs/superpowers/specs/2026-11-06-open-source-publication-design.md`, `docs/superpowers/plans/2026-11-06-open-source-publication.md`

- [ ] **Step 1: Check no personal value slipped in**

Read both files once for personal values (`CLAUDE.md`, "Sécurité": names, logins, hosts, addresses, emails, paths). No test lists them on purpose: such a test would itself publish them (see the header of `tests/test-readme-docs.sh`).
Expected: none found.

- [ ] **Step 2: Commit** (maintainer at the YubiKey)

```bash
git add docs/superpowers/specs/2026-11-06-open-source-publication-design.md docs/superpowers/plans/2026-11-06-open-source-publication.md
git commit -m "docs: spec et plan du passage en open source"
```

---

### Task 2: Pre-commit hook and its installer

**Files:**
- Create: `.githooks/pre-commit` (mode 755)
- Create: `.githooks/install.sh` (mode 755)
- Modify: `package.json` (`scripts`: `"hooks:install": "bash .githooks/install.sh"`)
- Test: `tests/test-git-hooks.sh`

**Interfaces:**
- Produces: `.githooks/pre-commit`, no arguments, run by git from the top of the work tree. Exit 0 = commit proceeds. Messages on stderr, exact text:
  - missing binary: `pre-commit: betterleaks is not installed, the secret scan is skipped (CI still runs it). See CONTRIBUTING.md.`
  - other major: `pre-commit: betterleaks <version> is not 1.x, the secret scan is skipped (CI still runs it). See CONTRIBUTING.md.`
  - finding: `pre-commit: betterleaks found a possible secret in the staged changes. See CONTRIBUTING.md for false positives.` (exit 1)
- Produces: `.githooks/install.sh [--force]`, run from inside the target clone (cwd). Copies the `pre-commit` next to itself to `"$(git rev-parse --path-format=absolute --git-common-dir)/hooks/pre-commit"`. Output, exact text:
  - `installed <path>` (exit 0), `already installed: <path>` (exit 0, identical content)
  - `a different pre-commit hook exists at <path>; rerun with --force to replace it` (exit 1, file untouched)
  - `warning: core.hooksPath is set to <value>: git will not run <path>` (effective value from `git config --get`, local or global)
  - `warning: installing the hook from <branch>, not main` (when `git rev-parse --abbrev-ref HEAD` is not `main`)
- Consumes: nothing.

The hook runs, from `top="$(git rev-parse --show-toplevel)"`:
`env -u BETTERLEAKS_VALIDATE -u BETTERLEAKS_ANALYZE betterleaks git --pre-commit --staged --redact --no-banner [--gitleaks-ignore-path "$top/.betterleaksignore"] "$top"`
with the ignore flag only when that file exists. A constant `BETTERLEAKS_MAJOR=1` at the top of the hook carries the pin; the major is read from `betterleaks version` with a leading `v` stripped.

Paths in the tests' assertions are what git prints (`git -C "$repo" rev-parse --show-toplevel`, `git -C "$repo" rev-parse --path-format=absolute --git-common-dir`), never the `mktemp` path itself: on macOS `/var` resolves to `/private/var`.

- [ ] **Step 1: Write the failing test `tests/test-git-hooks.sh`**

Same shape as `tests/test-vm-test.sh` (`TMP="$(mktemp -d)"`, `trap` cleanup, `PASS`/`FAIL` counters, `echo "PASS=$PASS FAIL=$FAIL"`, `[ "$FAIL" -eq 0 ]`). Each case builds a throwaway repo (`git init`, `git -c user.name=t -c user.email=t@example.invalid commit --allow-empty --no-gpg-sign -m init`, and `GIT_CONFIG_GLOBAL="$TMP/gitconfig-<case>"` pointing at an empty file so the developer's own config never leaks in). A fake `betterleaks` in `"$TMP/bin"` prints `$FAKE_BL_VERSION` for `version`, otherwise appends `"$@"` (one argument per line) to `$FAKE_BL_ARGS`, appends `BETTERLEAKS_VALIDATE=${BETTERLEAKS_VALIDATE-unset}` to `$FAKE_BL_ENV`, and exits `$FAKE_BL_EXIT`. Run the hook as `(cd "$repo" && PATH="$TMP/bin:/usr/bin:/bin" "$REPO_ROOT/.githooks/pre-commit")` and the installer as `(cd "$repo" && "$REPO_ROOT/.githooks/install.sh" [--force])`.

Cases and assertions:
- **H1 missing binary** (`PATH=/usr/bin:/bin`): exit 0; stderr contains `betterleaks is not installed`.
- **H2 other major** (`FAKE_BL_VERSION=2.0.0`): exit 0; stderr contains `betterleaks 2.0.0 is not 1.x`; `$FAKE_BL_ARGS` does not contain `git`.
- **H3 clean** (`1.10.0`, exit 0): hook exit 0; args file lines are exactly `git`, `--pre-commit`, `--staged`, `--redact`, `--no-banner`, then the repo's top-level path; none of `--validation`, `-v`, `--verbose`, `--trust-local-git-config`, `--unsafe-auto-load-config`.
- **H4 finding** (fake exit 1): hook exit non-zero; stderr contains `found a possible secret`.
- **H5 ignore file**: with `.betterleaksignore` at the top, args contain `--gitleaks-ignore-path` followed by `<top>/.betterleaksignore`; without it (H3), no `--gitleaks-ignore-path`.
- **H6 validation env**: run with `BETTERLEAKS_VALIDATE=true`; `$FAKE_BL_ENV` reads `BETTERLEAKS_VALIDATE=unset`.
- **H7 space in path**: repo under `"$TMP/with space/repo"`; H3's assertions hold.
- **I1 fresh install**: exit 0, output `installed <common-dir>/hooks/pre-commit`; the file is executable and `cmp`-identical to `.githooks/pre-commit`; `git config --get core.hooksPath` in the repo prints nothing.
- **I2 rerun**: exit 0, output contains `already installed:`.
- **I3 different hook**: write `#!/bin/sh\nexit 0\n` to the target first; installer exit non-zero, output contains `rerun with --force`, file unchanged; with `--force`: exit 0 and file identical to the source.
- **I4 linked worktree**: `git worktree add "$TMP/wt" -b side` from the repo, run the installer from `"$TMP/wt"`: the hook lands in the main repo's `.git/hooks/pre-commit` (not under `.git/worktrees/`); then a commit in the worktree with a staged file runs the fake (args' last line is `"$TMP/wt"`).
- **I5 global hooksPath**: put `[core]\n\thooksPath = /nonexistent` in the case's `GIT_CONFIG_GLOBAL` file (via `printf` into the file, not `git config`); output contains `warning: core.hooksPath is set to /nonexistent`.
- **I6 branch**: in a repo on branch `side`, output contains `warning: installing the hook from side, not main`; on `main` (I1, after `git branch -M main`), no such warning.
- **R1 real Betterleaks** (only when `betterleaks version` prints `1.`; else `echo "SKIP R1: betterleaks 1.x not installed"`): install the hook, stage a file holding `ghp_` followed by 36 random alphanumerics (generate it at run time, never commit one), `git commit` fails; unstage it, `git commit --allow-empty` succeeds.

- [ ] **Step 2: Run it to see it fail**

Run: `bash tests/test-git-hooks.sh`
Expected: FAIL lines (the scripts do not exist), non-zero exit.

- [ ] **Step 3: Write `.githooks/pre-commit` and `.githooks/install.sh`** to the interfaces above; `chmod 755` both; add the `hooks:install` npm script. The installer resolves its source as `"$(cd "$(dirname "$0")" && pwd)/pre-commit"`, refuses to run outside a git work tree (`git rev-parse --is-inside-work-tree`), creates the hooks directory if missing, copies with `cp` then `chmod 755`. A comment at the top of each script says why the hook is a copy and not `core.hooksPath` (spec §3, `cli/lib/laptop/replay.ts`).

- [ ] **Step 4: Run the tests**

Run: `bash tests/test-git-hooks.sh && npm run test:bash`
Expected: `PASS=… FAIL=0` (R1 runs on a machine with Betterleaks 1.x, else prints SKIP), and every other bash test still passes.

- [ ] **Step 5: Commit**

```bash
git add .githooks/pre-commit .githooks/install.sh package.json tests/test-git-hooks.sh
git commit -m "feat: hook pre-commit Betterleaks installé par copie"
```

---

### Task 3: CI scan script and the `secrets` job

**Files:**
- Create: `.github/scripts/scan-secrets.sh` (mode 755)
- Modify: `.github/workflows/ci.yml` (push trigger, new job)
- Test: `tests/test-secrets-scan.sh`

**Interfaces:**
- Produces: `.github/scripts/scan-secrets.sh <base> <head>`, run from inside the repository. `head` must name a commit (else exit 2, `scan-secrets: <head> is not a commit`, Betterleaks not called). When `base` is empty, forty zeros, or not a commit of the repository (`git cat-file -e "$base^{commit}"` fails), it prints `scan-secrets: no usable base, scanning the full history of <head>` and scans `--log-opts=<head>`; otherwise `--log-opts=<base>..<head>`. Command:
  `env -u BETTERLEAKS_VALIDATE -u BETTERLEAKS_ANALYZE betterleaks git --log-opts="<opts>" --redact --no-banner [--gitleaks-ignore-path "$top/.betterleaksignore"] "$top"`; exits with Betterleaks' code.
- Consumes: nothing from Task 2 (same fake technique, own copy in the test).

- [ ] **Step 1: Write the failing test `tests/test-secrets-scan.sh`**

Same harness as Task 2 (fake `betterleaks`, throwaway repo with three commits `c1`, `c2`, `c3`, full SHAs from `git rev-parse`).
- **S1 range**: `scan-secrets.sh c1 c3` → exit 0; args contain `--log-opts=<c1>..<c3>`, `--redact`, `--no-banner`, and end with the repo path.
- **S2 zeros**: base `0000000000000000000000000000000000000000` → output contains `scanning the full history`; args contain `--log-opts=<c3>`.
- **S3 empty base**: base `""` → same as S2.
- **S4 unknown base**: base `deadbeefdeadbeefdeadbeefdeadbeefdeadbeef` → same as S2.
- **S5 bad head**: head `deadbeef…` → exit 2, output contains `is not a commit`, args file empty.
- **S6 finding**: fake exit 1 → script exit non-zero.
- **S7 safety**: with `BETTERLEAKS_VALIDATE=true` in the environment, the fake sees it unset; no `--validation`, `-v`, `--verbose`, `--trust-local-git-config`, `--unsafe-auto-load-config` in args.
- **W1 workflow** (text checks on `.github/workflows/ci.yml`): contains `secrets:`, `betterleaks_1.10.0_linux_x64.tar.gz`, `9d9ad503cd5d80d18a939352266c3fcca52f10da9b83cd5cfe646989b13940fe`, `sha256sum -c`, `fetch-depth: 0`, `persist-credentials: false`, `.github/scripts/scan-secrets.sh`; the `branches:` line of the push trigger is `branches: [main]`; the file contains neither `next` nor `--validation`.

- [ ] **Step 2: Run it to see it fail**

Run: `bash tests/test-secrets-scan.sh`
Expected: FAIL lines, non-zero exit.

- [ ] **Step 3: Write the script, then the job**

The script per the interface (`set -e`, preconditions first, a comment on why only added commits are scanned: spec §4.1/§4.4). In `ci.yml`, change the push trigger to `branches: [main]` and add, after `ansible-unit`:

```yaml
  # Secret scan of the commits being added (the history is scanned once by
  # hand, see docs/superpowers/specs/2026-11-06-open-source-publication-design.md).
  secrets:
    runs-on: ubuntu-26.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: Install Betterleaks (pinned)
        run: |
          curl -fsSL -o "$RUNNER_TEMP/betterleaks.tar.gz" https://github.com/betterleaks/betterleaks/releases/download/v1.10.0/betterleaks_1.10.0_linux_x64.tar.gz
          echo "9d9ad503cd5d80d18a939352266c3fcca52f10da9b83cd5cfe646989b13940fe  $RUNNER_TEMP/betterleaks.tar.gz" | sha256sum -c -
          mkdir -p "$HOME/.local/bin"
          tar -xzf "$RUNNER_TEMP/betterleaks.tar.gz" -C "$HOME/.local/bin" betterleaks
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"
      - name: Scan the commits being added
        env:
          SCAN_BASE: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before }}
          SCAN_HEAD: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}
        run: bash .github/scripts/scan-secrets.sh "$SCAN_BASE" "$SCAN_HEAD"
```

- [ ] **Step 4: Run the tests**

Run: `bash tests/test-secrets-scan.sh && npm run test:bash`
Expected: `FAIL=0` everywhere.

- [ ] **Step 5: Check the script against the real binary** (if Betterleaks 1.x is installed)

Run: `bash .github/scripts/scan-secrets.sh "$(git rev-parse origin/main)" HEAD; echo "exit=$?"`
Expected: `no leaks found`, `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add .github/scripts/scan-secrets.sh .github/workflows/ci.yml tests/test-secrets-scan.sh
git commit -m "ci: scan Betterleaks des commits ajoutés, retrait de next"
```

---

### Task 4: License

**Files:**
- Create: `LICENSE`
- Modify: `package.json` (`"license": "AGPL-3.0-only"`, keep `"private": true`), `package-lock.json` (root package entry), `README.md` (new last section)
- Test: `tests/test-open-source-docs.sh` (created here, extended in Task 5)

**Interfaces:**
- Produces: `tests/test-open-source-docs.sh` with `assert_contains <file> <text>` / `assert_not_contains <file> <text>` helpers (file as first argument, unlike `tests/test-readme-docs.sh`), for Task 5 to extend.

- [ ] **Step 1: Write the failing test**

Assertions:
- `LICENSE`: first line, trimmed, is `GNU AFFERO GENERAL PUBLIC LICENSE`; contains `Version 3, 19 November 2007` and `END OF TERMS AND CONDITIONS`; larger than 30000 bytes.
- `node -p "require('./package.json').license"` prints `AGPL-3.0-only`; `node -p "require('./package.json').private"` prints `true`; `node -p "require('./package-lock.json').packages[''].license"` prints `AGPL-3.0-only`.
- `README.md` contains `## License`, `AGPL-3.0-only`, `the agent-forge contributors`, `[LICENSE](LICENSE)`; `## License` is the last `## ` heading.

- [ ] **Step 2: Run it to see it fail**

Run: `bash tests/test-open-source-docs.sh`
Expected: FAIL lines.

- [ ] **Step 3: Add the files**

`curl -fsSL -o LICENSE https://www.gnu.org/licenses/agpl-3.0.txt` (verbatim, never retyped). Add the `license` field; update the lockfile with `npm install --package-lock-only --ignore-scripts` and check `git diff package-lock.json` only adds the root `license` line (else hand-edit that one line). Append to `README.md`:

```markdown
## License

Copyright (C) 2026 the agent-forge contributors.

agent-forge is free software, licensed under the GNU Affero General Public
License, version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE).
```

- [ ] **Step 4: Run the tests**

Run: `bash tests/test-open-source-docs.sh && npm test`
Expected: `FAIL=0`; `npm test` green (`tests/test-readme-docs.sh` included).

- [ ] **Step 5: Commit**

```bash
git add LICENSE package.json package-lock.json README.md tests/test-open-source-docs.sh
git commit -m "chore: licence AGPL-3.0-only"
```

---

### Task 5: SECURITY.md, CONTRIBUTING.md and the README pointers

**Files:**
- Create: `SECURITY.md`, `CONTRIBUTING.md`
- Modify: `README.md` ("Developing agent-forge" section)
- Test: `tests/test-open-source-docs.sh` (extend)

**Interfaces:**
- Consumes: Task 2's `npm run hooks:install` and messages; Task 3's job name `secrets`; Task 4's test helpers.

Content is spec §4.6 (`SECURITY.md`) and §4.7 (`CONTRIBUTING.md`), in English, short, linking to `README.md`, `ansible/README.md` and GitHub's docs rather than repeating them. `CONTRIBUTING.md` also says: install Betterleaks 1.x with the package manager (`brew install betterleaks`, `dnf install betterleaks`) and check `betterleaks version`; never run it with `--validation` or `-v`; how to record a false positive (`.betterleaksignore`, one fingerprint per line with a comment, as Betterleaks prints it); changes to `.github/`, `.githooks/` and `.betterleaksignore` get extra scrutiny (spec §5).

- [ ] **Step 1: Extend the test**

- `SECURITY.md` contains: `Report a vulnerability`, `7 days`, `main`, `not maintained`, `not a security boundary`, `container/pre-bash.sh`, `upstream`.
- `CONTRIBUTING.md` contains: `fork`, `signed`, `--force-rebase --gpg-sign`, `--force-with-lease`, `npm test`, `npm run check`, `npm run test:ansible`, `FORGE_INTEGRATION=1`, `ansible/tests/vm-test.sh`, `npm run hooks:install`, `betterleaks version`, `--validation`, `.betterleaksignore`, `CLAUDE.md`, `SECURITY.md`, `AGPL-3.0-only`, `feat:`.
- `README.md` "Developing agent-forge" contains `CONTRIBUTING.md` and `npm run hooks:install`.
- No personal-value assertions (same reason as Task 1, Step 1): the reviewer reads the two documents for them instead.

- [ ] **Step 2: Run it to see it fail**

Run: `bash tests/test-open-source-docs.sh`
Expected: FAIL lines for the new assertions only.

- [ ] **Step 3: Write the two documents and the README lines** (a first bullet in "Developing agent-forge": read `CONTRIBUTING.md`, install the secret-scanning hook once with `npm run hooks:install`).

- [ ] **Step 4: Run the tests**

Run: `bash tests/test-open-source-docs.sh && npm test && npm run check`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add SECURITY.md CONTRIBUTING.md README.md tests/test-open-source-docs.sh
git commit -m "docs: SECURITY.md et CONTRIBUTING.md"
```

---

### Task 6: Final verification, history rescan, pull request

**Files:** none changed (unless a check fails).

- [ ] **Step 1: Full suite**

Run: `npm test && npm run check && npm run test:ansible`
Expected: all green.

- [ ] **Step 2: Rescan the whole history** (spec §4.1, builder's double check), in a new directory under the session scratchpad, never inside the checkout:

```bash
SCAN="$(mktemp -d "<session scratchpad>/af-scan.XXXX")"
git clone --mirror https://github.com/moroine/agent-forge.git "$SCAN/agent-forge.git"
betterleaks git "$SCAN/agent-forge.git" --log-opts="--all" --redact --no-banner --report-format json --report-path "$SCAN/betterleaks.json"
```
Expected: `no leaks found`, exit 0. Report only counts, rule IDs, files and commits if not.

- [ ] **Step 3: The hook on this very branch**

In a throwaway clone of the worktree (`git clone "$PWD" "$SCAN/clone"`, never the maintainer's own clone, whose hooks directory the installer would change): `npm run hooks:install` prints `installed …` and the `not main` warning (the clone is on `agent/open-source`), then `git commit --allow-empty -m test --no-gpg-sign` succeeds and Betterleaks' `no leaks found` line appears.

- [ ] **Step 4: Ask the maintainer**, then push and open the pull request

```bash
git push -u origin agent/open-source
gh pr create --base main --title "Passage en open source : AGPL-3.0, SECURITY, CONTRIBUTING, Betterleaks"
```
The description lists the spec's §4.8 checklist as checkboxes (steps 1–6, plus confirming #78 and #91 before step 2), the §7 calls for review, and ends with the attribution line. Expected: CI green, including the new `secrets` job.

- [ ] **Step 5: Open the follow-up issue** (after the maintainer's go): "Betterleaks v2 quand la 2.0.0 sera stable", saying what changes (`-v` → `--validate`, `--log-opts` → `--revision`, ignore file and fingerprints) and that the hook, `scan-secrets.sh`, `ci.yml` and `CONTRIBUTING.md` need a pass.
