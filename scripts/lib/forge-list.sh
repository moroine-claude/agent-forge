# forge list — une ligne par container (repo, mode, état LXD, et s'il tourne
# sur une image plus vieille que le dernier build), suivie d'une ligne indentée
# par worktree de tâche (nom de tâche, état de sa session tmux).
#
# Les largeurs de colonnes sont calculées sur les données, pas figées : un nom
# de repo long élargit sa colonne au lieu de décaler toutes les suivantes.
# D'où les deux passes — on collecte d'abord, on imprime ensuite.
#
# Deux colonnes ont disparu parce qu'elles étaient déductibles et faisaient
# wrapper la sortie : le nom du container (toujours agent-<repo assaini>, cf.
# sanitize_container_name) et la branche d'une tâche (toujours agent/<task>).

# État de la session tmux de chaque tâche d'un container, une ligne
# "<session> <0|1>" par session ouverte. Le probe précédent ne disait que "la
# session existe", donc une session que personne n'a ouverte était rapportée
# comme attachée ; #{session_attached} distingue vraiment les deux.
_forge_session_states() {
  local container="$1"
  lxc exec "$container" -- su - aiuser -c \
    "tmux list-sessions -F '#{session_name} #{session_attached}'" 2>/dev/null || true
}

cmd_forge_list() {
  local name repo mode status latest c_commit build sessions dir task flag row
  local w_repo w_task kind f1 f2 f3 f4
  local -a rows=()

  latest=$(current_image_commit)

  w_repo=4   # largeur de l'en-tête "REPO"
  w_task=0

  for name in $(list_forge_containers); do
    repo=$(forge_container_repo "$name")
    mode=$(forge_container_mode "$name")
    status=$(lxc list "$name" -f json | jq -r '.[0].status')
    c_commit=$(container_image_commit "$name")

    case "$(build_status "$c_commit" "$latest")" in
      up-to-date) build="ok" ;;
      behind)     build="behind" ;;
      *)          build="unknown" ;;
    esac

    # Un container sans métadonnée repo n'a que son nom comme identifiant.
    repo="${repo:-$name}"
    [ "${#repo}" -gt "$w_repo" ] && w_repo=${#repo}
    rows+=("C	$repo	${mode:--}	$status	$build")

    # Un container arrêté ne peut pas être inspecté.
    [ "$status" = "Running" ] || continue

    sessions=$(_forge_session_states "$name")
    while IFS= read -r dir; do
      [ -z "$dir" ] && continue
      task=$(basename "$dir")
      flag=$(awk -v t="$task" '$1 == t { print $2 }' <<< "$sessions")
      case "$flag" in
        1) flag="attached" ;;
        0) flag="detached" ;;
        *) flag="no session" ;;
      esac
      [ "${#task}" -gt "$w_task" ] && w_task=${#task}
      rows+=("T	$task	$flag")
    done < <(_forge_worktree_dirs "$name")
  done

  printf "%-${w_repo}s  %-10s  %-7s  %s\n" "REPO" "MODE" "STATE" "BUILD"

  for row in "${rows[@]}"; do
    IFS=$'\t' read -r kind f1 f2 f3 f4 <<< "$row"
    if [ "$kind" = "C" ]; then
      printf "%-${w_repo}s  %-10s  %-7s  %s\n" "$f1" "$f2" "$f3" "$f4"
    else
      printf "  %-${w_task}s  %s\n" "$f1" "$f2"
    fi
  done
}
