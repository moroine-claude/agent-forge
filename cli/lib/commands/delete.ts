// forge delete [<owner/repo>] [--force]
// Pré-vol WIP sauf --force ou container déjà arrêté (stop l'a déjà fait). Le
// workspace est monté depuis l'hôte et survit de toute façon — un
// re-provisioning le réutilise quand le miroir du même repo en répond, et
// réaligne son origin sur le miroir (provision.ts, workspaceIsReusable) : ce
// contrôle existe pour révéler du travail *oublié* tant que le container est
// encore là, pas pour empêcher une perte de données.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { sanitizeContainerName, validateRepo } from "../validate.ts";
import { checkNameCollision, containerForRepo, nameOccupant, requireContainerForRepo } from "../containers.ts";
import { deleteInstance, instanceStatus } from "../incus.ts";
import { mirrorPath, workspacesDir } from "../paths.ts";
import { checkAllWorktrees } from "../wip.ts";
import { discardHalfProvisioned } from "./provision.ts";
import { resolveRepo } from "./resolve.ts";

const USAGE = "Usage: forge delete <owner/repo> [--force]";

export async function cmdDelete(ctx: Context, repo: string | undefined, force: boolean): Promise<number> {
  const ownerRepo = await resolveRepo(ctx, repo, USAGE);
  validateRepo(ownerRepo);
  let container = await containerForRepo(ctx, ownerRepo);
  // Ce qu'il est advenu du workspace d'un container à moitié provisionné.
  let discarded: "emptied" | "kept" | null = null;

  if (container) {
    if (!force && (await instanceStatus(ctx, container)) === "Running") {
      await checkAllWorktrees(ctx, container);
    }
    ctx.out(`Deleting container ${container}...`);
    await mustSucceed("incus delete", deleteInstance(ctx, container));
  } else {
    // Pas de user.forge.repo : un provisioning interrompu, ou un container
    // sans métadonnée forge, occupe peut-être le nom du repo.
    container = sanitizeContainerName(ownerRepo);
    const occupant = await nameOccupant(ctx, container, ownerRepo);
    if (occupant === "half-provisioned") {
      // Aucun agent n'a tourné : pas de pré-vol WIP.
      ctx.out(`Deleting half-provisioned container ${container}...`);
      discarded = await discardHalfProvisioned(ctx, container);
    } else if (occupant === "unmarked") {
      if (!force) {
        const choice = await ctx.prompt.pick(`${container} has no forge metadata`,
          ["delete it (its workspace survives)", "stop"]);
        if (choice !== 1) throw new ForgeError(
          `${container} left alone. From a script: forge delete ${ownerRepo} --force.`);
      }
      ctx.out(`Deleting container ${container}...`);
      await mustSucceed("incus delete", deleteInstance(ctx, container));
    } else if (occupant === "other-repo") {
      await checkNameCollision(ctx, container, ownerRepo); // lève l'erreur « different repo »
    } else {
      await requireContainerForRepo(ctx, ownerRepo); // lève l'erreur « forge start »
    }
  }
  // Le workspace et le miroir sont hors du container : ils survivent. Un
  // container d'avant le miroir n'en a pas.
  const workspace = join(workspacesDir(), container);
  const mirror = mirrorPath(container);
  if (discarded === "emptied") {
    // Le workspace n'existait pas avant la tentative échouée : elle l'a créé.
    ctx.out(`Emptied ${workspace}: the failed attempt had created it.` +
      (existsSync(mirror) ? ` Kept ${mirror}: 'forge start ${ownerRepo}' reuses it.` : ""));
    return 0;
  }
  ctx.out(existsSync(mirror)
    ? `Kept ${workspace} and ${mirror}: 'forge start ${ownerRepo}' reuses them.`
    : `Kept ${workspace}: 'forge start ${ownerRepo}' reuses it.`);
  return 0;
}
