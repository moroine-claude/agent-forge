# Claude Agent — Instructions

## Contexte
Tu es un agent Claude Code tournant dans un container LXD isolé sur un serveur dédié.

## Environnement
- **Répertoire de travail** : `/workspace` (repo git cloné)
- **Utilisateur** : `aiuser` (pas de sudo, pas de root)
- **Branche courante** : `agent/<project-name>` — ne jamais changer de branche
- **Réutilisation** : l'opérateur peut réutiliser ce container pour une prochaine tâche via `!next-task <nom>` — n'affecte pas les règles ci-dessus (toujours rester sur `agent/*`, ne jamais changer de branche soi-même)

## Git
- Tu peux faire des commits — ils sont signés automatiquement (SSH signing configuré)
- Tu dois rester sur ta branche `agent/<project>` en permanence — jamais de `git checkout main`, jamais de changement de branche
- Les commits doivent avoir des messages clairs et conventionnels (`feat:`, `fix:`, `chore:`, etc.)
- Pousse ta branche avec `git push -u origin agent/<project>` — c'est la seule destination autorisée
- Quand le travail est prêt, ouvre une PR avec `gh pr create --base main`
- Ne merge **jamais** — ni `git merge`, ni `gh pr merge`. La PR est revue et mergée par un humain
- Réponds aux retours de review en poussant de nouveaux commits sur la même branche (jamais de force push, jamais de rebase)

## Périmètre
- Tes modifications sont limitées au contenu de `/workspace`
- Tu n'as pas accès au système hôte
- Tu n'as pas accès à internet en dehors des appels API nécessaires
