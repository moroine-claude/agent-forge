# forge list — one header row per agent-* container (repo, mode, state, and
# whether it's running an older image than the latest build), followed by an
# indented row per feature worktree (task, branch, session state).
cmd_forge_list() {
  local name repo mode status latest c_commit build task dir sess

  latest=$(current_image_commit)

  printf '%-28s %-26s %-11s %-9s %s\n' "CONTAINER" "REPO" "MODE" "STATE" "BUILD"
  for name in $(list_forge_containers); do
    repo=$(forge_container_repo "$name")
    mode=$(forge_container_mode "$name")
    status=$(lxc list "$name" -f json | jq -r '.[0].status')

    c_commit=$(container_image_commit "$name")
    case "$(build_status "$c_commit" "$latest")" in
      up-to-date) build="ok" ;;
      behind)     build="behind ($(echo "$c_commit" | cut -c1-7)->$(echo "$latest" | cut -c1-7))" ;;
      *)          build="unknown" ;;
    esac

    printf '%-28s %-26s %-11s %-9s %s\n' "$name" "${repo:--}" "${mode:--}" "$status" "$build"

    if [ "$status" = "Running" ]; then
      while IFS= read -r dir; do
        [ -z "$dir" ] && continue
        task=$(basename "$dir")
        if lxc exec "$name" -- su - aiuser -c "tmux has-session -t $task" > /dev/null 2>&1; then
          sess="attached"
        else
          sess="detached"
        fi
        printf '  %-24s %-24s %s\n' "$task" "agent/$task" "$sess"
      done < <(_forge_worktree_dirs "$name")
    fi
  done
}
