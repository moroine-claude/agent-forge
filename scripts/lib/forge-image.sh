# forge image build (alias: forge image update)
# Scripts the manual agent-base build sequence from README §5, plus
# installing next-task. Only affects containers created after the rebuild —
# already-running containers are not patched in place.

cmd_forge_image() {
  case "${1:-}" in
    build|update)
      _forge_image_build
      ;;
    *)
      echo "Usage: forge image build|update" >&2
      return 1
      ;;
  esac
}

_forge_image_build() {
  local setup="agent-base-setup"

  if lxc info "$setup" > /dev/null 2>&1; then
    echo "Removing leftover $setup container from a previous failed build..."
    lxc delete "$setup" --force
  fi

  echo "Launching scratch container $setup..."
  lxc launch ubuntu:24.04 "$setup"

  lxc exec "$setup" -- apt update
  lxc exec "$setup" -- apt install -y git tmux curl wget unzip zip python3 python3-pip
  lxc exec "$setup" -- bash -c "curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -"
  lxc exec "$setup" -- apt install -y nodejs
  lxc exec "$setup" -- npm install -g pnpm
  lxc exec "$setup" -- npm install -g @anthropic-ai/claude-code
  lxc exec "$setup" -- bash -c 'mkdir -p -m 755 /etc/apt/keyrings && wget -qO /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg'
  lxc exec "$setup" -- bash -c 'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list'
  lxc exec "$setup" -- bash -c 'apt update && apt install -y gh'
  lxc exec "$setup" -- bash -c "wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb && apt install -y --fix-missing /tmp/chrome.deb"
  lxc exec "$setup" -- useradd -m -s /bin/bash aiuser
  lxc exec "$setup" -- bash -c "mkdir -p /workspace /home/aiuser/.ssh /home/aiuser/.claude /home/aiuser/.local/bin && chown aiuser:aiuser /workspace /home/aiuser/.ssh /home/aiuser/.claude /home/aiuser/.local/bin && chmod 750 /workspace && chmod 700 /home/aiuser/.ssh"

  echo "Installing next-task..."
  lxc file push /home/moroine/agent-forge/config/next-task.sh \
    "$setup"/home/aiuser/.local/bin/next-task \
    --uid 1001 --gid 1001 --mode 755

  lxc stop "$setup"
  lxc image delete agent-base 2>/dev/null || true
  lxc publish "$setup" --alias agent-base
  lxc delete "$setup"

  echo "Image agent-base published."
}
