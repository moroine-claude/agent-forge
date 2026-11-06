#!/bin/bash
# Installs .githooks/pre-commit into the current clone: run it from inside the
# clone, optionally with --force to replace a different existing hook.
#
# The hook is copied, never wired through core.hooksPath: that setting would
# redirect every hook of the clone, including the ones other tools install
# (see cli/lib/laptop/replay.ts and the open-source design spec, section 3).
set -e

force=0
case "${1:-}" in
  "") ;;
  --force) force=1 ;;
  *)
    echo "usage: install.sh [--force]" >&2
    exit 2
    ;;
esac

src="$(cd "$(dirname "$0")" && pwd)/pre-commit"

if [ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" != true ]; then
  echo "install.sh: run it from inside a git work tree" >&2
  exit 1
fi

# The common dir is the main repository's .git, also from a linked worktree
# (git only runs hooks from there).
hooks_dir="$(git rev-parse --path-format=absolute --git-common-dir)/hooks"
dest="$hooks_dir/pre-commit"

hooks_path="$(git config --get core.hooksPath || true)"
if [ -n "$hooks_path" ]; then
  echo "warning: core.hooksPath is set to $hooks_path: git will not run $dest"
fi

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [ -n "$branch" ] && [ "$branch" != main ]; then
  echo "warning: installing the hook from $branch, not main"
fi

if [ -e "$dest" ]; then
  if cmp -s "$src" "$dest"; then
    echo "already installed: $dest"
    exit 0
  fi
  if [ "$force" -ne 1 ]; then
    echo "a different pre-commit hook exists at $dest; rerun with --force to replace it"
    exit 1
  fi
fi

mkdir -p "$hooks_dir"
cp "$src" "$dest"
chmod 755 "$dest"
echo "installed $dest"
