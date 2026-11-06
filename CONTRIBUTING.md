# Contributing to agent-forge

Thanks for helping. For setup and daily use, see [README.md](README.md); for
the host playbook, see [ansible/README.md](ansible/README.md). Security
issues go through [SECURITY.md](SECURITY.md), not public issues.

## Pull requests

`main` is protected and the maintainer merges.

- Without write access to the repository: fork it, push a branch to your fork
  and open a pull request against `main`.
- With write access: keep pushing `agent/<task>` branches to the repository
  (`forge ship` does this, and needs write access).

## Commits

- Use conventional prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `test:`.
  Messages are in English or French.
- Every commit must be signed (GPG or SSH, shown as "Verified" by GitHub).
  A pull request with one unsigned commit cannot be merged, squash included.
  To set signing up, follow GitHub's guide to
  [signing commits](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits).
- To re-sign a branch before pushing again:
  `git rebase --force-rebase --gpg-sign <base>`, then push your own branch
  with `git push --force-with-lease`.

## Running the tests

```
npm ci
npm test
npm run check
npm run test:ansible
```

`ansible-lint ansible/` is also run in CI. The integration tests
(`FORGE_INTEGRATION=1 npm run test:integration`) and
`ansible/tests/vm-test.sh` need a disposable Incus host and are not run in CI;
see "Developing agent-forge" in [README.md](README.md).

## Secret scanning hook

Install [Betterleaks](https://github.com/betterleaks/betterleaks) 1.x with
your package manager (`brew install betterleaks`, `dnf install betterleaks`)
and check `betterleaks version`. Then install the pre-commit hook once per
clone:

```
npm run hooks:install
```

The hook scans staged changes and blocks the commit on a finding. If
Betterleaks is missing or is not 1.x, it says so and lets the commit through.
CI runs the same scan on the commits a pull request adds (job `secrets`), so
the hook is a convenience: `git commit --no-verify` skips it, CI does not.

Never run Betterleaks with `--validation` or `-v`: they can send what looks
like a secret to a remote service or print it.

For a false positive, add its fingerprint, as Betterleaks prints it, to
`.betterleaksignore` at the repository root: one fingerprint per line, each
with a comment saying why it is not a secret.

Changes to `.github/`, `.githooks/` and `.betterleaksignore` get extra
scrutiny in review: on a pull request, the workflow and the ignore file come
from the pull request's own branch.

## Rules worth knowing

These are summarized from [CLAUDE.md](CLAUDE.md), which is in French and has
the full list:

- Ansible never configures the inside of Incus, and `forge` never touches the
  host OS.
- No personal value (name, login, path, UID, identity, host, address) in code,
  tests or docs.
- Bash scripts use strict mode (`set -e`) and quote every variable.
- Every new nftables or Incus ACL rule has a comment justifying it, and
  nothing flushes the whole nftables ruleset.

## Agents

Claude Code sessions in this repository follow `CLAUDE.md`, and the hook in
`.claude/settings.json` applies to them.

## License

By contributing, you agree that your contribution is licensed under the
repository's license, AGPL-3.0-only (see [LICENSE](LICENSE)).
