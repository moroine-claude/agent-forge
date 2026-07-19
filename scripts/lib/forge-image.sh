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
  # Profil "agent" (pas le défaut) : il faut security.nesting pour que
  # dockerd-rootless-setuptool.sh puisse réellement démarrer le daemon
  # pendant le build, pas seulement installer les fichiers/units — sans
  # nesting, le démarrage du service échoue ("control process exited with
  # error code", confirmé en conditions réelles).
  lxc launch ubuntu:24.04 "$setup" --profile agent

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
  echo "Installing Docker (rootless)..."
  lxc exec "$setup" -- apt install -y uidmap dbus-user-session
  lxc exec "$setup" -- bash -c 'mkdir -p -m 755 /etc/apt/keyrings && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && chmod a+r /etc/apt/keyrings/docker.asc'
  lxc exec "$setup" -- bash -c 'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list'
  lxc exec "$setup" -- bash -c 'apt update && apt install -y docker-ce-cli docker-ce-rootless-extras docker-compose-plugin'
  lxc exec "$setup" -- useradd -m -s /bin/bash aiuser
  # useradd -m ne corrige ni l'ownership ni le contenu (skel) d'un
  # /home/aiuser préexistant — seulement d'un répertoire qu'il vient de
  # créer. On force donc l'ownership explicitement plutôt que de compter
  # sur cet effet de bord, sinon $HOME reste root: et
  # dockerd-rootless-setuptool.sh échoue plus loin avec "HOME needs to be
  # writable" (confirmé en conditions réelles).
  lxc exec "$setup" -- chown -R aiuser:aiuser /home/aiuser
  lxc exec "$setup" -- bash -c "mkdir -p /workspace /home/aiuser/.ssh /home/aiuser/.claude /home/aiuser/.local/bin && chown aiuser:aiuser /workspace /home/aiuser/.ssh /home/aiuser/.claude /home/aiuser/.local/bin && chmod 750 /workspace && chmod 700 /home/aiuser/.ssh"
  echo "Configuring rootless Docker for aiuser..."
  # useradd -m auto-assigns a subuid/subgid range on Ubuntu 24.04 (via
  # shadow-utils, tied to the user's own UID) ; on remplace cette entrée par
  # une plage connue plutôt que d'en ADDitionner une seconde, sinon les deux
  # plages se chevauchent et newuidmap rejette l'écriture dans uid_map
  # (EINVAL) au moment du setup rootless ci-dessous.
  lxc exec "$setup" -- bash -c "sed -i '/^aiuser:/d' /etc/subuid /etc/subgid"
  lxc exec "$setup" -- bash -c "echo 'aiuser:200000:65536' >> /etc/subuid"
  lxc exec "$setup" -- bash -c "echo 'aiuser:200000:65536' >> /etc/subgid"
  lxc exec "$setup" -- loginctl enable-linger aiuser
  lxc exec "$setup" -- su - aiuser -c "dockerd-rootless-setuptool.sh install --skip-iptables"
  lxc exec "$setup" -- su - aiuser -c "systemctl --user enable docker"
  lxc exec "$setup" -- su - aiuser -c "echo 'export DOCKER_HOST=unix:///run/user/1001/docker.sock' >> /home/aiuser/.bashrc"
  lxc exec "$setup" -- su - aiuser -c "echo 'export PATH=/usr/bin:\$PATH' >> /home/aiuser/.bashrc"

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
