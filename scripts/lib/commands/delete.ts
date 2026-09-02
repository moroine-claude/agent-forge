// forge delete [<owner/repo>] [--force]
// Pré-vol WIP sauf --force ou container déjà arrêté (stop l'a déjà fait). Le
// workspace est monté depuis l'hôte et survit de toute façon : ce contrôle
// existe pour révéler du travail *oublié* avant qu'un re-provisioning ne
// reclone à neuf, pas pour empêcher une perte de données.
import type { Context } from "../context.ts";
import { validateRepo } from "../validate.ts";
import { requireContainerForRepo } from "../containers.ts";
import { deleteInstance, instanceStatus } from "../lxd.ts";
import { checkAllWorktrees } from "../wip.ts";
import { resolveRepo } from "./resolve.ts";

const USAGE = "Usage: forge delete <owner/repo> [--force]";

export async function cmdDelete(ctx: Context, repo: string | undefined, force: boolean): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);
  const container = await requireContainerForRepo(ctx, ownerRepo);

  if (!force && (await instanceStatus(ctx, container)) === "Running") {
    await checkAllWorktrees(ctx, container);
  }

  ctx.out(`Deleting container ${container}...`);
  await deleteInstance(ctx, container);
  return 0;
}
