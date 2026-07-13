#!/bin/bash
# Claude Code pre-bash hook
# Bloque les commandes dangereuses avant exécution et journalise toutes les commandes.
# Input: JSON via stdin avec .tool_input.command
# Regex en ERE POSIX (grep -E) uniquement — jamais grep -P/\s : portable
# entre BSD grep (tests sur macOS) et GNU grep (containers Ubuntu).

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

# Politique git push : default-deny.
# Seule forme autorisée : git push [-u] origin agent/<branche>
# (éventuellement comme segment d'une chaîne && ou ;).
# Le déclencheur tolère les options globales de git (-C, -c, --git-dir…)
# pour qu'elles ne contournent pas la politique ; la forme autorisée, elle,
# reste stricte (fail-closed : git -C … push est toujours bloqué).
# La vraie frontière est la branch protection sur main côté GitHub ; ce hook
# est de la défense en profondeur — un filtre regex ne peut pas tout attraper
# (variables, scripts intermédiaires, appels API via curl) et ne prétend pas le faire.
GIT_PUSH_RE='git[[:space:]]+(-[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?[[:space:]]+)*push([[:space:];&|]|$)'
if echo "$COMMAND" | grep -qE "$GIT_PUSH_RE"; then
  # Force push interdit (préserve l'historique de la branche agent)
  if echo "$COMMAND" | grep -qE 'git[[:space:]]+push[^;&|]*[[:space:]](-[A-Za-z]*f[A-Za-z]*|--force(-with-lease)?(=[^[:space:]]+)?)([[:space:]]|$)'; then
    block "git push --force non autorisé."
  fi
  # Suppression de branche distante interdite (--delete, -d, refspec :ref)
  if echo "$COMMAND" | grep -qE 'git[[:space:]]+push[^;&|]*[[:space:]](--delete|-[A-Za-z]*d[A-Za-z]*)([[:space:]]|$)' \
     || echo "$COMMAND" | grep -qE 'git[[:space:]]+push[^;&|]*[[:space:]][^[:space:]]*:'; then
    block "Suppression de branche distante / refspec non autorisée."
  fi
  # Default-deny : tout push qui n'est pas exactement origin agent/* est bloqué.
  # La commande est découpée en segments (;, &, |, retours à la ligne) et
  # CHAQUE segment contenant "git push" doit être de la forme autorisée —
  # sinon un push interdit pourrait se cacher derrière un push autorisé
  # (ex: git push origin agent/x && git push origin main).
  while IFS= read -r SEGMENT; do
    if printf '%s\n' "$SEGMENT" | grep -qE "$GIT_PUSH_RE"; then
      if ! printf '%s\n' "$SEGMENT" | grep -qE '^[[:space:]]*git[[:space:]]+push[[:space:]]+(-u[[:space:]]+)?origin[[:space:]]+agent/[A-Za-z0-9._/-]+[[:space:]]*$'; then
        block "git push autorisé uniquement vers origin agent/*."
      fi
    fi
  done <<< "$(printf '%s\n' "$COMMAND" | tr ';&|' '\n\n\n')"
fi

# gh : l'agent crée et met à jour des PRs, ne merge jamais, ne parle jamais
# à l'API brute, ne touche ni aux repos, ni aux alias, ni aux extensions,
# et ne lit jamais le token.
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])gh[[:space:]]+pr[[:space:]]+(-[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?[[:space:]]+)*merge([[:space:];&|]|$)'; then
  block "gh pr merge non autorisé. La PR est revue et mergée par un humain."
fi
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])gh[[:space:]]+alias([[:space:]]|$)'; then
  block "gh alias non autorisé."
fi
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])gh[[:space:]]+ext(ension)?s?([[:space:]]|$)'; then
  block "gh extension non autorisé."
fi
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])gh[[:space:]]+auth[[:space:]]+token([[:space:];&|]|$)'; then
  block "gh auth token non autorisé."
fi
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])gh[[:space:]]+api([[:space:]]|$)'; then
  block "gh api non autorisé."
fi
if echo "$COMMAND" | grep -qE '(^|[[:space:];&|])gh[[:space:]]+repo([[:space:]]|$)'; then
  block "gh repo non autorisé."
fi

# Bloquer le passage sur main/master
if echo "$COMMAND" | grep -qE 'git[[:space:]]+(checkout|switch)[[:space:]]+(main|master)'; then
  block "Passage sur main/master non autorisé. Rester sur la branche agent/*."
fi

# Bloquer git merge
if echo "$COMMAND" | grep -qE 'git[[:space:]]+merge([[:space:]]|$)'; then
  block "git merge non autorisé. Ouvrir une PR à la place."
fi

# Bloquer git rebase
if echo "$COMMAND" | grep -qE 'git[[:space:]]+rebase([[:space:]]|$)'; then
  block "git rebase non autorisé."
fi

# Bloquer le détournement des git hooks via git config
# Empêche: git config --global core.hooksPath /tmp
if echo "$COMMAND" | grep -qE 'git[[:space:]]+config.*core\.(hooksPath|fsmonitor|sshCommand)'; then
  block "Modification de core.hooksPath/fsmonitor/sshCommand non autorisée."
fi

# Bloquer rm -rf (suppression récursive forcée)
if echo "$COMMAND" | grep -qE 'rm[[:space:]]+.*(-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r)'; then
  block "rm -rf non autorisé."
fi

# Bloquer sudo
if echo "$COMMAND" | grep -qE '(^|[[:space:]])sudo([[:space:]]|$)'; then
  block "sudo non autorisé."
fi

# Bloquer l'upload de données via curl/wget vers des hosts non autorisés
# Whitelist : github.com, api.anthropic.com, raw.githubusercontent.com
if echo "$COMMAND" | grep -qE '(curl|wget).*(-d[[:space:]]|--data|--upload-file|--post-data|--post-file)'; then
  if ! echo "$COMMAND" | grep -qE '(github\.com|api\.anthropic\.com|raw\.githubusercontent\.com)'; then
    block "Upload curl/wget vers host non autorisé."
  fi
fi

exit 0
