#!/bin/bash
# Claude Code pre-bash hook
# Bloque les commandes dangereuses avant exécution et journalise toutes les commandes.
# Input: JSON via stdin avec .tool_input.command

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Journal d'audit persistant dans le workspace (survit à la suppression du container côté host)
AUDIT_LOG="/workspace/.claude/bash-audit.log"
mkdir -p "$(dirname "$AUDIT_LOG")" 2>/dev/null
printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$COMMAND" >> "$AUDIT_LOG" 2>/dev/null

block() {
  printf '%s\tBLOCKED\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$COMMAND" >> "$AUDIT_LOG" 2>/dev/null
  echo "BLOCKED: $1"
  exit 2
}

# Bloquer git push
if echo "$COMMAND" | grep -qP 'git\s+push'; then
  block "git push non autorisé. Les modifications restent sur la branche agent."
fi

# Bloquer le passage sur main/master
if echo "$COMMAND" | grep -qP 'git\s+(checkout|switch)\s+(main|master)'; then
  block "Passage sur main/master non autorisé. Rester sur la branche agent/*."
fi

# Bloquer git merge
if echo "$COMMAND" | grep -qP 'git\s+merge(\s|$)'; then
  block "git merge non autorisé. Ouvrir une PR à la place."
fi

# Bloquer git rebase
if echo "$COMMAND" | grep -qP 'git\s+rebase(\s|$)'; then
  block "git rebase non autorisé."
fi

# Bloquer le détournement des git hooks via git config
# Empêche: git config --global core.hooksPath /tmp
if echo "$COMMAND" | grep -qP 'git\s+config.*core\.(hooksPath|fsmonitor|sshCommand)'; then
  block "Modification de core.hooksPath/fsmonitor/sshCommand non autorisée."
fi

# Bloquer rm -rf (suppression récursive forcée)
if echo "$COMMAND" | grep -qP 'rm\s+.*(-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r)'; then
  block "rm -rf non autorisé."
fi

# Bloquer sudo
if echo "$COMMAND" | grep -qP '(^|\s)sudo(\s|$)'; then
  block "sudo non autorisé."
fi

# Bloquer l'upload de données via curl/wget vers des hosts non autorisés
# Whitelist : github.com, api.anthropic.com, raw.githubusercontent.com
if echo "$COMMAND" | grep -qP '(curl|wget).*(-d\s|--data|--upload-file|--post-data|--post-file)'; then
  if ! echo "$COMMAND" | grep -qP '(github\.com|api\.anthropic\.com|raw\.githubusercontent\.com)'; then
    block "Upload curl/wget vers host non autorisé."
  fi
fi

exit 0
