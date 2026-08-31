# Backlog — agent-forge

Follow-ups split out of a brainstorming session, each awaiting its own
spec → plan → implementation cycle.

## Host terminal garbles text on resize

- **Raised**: 2026-08-28 (during the parallel-features/worktrees brainstorm).
- **Symptom**: resizing the host terminal while attached to a container session
  scrambles the display — text overwrites stale cells.
- **Already known**: `htop` garbles too, not just the Claude Code TUI → the fault
  is *upstream* of the app (layers 1–2), not the TUI (layer 3). The display chain
  is `host terminal → lxc exec (pty) → tmux → TUI`.
- **First diagnostic** (needs host access, ~1 min): attach a session, resize the
  terminal, run `stty size`.
  - Shows the **old** size ⇒ SIGWINCH isn't reaching the container pty: `lxc exec`
    (layer 1). tmux config won't help; fix via a recent LXD or by attaching over
    **SSH** (port 2222 is already open) instead of `lxc exec`.
  - Shows the **new** size but still garbled ⇒ tmux/redraw (layer 2): try
    `aggressive-resize`, `window-size latest`, `refresh-client -S`.
- **Why deferred**: orthogonal to the worktree/versioning redesign, and needs
  host-side diagnosis (unavailable from inside an agent container) before any fix.
- **Next step**: run the `stty size` test, then brainstorm a focused spec.
