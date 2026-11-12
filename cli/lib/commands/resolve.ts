// Résolution des arguments manquants. Le prompting vit dans la couche des
// commandes : containers.ts et worktrees.ts ne doivent rien savoir des
// terminaux.
//
// Quand on ne peut pas demander — pas de TTY, liste vide, saisie interrompue —
// on lève l'usage de l'appelant : un appel scripté obtient un message et un
// code 1, jamais un blocage sur une invite que personne ne lira.
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { forgeRepos } from "../containers.ts";

export async function resolveRepo(
  ctx: Context,
  repo: string | undefined,
  usage: string,
): Promise<string> {
  if (repo) return repo;

  const repos = await forgeRepos(ctx);
  if (repos.length === 0) {
    throw new ForgeError("no single-agent forge container on this host (the teams' containers are listed by forge team status).");
  }

  const idx = await ctx.prompt.pick("Repo", repos);
  if (idx === null) throw new ForgeError(usage);
  return repos[idx - 1];
}
