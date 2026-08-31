# Backlog — agent-forge

Follow-ups split out of a brainstorming session, each awaiting its own
spec → plan → implementation cycle.

*No open items.*

## Resolved

- **Host terminal garbles text on resize** (raised 2026-08-28, fixed
  2026-08-31). Diagnosed to layer 2: the pty behind `lxc exec` resized
  correctly, but the `su - aiuser -c "..."` wrapper around `tmux` kept
  SIGWINCH from reaching the tmux client, which went on drawing into a stale
  grid. Fixed by making tmux the direct target of `lxc exec` in
  `_forge_attach_task` (`scripts/lib/forge-start.sh`); see the comment there
  for the full rationale.
