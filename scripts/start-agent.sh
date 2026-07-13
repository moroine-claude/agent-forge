#!/bin/bash
set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <project-name>"
  exit 1
fi

PROJECT=$1
CONTAINER="agent-$PROJECT"

# Vérifie que le container existe et tourne
if ! lxc list | grep -q "$CONTAINER.*RUNNING"; then
  echo "Error: container $CONTAINER not running"
  exit 1
fi

echo "Attaching to $CONTAINER as aiuser..."
lxc exec "$CONTAINER" -- su - aiuser -c "
  cd /workspace
  tmux new-session -A -s claude 'claude --permission-mode auto --remote-control ${PROJECT}'
"
