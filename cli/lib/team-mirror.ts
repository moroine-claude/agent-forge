// Le miroir d'équipe (DX 5, §5.5) : un dépôt nu de l'hôte où forge rassemble les
// branches des développeurs, pour que les membres `read-team` les lisent. Il ne
// prend à chaque développeur QUE les branches qu'il possède (les clés
// `user.forge.base.<tâche>` de son container) : jamais une branche d'un autre,
// jamais un ref que le développeur aurait créé hors de forge.
//
// git ne s'exécute jamais dans le dépôt d'un agent : le container répond avec
// `forge upload-pack`, comme pour `forge fetch`, et le seul dépôt que git de
// l'hôte ouvre est le miroir d'équipe, dont les hooks sont coupés.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "./context.ts";
import type { ForgeConfig } from "./config.ts";
import { listInstances } from "./incus.ts";
import { ensureTeamMirror, HOST_GIT_CWD, teamMirrorPath } from "./mirror.ts";
import { forgeCommand } from "./paths.ts";
import { members } from "./team.ts";
import { isTaskName } from "./validate.ts";

const BASE_PREFIX = "user.forge.base.";
const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// `fetched` et `failed` sont des noms de containers : un membre dont la
// récupération échoue (container arrêté, dépôt illisible) est signalé sans
// arrêter les autres.
export async function refreshTeamMirror(
  ctx: Context, cfg: ForgeConfig, team: string,
): Promise<{ fetched: string[]; failed: string[] }> {
  const result = { fetched: [] as string[], failed: [] as string[] };
  await ensureTeamMirror(ctx, team);
  const mirror = teamMirrorPath(team);
  const instances = await listInstances(ctx);
  // L'URL du remote est un dossier vide : git n'y lit rien, c'est
  // `remote.src.uploadpack` qui répond.
  const empty = mkdtempSync(join(tmpdir(), "forge-team-src-"));
  try {
    for (const m of members(cfg).filter((x) => x.team === team && x.capabilities.includes("publish"))) {
      const config = instances.find((i) => i.name === m.name)?.config ?? {};
      const tasks = Object.keys(config)
        .filter((k) => k.startsWith(BASE_PREFIX)).map((k) => k.slice(BASE_PREFIX.length)).filter(isTaskName);
      if (tasks.length === 0) continue;
      const refspecs = tasks.map((t) => `+refs/heads/agent/${t}:refs/heads/agent/${t}`);
      const uploadpack = `FORGE_SIDE=host ${shellQuote(forgeCommand())} upload-pack ${m.name}`;
      const r = await ctx.exec([
        "git", `--git-dir=${mirror}`, "-c", "core.hooksPath=/dev/null",
        "-c", `remote.src.url=${empty}`, "-c", `remote.src.uploadpack=${uploadpack}`,
        "fetch", "--no-tags", "src", ...refspecs,
      ], { cwd: HOST_GIT_CWD, env: { GIT_TERMINAL_PROMPT: "0" } });
      (r.code === 0 ? result.fetched : result.failed).push(m.name);
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  return result;
}
