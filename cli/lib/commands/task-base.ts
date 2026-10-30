// forge task-base <container> [<task>]
//
// Lu par le laptop (forge fetch, forge ship) à travers SSH : la ref dont est
// parti le worktree de chaque tâche, enregistrée par `forge start`. Avec une
// tâche : sa base, ou rien. Sans : une ligne `<tâche>\t<base>` par tâche
// enregistrée, triées. stdout est lu par une machine : rien d'autre dessus.
import type { Context } from "../context.ts";
import { baseKey } from "../containers.ts";
import { listInstances } from "../incus.ts";
import { validateContainerName, validateGitRef, validateTaskName } from "../validate.ts";

const PREFIX = baseKey("");

// Une valeur qui n'est pas une ref sûre se lit comme « inconnue » : le
// consommateur ne doit jamais recevoir de quoi injecter une option ou un
// séparateur de commande.
function safeRef(value: string): string {
  try {
    validateGitRef(value);
    return value;
  } catch {
    return "";
  }
}

export async function cmdTaskBase(ctx: Context, container: string | undefined, task?: string): Promise<number> {
  // Les noms viennent d'un client SSH : validés avant tout appel.
  validateContainerName(container ?? "");
  if (task !== undefined) validateTaskName(task);
  const config = (await listInstances(ctx)).find((i) => i.name === container)?.config ?? {};

  if (task !== undefined) {
    const base = safeRef(config[baseKey(task)] ?? "");
    if (base) ctx.out(base);
    return 0;
  }

  const tasks = Object.keys(config)
    .filter((k) => k.startsWith(PREFIX))
    .map((k) => k.slice(PREFIX.length))
    .sort();
  for (const name of tasks) {
    const base = safeRef(config[baseKey(name)]);
    if (base) ctx.out(`${name}\t${base}`);
  }
  return 0;
}
