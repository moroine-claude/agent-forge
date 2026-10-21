#!/bin/bash
# Vérifie que README.md documente la v2 par mode (local Lima, distant) et ne
# garde rien de la v1. Les valeurs personnelles ne sont pas vérifiées ici :
# un test permanent devrait les contenir (voir la spec du sous-projet 5).
# Lancer : bash tests/test-readme-docs.sh
set -e

FILE="$(cd "$(dirname "$0")/.." && pwd)/README.md"
PASS=0
FAIL=0

assert_contains() {
  if grep -qF -- "$1" "$FILE"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu présent): $1"
  fi
}

assert_not_contains() {
  if grep -qF -- "$1" "$FILE"; then
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu absent): $1"
  else
    PASS=$((PASS + 1))
  fi
}

# Mode local : forge install fait le travail ; les étapes manuelles sont dans
# ansible/README.md (tests/test-ansible-readme-docs.sh).
assert_contains './cli/forge install'
assert_contains 'forge install --remote'
assert_contains 'forge install --host'
assert_contains 'forge open'
assert_contains '~/.ssh/config.d/agent-forge.config'
assert_contains 'Installing by hand'
assert_contains 'brew install lima'
assert_contains 'pipx install ansible-core'
assert_contains '/dev/kvm'
assert_contains 'IdentityAgent'
assert_contains 'ForwardAgent'
assert_not_contains 'limactl create'
assert_not_contains 'ansible/inventory.lima.example.yml'
assert_not_contains 'ansible-playbook -i'
assert_not_contains 'accepts GitHub'
# Le parcours Ubuntu reste à valider sur une vraie machine.
assert_contains 'not yet validated'

# Sur l'hôte, puis herdr.
assert_contains 'claude auth login'
assert_contains 'forge setup'
assert_contains 'forge image build'
assert_contains 'known_hosts'
# La sortie attendue de forge setup sur un hôte neuf, notices comprises.
assert_contains 'is too old for strict mode'
assert_contains 'herdr is not installed on this host yet'
assert_contains 'herdr --remote forge-local --remote-keybindings server'
assert_contains 'prefix+f'
assert_contains 'prefix+shift+f'

# Récupération du travail.
assert_contains 'forge upload-pack'
assert_contains 'uploadpack'

# Commandes du quotidien et mode strict.
assert_contains 'forge resume'
assert_contains 'forge finish'
assert_contains 'forge list'
assert_contains 'forge egress'
assert_contains '--strict'
assert_contains 'egress-allowlist'
assert_contains 'forge completion bash'
assert_not_contains 'incus --project agent-forge delete --force'
assert_contains 'offers to recreate it'

# Mode distant : forge install --remote écrit l'alias SSH.
assert_not_contains 'Host forge-vm'
assert_not_contains 'Port 2222'

# Corrections de la relecture finale : la v2 est sortie sur main (la branche
# next est retirée, on clone la branche par défaut), le mode strict dépend
# d'un Incus pas encore publié en lts-7.0, le port Lima se change, et les
# pièges d'une première heure ont leur ligne de dépannage.
assert_contains 'git clone https://github.com/moroine/agent-forge.git'
assert_not_contains 'git clone -b next'
assert_contains 'Incus 7.0.2'
assert_contains 'not published yet'
assert_contains 'forge attach'
assert_not_contains 'Host key verification failed'
assert_contains 'REMOTE HOST IDENTIFICATION HAS CHANGED'
assert_contains 'ssh-keygen -R'
assert_contains '-f ~/.config/agent-forge/known_hosts'
assert_contains 'ssh forge-acme true'
assert_contains 'Include config.d/agent-forge.config'
assert_not_contains 'Too many authentication failures'
assert_contains 'default branch'
assert_not_contains 'or your laptop sleeps'

# Ce que forge install change sur la machine, et comment le défaire : chaque
# chemin, le fichier SSH de forge pour forge-local, le bloc herdr du laptop.
assert_contains "What \`forge install\` changes on your machine"
assert_contains 'To undo'
assert_contains '~/.config/agent-forge/hosts.json'
assert_contains '~/.config/agent-forge/hosts/<name>/'
assert_contains 'forge-key.pub'
assert_contains '~/.local/share/agent-forge/collections'
assert_contains '~/.config/herdr/config.toml'
assert_contains '~/.local/bin/forge'
assert_contains '~/.lima/forge-local'
assert_contains '~/.ansible'
assert_contains 'limactl delete forge-local'
assert_contains 'HostKeyAlias forge-local'
assert_contains 'StrictHostKeyChecking accept-new'
assert_contains 'UserKnownHostsFile ~/.config/agent-forge/known_hosts'
assert_contains 'IdentityFile ~/.config/agent-forge/hosts/forge-local/forge-key.pub'
assert_contains 'IdentitiesOnly yes'
assert_contains 'ForwardAgent yes'
assert_contains '# >>> agent-forge laptop >>>'
# Les toasts herdr se règlent sur le laptop : forge install les active après
# confirmation, forge setup ne s'en occupe plus.
assert_contains '[ui.toast]'
assert_contains 'delivery = "herdr"'
assert_not_contains 'in-app notifications'

# Rien de la v1 ni du mode Linux direct.
assert_not_contains 'lxc '
assert_not_contains 'LXD'
assert_not_contains 'scripts/forge'
assert_not_contains 'tmux'
assert_not_contains 'Ctrl+b d'
assert_not_contains 'ufw'
assert_not_contains 'forge image build super'
assert_not_contains 'agent-super'
assert_not_contains 'incus admin init'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
