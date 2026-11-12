// Les pièces du provisioning d'un container, partagées avec celui d'un membre
// d'équipe (team-provision.ts) : les préconditions (token, identité git,
// runtime), la poussée du token, la sonde du hook, la mise à jour de Claude
// Code, et la défausse d'un provisioning interrompu. Un seul mode : supervised —
// aucun credential GitHub, aucune clé de signature, aucun compte bot dans le
// container. Les chemins hôte restent surchargeables par variable
// d'environnement (paths.ts) pour que les tests ne touchent jamais un vrai home.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Context, ExecResult } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { BASE_IMAGE, provisioningMarker } from "../containers.ts";
import { deleteInstance, execAsAgent, execAsAgentArgv, forgeProject, imageExists, incus, listObjects } from "../incus.ts";
import { HOST_GIT_CWD } from "../mirror.ts";
import { CLAUDE_TOKEN_FILE } from "../laptop/host-steps.ts";
import { PROFILE } from "../objects.ts";
import { forgeHome, workspacesDir } from "../paths.ts";

// Le token Claude dans le container (DX 5, décision 20) : un fichier mode 600
// dans un répertoire 700. Le lanceur forge-agent le lit et l'exporte pour le
// seul processus de l'agent.
export const CONTAINER_TOKEN_DIR = "/home/aiuser/.config/forge";
export const CONTAINER_TOKEN_PATH = `${CONTAINER_TOKEN_DIR}/claude-token`;
// Le miroir ne contient aucun objet LFS (mirror.ts clone déjà avec
// GIT_LFS_SKIP_SMUDGE=1) : les fichiers LFS restent des pointeurs dans le
// container. Sans ce drapeau, `git worktree add` (et tout checkout) tente de
// télécharger ces objets et échoue, ce qui bloque le provisioning. Exportées
// pour le test de contrat qui les rejoue avec un vrai git-lfs.
export const LFS_FILTERS_INSTALL = "git lfs install --skip-repo --skip-smudge";
export const LFS_HOOKS_INSTALL = "git lfs install --skip-smudge";

// Défait un provisioning interrompu. Règle : rien de ce qui existait avant la
// tentative échouée n'est supprimé. Le workspace marqué "kept" peut porter la
// seule copie d'un travail non récupéré ; le miroir n'est jamais touché. Le
// marqueur se lit avant la suppression de l'instance, qui l'emporte avec elle.
// Retourne ce qu'il est advenu du workspace : "emptied" (créé par la tentative
// échouée, donc vidé) ou "kept" (préexistant, ou dans le doute).
export async function discardHalfProvisioned(ctx: Context, container: string): Promise<"emptied" | "kept"> {
  const marker = await provisioningMarker(ctx, container);
  await mustSucceed("incus delete", deleteInstance(ctx, container));
  if (marker?.workspace !== "new") return "kept";
  const workspaceDir = join(workspacesDir(), container);
  if (!existsSync(workspaceDir)) return "emptied";
  // Le contenu seulement : le répertoire est reconstruit par le prochain launch.
  for (const entry of readdirSync(workspaceDir)) {
    rmSync(join(workspaceDir, entry), { recursive: true, force: true });
  }
  return "emptied";
}

// Le token Claude de l'hôte : exigé avant de créer quoi que ce soit.
export function requireClaudeToken(): string {
  const tokenFile = join(forgeHome(), CLAUDE_TOKEN_FILE);
  if (!existsSync(tokenFile) || statSync(tokenFile).size === 0) {
    throw new ForgeError(`${tokenFile} not found or empty. Run 'forge install' from your machine to store the Claude token.`);
  }
  return tokenFile;
}

// Le token est poussé comme fichier (incus file push lit le fichier hôte) :
// jamais dans un argv, un journal ou la mémoire de forge. Crée aussi ~/.claude.
export async function pushClaudeToken(ctx: Context, container: string): Promise<void> {
  ctx.out("Pushing the Claude token...");
  await mustSucceed("create .claude directory", execAsAgent(ctx, container, "mkdir -p /home/aiuser/.claude"));
  await mustSucceed("create token directory",
    execAsAgentArgv(ctx, container, ["mkdir", "-p", "-m", "700", CONTAINER_TOKEN_DIR]));
  await pushFile(ctx, "push Claude token", requireClaudeToken(), container, CONTAINER_TOKEN_PATH, 1001, "600");
}

// Sondes : un code non nul veut dire « pas réglé ». Depuis HOST_GIT_CWD : lancé
// dans ~/workspaces/<c>, git y découvrirait le dépôt de l'agent (les includeIf
// de la config globale s'évaluent contre lui).
export async function hostGitIdentity(ctx: Context): Promise<{ name: string; email: string }> {
  const opts = { cwd: HOST_GIT_CWD };
  const name = (await ctx.exec(["git", "config", "--global", "--includes", "user.name"], opts)).stdout.trim();
  const email = (await ctx.exec(["git", "config", "--global", "--includes", "user.email"], opts)).stdout.trim();
  if (!name || !email) {
    throw new ForgeError(
      "the agent commits under your git identity, which is not set on this host. Run:\n" +
      '  git config --global user.name "Your Name"\n' +
      "  git config --global user.email you@example.com\n" +
      "then run the command again.");
  }
  return { name, email };
}

// Le provisioning vérifie, avant de rien créer, que `forge setup` et
// `forge image build` sont passés.
export async function requireRuntime(ctx: Context): Promise<void> {
  if (!(await listObjects(ctx, "profile")).some((p) => p.name === PROFILE)) {
    throw new ForgeError(`profile ${PROFILE} not found in Incus project ${forgeProject()}. Run 'forge setup' first.`);
  }
  if (!(await imageExists(ctx, BASE_IMAGE))) {
    throw new ForgeError(`image ${BASE_IMAGE} not found. Run 'forge image build' first.`);
  }
}

// Preuve que le hook garde vraiment CE container, dans les deux sens. Un hook
// qui ne peut pas lire sa commande (image sans jq, constaté le 2026-10-17)
// laissait tout passer ; devenu fail-closed, il refuse tout — sûr, mais
// l'agent ne peut plus rien lancer. On lui soumet donc, en tant qu'aiuser, une
// commande qu'il doit refuser (exit 2) et une qu'il doit laisser passer
// (exit 0). Les marqueurs forge-hook-probe-* rendent les lignes du journal
// d'audit (/workspace/.claude/bash-audit.log) explicites.
const hookProbe = (command: string) =>
  `printf '%s' '{"tool_name":"Bash","tool_input":{"command":"${command}"}}' | /home/aiuser/.claude/hooks/pre-bash.sh`;

export async function requireHookBlocks(ctx: Context, container: string): Promise<void> {
  ctx.out("Checking that the security hook guards the agent...");
  // Le container porte encore ses marqueurs de provisioning : `forge team
  // converge` le signale à demi provisionné et n'y touche pas.
  const rebuild = "Rebuild the image ('forge image build'), delete this container " +
    `(incus --project ${forgeProject()} delete ${container} --force; its workspace survives), then run forge team converge again.`;
  // Le hook termine ses phrases par un point : on le retire avant d'enchaîner.
  const detail = (r: ExecResult) => {
    const stderr = r.stderr.trim().replace(/\.+$/, "");
    return stderr ? `: ${stderr}` : "";
  };

  const deny = await execAsAgentArgv(ctx, container, ["bash", "-c", hookProbe("sudo true # forge-hook-probe-deny")]);
  if (deny.code !== 2) {
    throw new ForgeError(
      `the container's security hook let a forbidden command through (exit code ${deny.code}, expected 2)${detail(deny)}. ` +
      `The agent would run unguarded, so provisioning stops. ${rebuild}`);
  }
  const allow = await execAsAgentArgv(ctx, container, ["bash", "-c", hookProbe("true # forge-hook-probe-allow")]);
  if (allow.code !== 0) {
    throw new ForgeError(
      `the container's security hook refuses a harmless command (exit code ${allow.code}, expected 0)${detail(allow)}. ` +
      `The agent could not run anything, so provisioning stops. ${rebuild}`);
  }
}

// `incus file push` avec propriétaire et mode. uid 0 : fichier que l'agent ne
// peut pas modifier.
export function pushFile(ctx: Context, step: string, source: string, container: string, dest: string, uid: 0 | 1001, mode: string) {
  return mustSucceed(step, ctx.exec(incus("file", "push", source, `${container}${dest}`,
    "--uid", String(uid), "--gid", String(uid), "--mode", mode)));
}

// La version de l'image fonctionne : un échec ici (réseau, dépôt) est un
// avertissement, pas une raison d'abandonner le provisioning.
// En strict, apt ne lit que la source d'Anthropic (les dépôts Ubuntu ne sont
// pas dans la liste blanche), sans purger les listes des autres.
export async function refreshClaude(ctx: Context, container: string, strict: boolean): Promise<void> {
  ctx.out("Updating Claude Code...");
  const apt = (...args: string[]) =>
    ctx.exec(incus("exec", container, "--env", "DEBIAN_FRONTEND=noninteractive", "--", "apt-get", ...args));
  let r = await apt("update", ...(strict ? [
    "-o", "Dir::Etc::sourcelist=/etc/apt/sources.list.d/claude-code.sources",
    "-o", "Dir::Etc::sourceparts=-", "-o", "APT::Get::List-Cleanup=0",
  ] : []));
  if (r.code === 0) r = await apt("install", "--only-upgrade", "-y", "claude-code");
  if (r.code !== 0) {
    ctx.err(`WARNING: updating Claude Code failed, the image's version stays: ${r.stderr.trim() || `exit code ${r.code}`}`);
  }
}

// `forge delete` ne supprime QUE le container : ~/workspaces/<container> et le
// miroir survivent délibérément (delete.ts). On tranche ici, avant de rien
// créer, sans jamais lancer git dans le workspace :
//   - vide ou absent       -> on clone dedans ;
//   - non vide, miroir du même repo -> on le réutilise (le travail supervised
//     non récupéré est la seule copie qui existe : on n'efface rien) ;
//   - autre chose non vide -> on s'arrête sans y toucher.
export function workspaceIsReusable(workspaceDir: string, mirror: string, ownerRepo: string, existing: string | null): boolean {
  if (!existsSync(workspaceDir) || readdirSync(workspaceDir).length === 0) return false;
  if (existing !== ownerRepo.toLowerCase()) {
    throw new ForgeError(
      `${workspaceDir} already exists and is not empty, and no mirror of ${ownerRepo} vouches for it (${mirror}). ` +
      "It is the only copy of whatever it contains, so provisioning stops rather than overwrite it: " +
      "move it aside (or remove it) and run the command again.");
  }
  return true;
}
