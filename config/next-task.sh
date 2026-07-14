#!/bin/bash
set -e

# next-task <short-name>
# Human-invoked (via `!next-task <name>` from inside a live Claude session),
# never by the agent itself — outside the agent's own tool loop, so
# pre-bash.sh's "the agent never switches branches" guarantee is untouched.
# Reuses the current container for a new task: refuses on dirty/unpushed
# WIP, then checks out a fresh branch from origin/main.

if [ -z "$1" ]; then
  echo "Usage: next-task <short-name>"
  exit 1
fi

SHORT_NAME="$1"
if [[ ! "$SHORT_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Error: short-name must only contain [A-Za-z0-9._-], got: $SHORT_NAME"
  exit 1
fi
cd /workspace

DIRTY=$(git status --porcelain)
if [ -n "$DIRTY" ]; then
  echo "Error: /workspace has uncommitted changes:"
  echo "$DIRTY"
  echo "Commit or discard them first."
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

if [[ ! "$CURRENT_BRANCH" =~ ^agent/ ]]; then
  echo "Error: current branch is $CURRENT_BRANCH, not an agent/* branch."
  echo "next-task is meant to be run from inside a forge-provisioned container."
  exit 1
fi

if ! git rev-parse --verify "origin/$CURRENT_BRANCH" > /dev/null 2>&1; then
  echo "Error: branch $CURRENT_BRANCH has no origin/$CURRENT_BRANCH — it has never been pushed."
  echo "Push it first, or the commits on it will be left behind."
  exit 1
fi

UNPUSHED=$(git log --oneline "origin/$CURRENT_BRANCH..$CURRENT_BRANCH")
if [ -n "$UNPUSHED" ]; then
  echo "Error: branch $CURRENT_BRANCH has unpushed commits:"
  echo "$UNPUSHED"
  echo "Push them first, or they'll be left behind."
  exit 1
fi

git fetch origin
git checkout -b "agent/$SHORT_NAME" origin/main

echo "Ready on branch agent/$SHORT_NAME."
