# Spike herdr-core (`hc`) pour DX 5

**Date :** 2026-11-11
**Question :** herdr-core peut-il piloter des agents dans des containers forge, avec un container « Pilote » qui lance et contrôle les autres agents ? (Refs #92)
**Statut :** terminé. Travail jetable : les containers, le dossier jetable et le fichier de token ont été supprimés ; ce rapport est le livrable. Aucun changement de code.

## Versions et montage

| Élément | Version |
|---|---|
| `hc` client (VM, dossier jetable) | 0.1.20 |
| `hc` dans les containers | 0.1.20 (copié par `--install`) |
| Claude Code (container) | 2.1.311 |
| Incus (client et serveur) | 7.0.2 |

- **« Laptop » :** `hc` installé dans un dossier jetable (`HC_INSTALL_DIR=<jetable>/bin`, `HC_SESSION=spike`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR` dans ce dossier). L'installeur a été téléchargé puis lancé (`sh install.sh`), pas passé dans un `curl | sh` : même script, même somme SHA-256 vérifiée par lui.
- **« Hôte » :** l'Incus de la VM, projet `agent-forge`. Deux containers depuis `agent-base` avec le profil `agent-forge` (A et B), provisionnés comme `tests/integration/lib.ts` : `aiuser`, `/workspace` avec un petit dépôt git, `CLAUDE.md`, `pre-bash.sh` et `settings.json` (propriété de root), `onboarding` (`claude.json`), marqueur `supervised`. Pas de `.credentials.json` : l'authentification passe uniquement par le token.
- **Transport :** un script jetable hors du dépôt, appelé par `--via '<script> <container>'`. Il lit le token dans un fichier jetable à chaque connexion, le passe par `incus exec --env`, et `su -w CLAUDE_CODE_OAUTH_TOKEN - aiuser -c "$2"` le garde. Le script reçoit la ligne shell de `hc` en un seul argument.

```sh
hc machine add --name spike-a --temp --install --via '<jetable>/via/fwd.sh spike-herdr-a'
```

## Vérification 1 : transport — OK (un point partiel)

| Commande | Résultat |
|---|---|
| `hc machine add … --install` | `… now has hc 0.1.20`. L'état passe de `connecting` à `connected` en quelques secondes. |
| `hc machine ls` | `spike-a` `connected`, `version 0.1.20`, `via: true`. |
| `hc exec --on spike-a id` | `uid=1001(aiuser) gid=1001(aiuser)` : **OK** |
| `hc run --on spike-a --bg --name shell1` | terminal `spike-a/t1`, shell `aiuser`, `HC_TERMINAL_ID=t1`. |
| `hc run --on spike-a --cwd /workspace` (sans `--bg`, via `script` pour avoir un tty) | terminal `spike-a/t2` créé dans `/workspace`. **Partiel** : je n'ai pas pu lire une vraie session interactive (la sortie capturée par `script` était incomplète) ; l'attache interactive reste à essayer à la main. |
| `hc server stop` côté client, puis `hc ls` | Le core du container (`herdr-core serve` + son holder) est toujours là ; après reconnexion, `shell1` est `live` et son historique est lisible : **OK** |

Détails utiles :
- Le core du container est un service systemd utilisateur (`hc-serve-*.service`, `hc-hold-*.service`) : il survit à la fin de la connexion `incus exec`.
- Dans le container, la session est `default` : `HC_SESSION` du client n'est pas transmise.
- `hc` n'est pas dans le `PATH` d'`aiuser` (voir « Ce qui a surpris »).
- Les chemins distants démarrent dans `/home/aiuser` ; il faut `--cwd /workspace`.

## Vérification 2 : statut de Claude Code (OSC 7501) — OK, `blocked` non observé

- `claude --version` dans le container : `2.1.311` (≥ 2.1.295 : OK).
- **Premier lancement, sans token** (`hc run --bg --on spike-a --cwd /workspace --name cl1 claude`) : pas de dialogue de premier lancement ni de confiance (l'onboarding est pré-accepté par `claude.json`, comme le fait forge) ; écran d'accueil avec « Not logged in » ; `hc get` donne déjà `status: {app: claude-code, state: idle}`.
- **Avec le token** : l'en-tête affiche `Sonnet 5.5 · Claude API`, `status idle`.
- Consigne par `hc send spike-a/cl2 "Liste les fichiers du dépôt courant avec ls puis réponds en une phrase."` : le retour est `{"started":true,"status":"idle","turn":0}`. Dans `hc events` :

| Événement `status` | Moment |
|---|---|
| `idle` | au démarrage, dès l'écran d'accueil |
| `working` | quelques secondes après le `send` ; un second événement `working` apporte `msg: "Listing repository files"` |
| `done` | à la fin du tour, suivi d'un événement `turn` (`state: done`, `turn: 1`) |

- Le statut reste `done` tant qu'on ne renvoie rien : il ne retourne pas à `idle`.
- **`blocked` :** pas observé. Claude Code 2.1.311 démarre en mode auto (« Auto mode is now Claude Code's default permission mode ») et ne s'arrête sur aucune permission pour `ls`. Je n'ai pas cherché à le provoquer (un refus du hook `pre-bash.sh` n'est pas une demande de permission).
- Titre du terminal : suit le sujet de la conversation (événement `title`).

## Vérification 3 : le Pilote — OK

Consigne donnée au Pilote par la tâche de lancement (`hc run --bg --on spike-a --cwd /workspace --name pilote claude "<consigne>"`) : lire `hc --skill`, lancer `enfant`, l'attendre par `hc wait --children all`, résumer, puis dire quel est le parent de `enfant`.

- **Hook `pre-bash.sh` :** laisse passer `hc` (testé directement sur `hc ls`, `hc run …`, `hc --skill`, `hc wait --children all`, `hc send …` : exit 0) et le Pilote a bien exécuté toutes ces commandes.
- **Parent :** `hc get spike-a/enfant` donne `parent: spike-a/t7` (le Pilote). `hc ls` côté client montre `pilote` (`parent: null`) et `enfant` (`parent` du Pilote) sur la même machine.
- **Réponse :** le Pilote a reçu `<hc from="t8 enfant">README.md, index.js (+ .claude/ non suivi)</hc>` comme prochaine entrée. Le `hc wait --children all` est revenu avec `reason: "message"` (et non « child done ») : c'est le comportement documenté, la réponse arrive comme entrée du Pilote.
- **Note de fin :** `hc kill spike-a/enfant` → le Pilote a reçu `<hc>t8 enfant exited (exit 129). Read: hc read t8</hc>`. Il a compris que c'était un SIGHUP après la fin de la tâche et a retiré le terminal avec `hc rm`.
- **Côté client :** `hc ls`, `hc get`, `hc read`, `hc events` voient les terminaux du Pilote et de l'enfant avec le préfixe `spike-a/`, les statuts de chacun (`working` puis `done`) et leurs tours.
- **Coût :** le Pilote a mené la tâche en une quinzaine de secondes par tour ; l'enfant en moins de dix.

## Vérification 4 : ce que le Pilote ne peut pas faire — OK (frontière nette)

Commandes lancées dans A, en `aiuser` (`hc exec --on spike-a -- bash <script>`) :

| Question | Résultat |
|---|---|
| Core ou socket `hc` de l'hôte ? | Non. `/run/user/1001/herdr-core/` ne contient que le socket du core du container (`default.sock` et son holder). Les sockets de l'hôte ne sont pas montés. |
| Machines (`hc machine ls`) ? | `{"machines":[]}` : aucune. |
| `hc ls` dans A | Ne liste que les terminaux de ce core. |
| `incus` ? | Absent. Le socket d'invité `/dev/incus/sock` répond « Access denied for non-root user ». |
| Joindre B (TCP 22, 80, 443, 8000, 8443, 7777) | Fermé : `forge-egress` bloque les plages privées. |
| Joindre l'hôte (passerelle du bridge, ports 22, 8443, 8000) | Fermé. |
| Métadonnées cloud (`169.254.169.254`) | Délai dépassé. |
| Internet | Ouvert (`https://releases.herdr.dev/` : 404, donc atteint). C'est l'état par défaut d'un container non strict. |
| Agent SSH | `SSH_AUTH_SOCK` pointe sur un agent local au container (`/run/user/1001/openssh_agent`, socket-activé, **vide**). Pas de `~/.ssh`. |

Conclusion : le Pilote ne peut rien faire hors de son container. Il pilote les agents **du même core** (A) et rien d'autre. Un Pilote qui devrait lancer un agent dans B ou sur l'hôte a besoin d'un intermédiaire côté hôte, et cet intermédiaire doit être joignable par un canal que le container peut ouvrir.

## Vérification 5 : l'agent SSH — hypothèse confirmée

Montage : `ssh-agent` jetable avec une clé jetable, `sshd` jetable en espace utilisateur sur la VM (port local, hors de `/etc`), `ssh -A` vers lui.

**Sans gestionnaire systemd utilisateur** (la VM, avec un `XDG_RUNTIME_DIR` jetable : le core démarre « tout seul », pas en service) :
- Core lancé depuis la connexion `ssh -A` : un terminal de ce core voit `SSH_AUTH_SOCK` et `ssh-add -l` liste la clé : **l'agent est transmis**.
- À une **seconde** connexion `ssh -A` (le core tourne toujours), un nouveau terminal garde le `SSH_AUTH_SOCK` de la **première** connexion : le socket n'existe plus, `ssh-add -l` échoue (`Error connecting to agent`). La valeur est donc figée au démarrage du core.

**Avec un gestionnaire systemd utilisateur** (container A, où le core est un service `hc-serve-*.service`) :
- Le gestionnaire a `SSH_AUTH_SOCK=/run/user/1001/openssh_agent`.
- Un agent « transmis » a été simulé par un device `proxy` Incus qui relaie le socket de l'agent jetable de la VM dans le container, et passé à la connexion (`--env SSH_AUTH_SOCK=…` + `su -w`). Core redémarré dans cet environnement.
- Un terminal de ce core voit toujours `SSH_AUTH_SOCK=/run/user/1001/openssh_agent` et `ssh-add -l` répond « The agent has no identities » : **l'agent transmis n'arrive pas aux terminaux**.
- Cohérent avec `crates/herdr-core/src/platform/systemd.rs` : les variables de session (dont `SSH_AUTH_SOCK`) viennent du gestionnaire utilisateur « tel qu'il est maintenant », et le service ne prend celles de l'appelant que si ce n'est pas une connexion ssh.

**Comment le core a été démarré :** sur la VM, sans systemd (hors service) ; dans le container, en service systemd utilisateur. Je n'ai pas pu tester une VM avec un vrai gestionnaire utilisateur et un `ssh -A` réel (la VM n'en a pas de session) : c'est la simulation par proxy qui couvre ce cas, avec la limite que l'appelant n'était pas une vraie connexion ssh.

## Ce qui a surpris, ce qui a cassé, contournements

- **`hc` absent du `PATH` d'`aiuser`.** `--install` met `hc` dans `~/.local/bin`, que le `PATH` du login d'`aiuser` ne contient pas. Un agent ne pourrait pas lancer `hc`. Contournement : un lien `/usr/local/bin/hc` vers `herdr-core` dans A, posé en root. À régler dans l'image (`agent-base`) ou par le provisioning.
- **Le token laisse une trace dans le container.** Le token passe bien par l'environnement du core, mais `hc` le copie dans `/run/user/1001/hc-serve-*/environment` (fichier mode 600, dans un répertoire 700, sur tmpfs) pour le service systemd, et le fichier **reste** après `hc server stop`. Ce n'est pas l'état de `hc` (`$XDG_STATE_HOME`), mais c'est un fichier du container : la condition « le token ne s'écrit nulle part ailleurs » n'est tenue qu'au sens du disque (tmpfs, détruit avec le container). Constat à garder pour DX 5.
- **Le token est visible dans la ligne de commande de `incus exec`** sur l'hôte pendant la connexion (`--env CLAUDE_CODE_OAUTH_TOKEN=…`, donc dans `/proc/<pid>/cmdline` de l'hôte). Acceptable sur cette VM à un seul utilisateur, pas sur un hôte partagé. Un transport réel devrait le faire passer autrement (descripteur de fichier, `incus file push` éphémère, ou un vrai intermédiaire).
- **Le classifieur de permissions de Claude Code a refusé** deux fois des commandes de cette session (un script de transport qui lit le token dans son fichier habituel, puis une lecture de `/proc/*/environ`). Le token a été refait dans un fichier jetable à la demande du mainteneur, et le script a ensuite passé. Ce n'est pas un défaut de `hc`, mais un transport qui lit un token dans le profil de l'utilisateur sera refusé par un agent qui le monte.
- **Le hook `pre-bash.sh` de ce dépôt a bloqué** quelques commandes chaînées de la session (`rm -rf non autorisé` sur des lignes qui contenaient `hc machine rm` suivi d'autres commandes) ; elles passent une par une.
- **`pkill -f` tue son propre shell** quand le motif apparaît dans la ligne de commande (code 144) : deux fois pendant le spike. Sans conséquence ici.
- **`sshd` jetable et `ssh -A`** ont créé des sockets sous `~/.ssh/agent/` de la VM (comportement d'OpenSSH) ; ils ont disparu avec la connexion.
- **Le Pilote lance l'enfant avec le token** : les terminaux du core héritent de l'environnement du core, donc l'enfant est authentifié sans rien faire. À l'inverse, tout agent du core a le token, y compris les agents qu'un Pilote lance.
- Le dialogue de confiance n'est pas apparu parce que le `claude.json` de forge pré-accepte l'onboarding ; je n'ai pas testé un `claude.json` absent.

## Ce que ça implique pour DX 5 (mon avis)

**Transport.** Il fonctionne, sans ssh : `--via` avec `incus exec -T … su - aiuser -c` est un tuyau d'octets suffisant, `hc` s'y installe seul et le core du container survit au client. Il faut un petit script de transport (la ligne shell de `hc` doit arriver à `su -c` en un seul argument) et il doit porter le token ; cet environnement est celui du core, donc de **tous** ses agents. La commande `--via` est enregistrée dans l'état du client : le token ne doit jamais y figurer. Je ferais de ce script un morceau de forge (testé, sans token dans l'argv), pas une recette laissée aux templates.

**Le Pilote.** Il tient : lecture de `hc --skill`, lancement d'un enfant, réponse par `hc send`, `hc wait --children all`, note de fin, tout est passé avec `pre-bash.sh` en place. Le Pilote n'a besoin de rien de plus qu'un `hc` dans le `PATH` et du token. Les limites : ses enfants vivent dans **son** container et héritent du token ; l'état « done » d'un agent ne revient pas à `idle`, donc l'attente se fait sur les notes et les tours, pas sur un retour à `idle`.

**La frontière.** Elle est nette et c'est un atout : le Pilote ne voit ni l'hôte, ni B, ni `incus`, ni le moindre socket `hc` extérieur (le réseau privé est bloqué, `/dev/incus/sock` refuse un non-root). Un Pilote qui doit lancer des agents dans d'autres containers ne peut donc passer que par un intermédiaire côté hôte, à concevoir pour que ce que le container peut lui demander soit étroit (lancer un agent, lire un statut) et que l'intermédiaire tienne la liste de ce qui est permis : le Pilote ne doit pas obtenir un `incus` ni un `hc` de l'hôte. C'est la même logique que le relais de la VM de dev : une surface étroite, des refus au lieu de contournements.

**L'agent SSH.** Sur Linux avec systemd utilisateur, les terminaux d'un core en service ne reçoivent pas l'agent transmis, ce qui est cohérent avec le code. Pour forge, c'est plutôt une bonne nouvelle : les containers n'ont délibérément aucune clé et l'hôte clone avec l'agent. Ce qui compte pour DX 5 : (1) un core hors service garde l'agent de la connexion qui l'a lancé et le perd à la connexion suivante, donc ne pas compter dessus pour du `git` côté hôte ; (2) si un jour des terminaux d'hôte doivent utiliser l'agent de l'utilisateur, il faudra le faire explicitement (l'environnement de chaque terminal, ou un agent dédié ; je n'ai pas testé ces voies), pas espérer la transmission.

## Nettoyage fait

- Containers `spike-herdr-a` et `spike-herdr-b` supprimés (le device `proxy` et le fichier d'environnement du service, avec le token, sont partis avec).
- Dossier jetable supprimé (binaire `hc`, états, sockets, scripts de transport, clés ssh jetables, sources téléchargées), ainsi que le fichier du token jetable et le fichier qui retenait le chemin du dossier.
- `sshd` et `ssh-agent` jetables arrêtés ; les cores `hc` du client arrêtés.
- Token absent partout : avant la suppression, un `grep -rlF -f <fichier du token>` sur le dossier jetable (état et config du client) n'a rien trouvé ; dans les containers (`/home/aiuser`, `/tmp`, `/run/user/1001`, `/workspace`), B n'avait rien, A n'avait que le fichier d'environnement du service dans `/run` (supprimé avec le container). Aucun journal, aucun rapport, aucun message ne contient sa valeur.
