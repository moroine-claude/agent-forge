# agent-forge — Instructions pour Claude

## Contexte
Tu travailles sur `agent-forge`, un repo d'infrastructure pour déployer des agents Claude Code dans des containers LXD isolés sur un serveur Ubuntu dédié.

## Stack
- **Hôte** : Ubuntu 24.04, LXD, UFW, Fail2ban
- **Containers** : Ubuntu 24.04, Node.js LTS, pnpm, Claude Code, Google Chrome headless
- **User agent** : `aiuser` (no sudo, scoped to `/workspace`)
- **Auth** : SSH Ed25519, YubiKey signing, GitHub Deploy Keys

## Périmètre
- Scripts dans `scripts/`
- Templates dans `templates/`
- Config files dans `config/`
- Documentation dans `README.md`

## Conventions

### Git
- Branche de travail : `agent/agent-forge`
- Commits signés automatiquement
- Messages conventionnels : `feat:`, `fix:`, `chore:`, `docs:`
- Ne jamais toucher à `main` directement : jamais de `git checkout main`, jamais de `git merge`, jamais de push vers `main`
- En mode autonome (permission-mode `auto` — que ce soit cette session ou un container provisionné par `forge start`) : push autorisé uniquement vers `agent/<branche>` (`git push -u origin agent/<branche>`), puis ouverture d'une PR avec `gh pr create --base main`. Jamais de merge automatique — la PR est revue et mergée par un humain. C'est le même flux que le "Autonomous PR flow" documenté dans `README.md`.
- En dehors du mode autonome (session interactive), demander confirmation avant tout push, même vers `agent/<branche>`

### Scripts
- Bash strict mode : `set -e` obligatoire
- Variables entre guillemets : `"$VAR"` pas `$VAR`
- Commenter les blocs non évidents
- Tester les préconditions en début de script (ex: vérifier qu'un container existe avant d'y entrer)

### Sécurité
- Ne jamais hardcoder de credentials, clés, tokens
- Les clés SSH sont montées depuis l'hôte, jamais stockées dans l'image
- UID mapping LXD : `aiuser` (1001 dans le container) = `1001001` sur l'hôte
- Toute nouvelle règle UFW doit être justifiée en commentaire

## Ce que tu peux faire
- Modifier `scripts/forge` et `scripts/lib/forge-*.sh`
- Mettre à jour le template `CLAUDE.md`
- Mettre à jour `README.md`
- Mettre à jour les config files

## Ce que tu ne dois pas faire
- Modifier les clés SSH ou credentials
- Changer l'architecture de sécurité sans validation explicite
- Push sur `main`, ou merger une PR toi-même (même en mode autonome)
- Exécuter des commandes sur le système hôte en dehors de `/workspace`
