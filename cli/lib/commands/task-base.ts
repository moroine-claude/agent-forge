// forge task-base <container> [<task>]
//
// Lu par le laptop (forge fetch, forge ship) à travers SSH : la ref dont est
// parti le worktree de chaque tâche, enregistrée au démarrage de la tâche. Avec une
// tâche : sa base, ou rien. Sans : une ligne `<tâche>\t<base>` par tâche
// enregistrée, triées. stdout est lu par une machine : rien d'autre dessus.
import { ForgeError, type Context } from "../context.ts";
import { baseKey } from "../containers.ts";
import { incus } from "../incus.ts";
import { validateContainerName, validateGitRef, validateTaskName } from "../validate.ts";

const PREFIX = baseKey("");

// Une valeur qui n'est pas une ref sûre se lit comme « inconnue » : le
// consommateur ne doit jamais recevoir de quoi injecter une option ou un
// séparateur de commande.
export function safeRef(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    validateGitRef(value);
    return value;
  } catch {
    return "";
  }
}

// La config du container, {} s'il n'existe pas. `incus list` est lu ici, pas
// par listInstances : celle-ci rend [] quand incus échoue, et un échec se
// lirait alors comme « aucune base enregistrée ».
export async function containerConfig(ctx: Context, container: string): Promise<Record<string, unknown>> {
  const r = await ctx.exec(incus("list", "-f", "json"));
  if (r.code !== 0) throw new ForgeError(`incus list failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  let listed: unknown;
  try { listed = JSON.parse(r.stdout); } catch { throw new ForgeError("incus list printed something unreadable"); }
  if (!Array.isArray(listed)) throw new ForgeError("incus list printed something unreadable");
  const found: unknown = listed.find((i) => typeof i === "object" && i !== null && (i as { name?: unknown }).name === container);
  const config = (found as { config?: unknown } | undefined)?.config;
  return typeof config === "object" && config !== null ? config as Record<string, unknown> : {};
}

export async function cmdTaskBase(ctx: Context, container: string | undefined, task?: string): Promise<number> {
  // Les noms viennent d'un client SSH : validés avant tout appel.
  const name = container ?? "";
  validateContainerName(name);
  if (task !== undefined) validateTaskName(task);
  const config = await containerConfig(ctx, name);

  if (task !== undefined) {
    const base = safeRef(config[baseKey(task)]);
    if (base) ctx.out(base);
    return 0;
  }

  const tasks = Object.keys(config)
    .filter((k) => k.startsWith(PREFIX))
    .map((k) => k.slice(PREFIX.length))
    .sort();
  for (const t of tasks) {
    const base = safeRef(config[baseKey(t)]);
    if (base) ctx.out(`${t}\t${base}`);
  }
  return 0;
}
