# forge list — one line per agent-* container: repo, mode, LXD state, and
# (for running containers) whether a claude tmux session is alive inside.

cmd_forge_list() {
  local name repo mode status tmux_alive

  printf '%-30s %-30s %-12s %-10s %s\n' "CONTAINER" "REPO" "MODE" "STATE" "SESSION"
  for name in $(list_forge_containers); do
    repo=$(forge_container_repo "$name")
    mode=$(forge_container_mode "$name")
    status=$(lxc list "$name" -f json | jq -r '.[0].status')

    tmux_alive="-"
    if [ "$status" = "Running" ]; then
      if lxc exec "$name" -- su - aiuser -c "tmux has-session -t claude" > /dev/null 2>&1; then
        tmux_alive="alive"
      else
        tmux_alive="none"
      fi
    fi

    printf '%-30s %-30s %-12s %-10s %s\n' "$name" "${repo:--}" "${mode:--}" "$status" "$tmux_alive"
  done
}
