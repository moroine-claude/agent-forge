#!/bin/bash
set -e

# next-task <short-name>
# Human-invoked (via `!next-task <name>` from inside a live Claude session),
# never by the agent itself — outside the agent's own tool loop, so
# pre-bash.sh's "the agent never switches branches" guarantee is untouched.
# Reuses the current container for a new task: refuses on dirty/unpushed
# WIP, then checks out a fresh branch from origin/main.

# All output is prefixed with [operator] so the agent does not interpret
# these messages as instructions directed at it.
err() { echo "[operator] $*" >&2; }

if [ -z "$1" ]; then
  err "Usage: next-task <short-name>"
  exit 1
fi

SHORT_NAME="$1"
if [[ ! "$SHORT_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  err "Error: short-name must only contain [A-Za-z0-9._-], got: $SHORT_NAME"
  exit 1
fi
cd /workspace

DIRTY=$(git status --porcelain)
if [ -n "$DIRTY" ]; then
  err "Error: /workspace has uncommitted changes:"
  err "$DIRTY"
  err "Please commit or discard them before running next-task."
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

if [[ ! "$CURRENT_BRANCH" =~ ^agent/ ]]; then
  err "Error: current branch is $CURRENT_BRANCH, not an agent/* branch."
  err "next-task is meant to be run from inside a forge-provisioned container."
  exit 1
fi

AHEAD_OF_MAIN=$(git log --oneline "origin/main..$CURRENT_BRANCH")
if [ -n "$AHEAD_OF_MAIN" ]; then
  if ! git rev-parse --verify "origin/$CURRENT_BRANCH" > /dev/null 2>&1; then
    err "Error: branch $CURRENT_BRANCH has no origin/$CURRENT_BRANCH — it has never been pushed."
    err "Please push it before running next-task, or the commits will be left behind."
    exit 1
  fi

  UNPUSHED=$(git log --oneline "origin/$CURRENT_BRANCH..$CURRENT_BRANCH")
  if [ -n "$UNPUSHED" ]; then
    err "Error: branch $CURRENT_BRANCH has unpushed commits:"
    err "$UNPUSHED"
    err "Please push them before running next-task, or they will be left behind."
    exit 1
  fi
fi

git fetch origin
git checkout -b "agent/$SHORT_NAME" origin/main

echo "[operator] Ready on branch agent/$SHORT_NAME."
