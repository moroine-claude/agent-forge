#!/bin/bash
# Claude Code pre-bash hook
# Blocks dangerous commands before execution
# Input: JSON via stdin with .tool_input.command

COMMAND=$(echo "$1" | jq -r '.tool_input.command // empty')

block() {
  echo "BLOCKED: $1"
  exit 2
}

# Block git push
if echo "$COMMAND" | grep -qE 'git\s+push'; then
  block "git push is not allowed. Changes stay on the agent branch."
fi

# Block switching to main
if echo "$COMMAND" | grep -qE 'git\s+(checkout|switch)\s+main'; then
  block "Switching to main is not allowed. Stay on your agent/* branch."
fi

# Block git merge
if echo "$COMMAND" | grep -qE 'git\s+merge'; then
  block "git merge is not allowed. Open a PR instead."
fi

# Block git rebase
if echo "$COMMAND" | grep -qE 'git\s+rebase'; then
  block "git rebase is not allowed."
fi

# Block rm -rf
if echo "$COMMAND" | grep -qE 'rm\s+(-\w*r\w*f|-\w*f\w*r)'; then
  block "rm -rf is not allowed."
fi

# Block sudo
if echo "$COMMAND" | grep -qE '(^|\s)sudo(\s|$)'; then
  block "sudo is not allowed."
fi

exit 0
