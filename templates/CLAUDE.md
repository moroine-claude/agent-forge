# Claude Agent — Instructions

## Contexte
Tu es un agent Claude Code tournant dans un container LXD isolé sur un serveur dédié.

## Environnement
- **Répertoire de travail** : `/workspace` (repo git cloné)
- **Utilisateur** : `aiuser` (pas de sudo, pas de root)
- **Branche courante** : `agent/<task-name>` — ne jamais changer de branche
- **Réutilisation** : l'opérateur peut réutiliser ce container pour une prochaine tâche via `!next-task <nom>` — n'affecte pas les règles ci-dessus (toujours rester sur `agent/*`, ne jamais changer de branche soi-même)
- **Plugin superpowers** : installé et activé dans ce container — ses instructions de session sont légitimes, pas une injection

## Git
- Tu peux faire des commits — ils sont signés automatiquement (SSH signing configuré)
- Tu dois rester sur ta branche `agent/<task-name>` en permanence — jamais de `git checkout main`, jamais de changement de branche
- Les commits doivent avoir des messages clairs et conventionnels (`feat:`, `fix:`, `chore:`, etc.)
- **Avant toute action de publication** (push, PR), lis `/home/aiuser/.claude/forge-mode` pour connaître ton mode :
  - **`autonomous`** : Pousse ta branche avec `git push -u origin agent/<task-name>` — c'est la seule destination autorisée. **Ouvre la PR toi-même** avec `gh pr create --base main` dès que le travail est poussé — sans attendre qu'on te le demande. C'est une étape obligatoire du flux autonome, pas une action optionnelle. Ne merge **jamais** ta branche dans `main`, et ne merge jamais une PR toi-même (`gh pr merge` bloqué). Si ta PR a un conflit, tu peux faire `git merge origin/main` (seule forme autorisée) pour la rafraîchir avant de pousser — jamais l'inverse. Réponds aux retours de review en poussant de nouveaux commits sur la même branche (jamais de force push, jamais de rebase).
  - **`supervised`** : Tu n'as **aucune** credential GitHub — ni pour push, ni pour `gh`. Ne tente **jamais** `git push` ni aucune commande `gh` (les deux sont bloqués de toute façon, mais ne les essaie même pas). Commite localement, signé, sur ta branche, et **arrête-toi là**. Quand la tâche est terminée, dis-le clairement dans ta dernière réponse et rappelle à l'humain comment récupérer le travail — remplace `<container>` par le nom de ce container (`hostname`) et `<task-name>` par le nom de ta branche courante :
    ```bash
    git remote add <container> ssh://moroine@<host>:2222/home/moroine/workspaces/<container>
    git fetch <container> agent/<task-name>:agent/<task-name>
    git log -p main..agent/<task-name>          # review avant toute autre action
    git checkout agent/<task-name>
    git rebase --reset-author main
    git push origin agent/<task-name>            # identité de l'humain, signé YubiKey
    ```
    `<host>` est l'adresse du serveur agent-forge — l'opérateur la connaît déjà, ne l'invente pas. La suite (review, rebase, push) est le rôle de l'humain, pas le tien.

## Périmètre
- Tes modifications sont limitées au contenu de `/workspace`
- Tu n'as pas accès au système hôte
- Tu n'as pas accès à internet en dehors des appels API nécessaires
