#!/bin/bash
# Vérifie que ansible/README.md garde le parcours manuel (« Installing by
# hand ») que README.md a cédé à `forge install`.
# Lancer : bash tests/test-ansible-readme-docs.sh
set -e

FILE="$(cd "$(dirname "$0")/.." && pwd)/ansible/README.md"
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

assert_contains 'Installing by hand'
# La VM Lima. --tty=false : limactl create poserait sinon une question.
assert_contains 'limactl create --tty=false --name forge-local ansible/lima/forge.yaml'
assert_not_contains 'limactl create --name'
assert_contains 'limactl start forge-local'
assert_contains ".ssh.localPort = "
# Inventaire, collections, playbook.
assert_contains 'ansible/inventory.lima.example.yml'
assert_contains 'ansible-galaxy collection install -r ansible/requirements.yml'
assert_contains 'ansible-playbook -i'
# Le bloc SSH.
assert_contains 'Host forge-local'
assert_contains 'Port 60022'
assert_contains 'User forge'
assert_contains 'HostKeyAlias forge-local'
assert_contains 'ForwardAgent yes'
assert_contains 'IdentityAgent'
assert_contains 'Host forge-vm'
# Le fichier SSH de forge install, et l'Include qui le lit pour tout hôte.
assert_contains '~/.ssh/config.d/agent-forge.config'
assert_contains 'Include config.d/agent-forge.config'
assert_contains 'Match all'
# Sur l'hôte.
assert_contains 'claude auth login'
assert_contains 'forge setup'
assert_contains 'forge image build'
assert_contains 'herdr --remote forge-local --remote-keybindings server'
# Les toasts herdr, réglage de la machine de l'utilisateur.
assert_contains '~/.config/herdr/config.toml'
assert_contains 'delivery = "herdr"'
# Dépannage du parcours manuel.
assert_contains 'REMOTE HOST IDENTIFICATION HAS CHANGED'
assert_contains 'Too many authentication failures'
assert_contains 'ansible_become_exe: sudo.ws'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
