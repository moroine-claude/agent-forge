# Security policy

## Supported versions

Only `main` (v2) is supported. v1 (LXD) is not maintained.

## Report a vulnerability

Use GitHub's private vulnerability reporting: open the repository's Security
tab and choose "Report a vulnerability" ([how it works](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
Never report a vulnerability in a public issue or pull request.

agent-forge is maintained by a small team on a best-effort basis. We aim to
acknowledge a report within 7 days.

## In scope

For example:

- escaping a forge container;
- bypassing the strict egress allowlist or the `forge-egress` ACL;
- reaching the forwarded SSH agent or the host from a container;
- the laptop commands (`forge fetch`, `forge ship`) trusting data written by
  an agent;
- weaknesses in the host playbook (`ansible/`).

See the "Security model" section of [README.md](README.md) for what the
design is meant to guarantee.

## Out of scope

- Vulnerabilities in Incus, Claude Code, herdr, Docker or Ubuntu themselves:
  report them upstream.
- `container/pre-bash.sh` is a guardrail against an agent's mistakes. It is
  not a security boundary, so getting past it alone is not a vulnerability.
- What an agent can do inside its own container by design.
