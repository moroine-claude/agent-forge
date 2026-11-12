// forge team converge | assign | release | status | sync (DX 5, §5.3, §5.5) :
// les équipes d'agents, du côté de l'hôte. Les équipes viennent de la config de
// forge ; chaque membre est un container, que `converge` provisionne.
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import type { ForgeConfig } from "../config.ts";
import { loadConfig } from "../config.ts";
import { provisioningMarker } from "../containers.ts";
import { listInstances, type Instance } from "../incus.ts";
import { refreshMirror } from "../mirror.ts";
import { configPath } from "../paths.ts";
import { ensureRunning } from "../session.ts";
import { sessionState, startSession, type SessionState } from "../hc-session.ts";
import { assign, busyState, release, type Busy } from "../tasks.ts";
import { columnWidths, formatRow } from "../table.ts";
import { members, type Member } from "../team.ts";
import { originMirrorPath, provisionMember } from "../team-provision.ts";
import { refreshTeamMirror } from "../team-mirror.ts";

const USAGE = `Usage: forge team converge [<team>]
       forge team assign <container> [<task>]   (the instruction is read from stdin)
       forge team release <container>
       forge team status [--json]
       forge team sync <team>`;

// Une consigne ne dépasse pas ceci : c'est du texte, pas un fichier.
const MAX_INSTRUCTION = 64 * 1024;

export type TeamOptions = { json?: boolean; stdin?: () => Promise<string> };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > MAX_INSTRUCTION) throw new ForgeError(`the instruction is longer than ${MAX_INSTRUCTION} bytes.`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function cmdTeam(ctx: Context, args: string[], opts: TeamOptions = {}): Promise<number> {
  const [sub, a, b] = args;
  if (opts.json && sub !== "status") throw new ForgeError(`--json only goes with status: forge team status --json\n${USAGE}`);
  if (!["converge", "assign", "release", "status", "sync"].includes(sub ?? "")) throw new ForgeError(USAGE);
  const cfg = loadConfig(configPath());
  if (Object.keys(cfg.teams).length === 0 && cfg.pilot === null) {
    throw new ForgeError(`no team in ${configPath()}: declare "teams" (and optionally "pilot") there first.`);
  }
  switch (sub) {
    case "converge": return converge(ctx, cfg, a);
    case "assign": return assignCommand(ctx, cfg, a, b, opts.stdin ?? readStdin);
    case "release": return releaseCommand(ctx, cfg, a);
    case "status": return status(ctx, cfg, opts.json === true);
    default: return sync(ctx, cfg, a);
  }
}

function requireTeam(cfg: ForgeConfig, team: string | undefined): string {
  if (team === undefined || !(team in cfg.teams)) {
    throw new ForgeError(`${team === undefined ? "a team name is required" : `${team} is not a declared team`} ` +
      `(declared: ${Object.keys(cfg.teams).join(", ") || "none"}).\n${USAGE}`);
  }
  return team;
}

async function converge(ctx: Context, cfg: ForgeConfig, team: string | undefined): Promise<number> {
  if (team !== undefined) requireTeam(cfg, team);
  const wanted = members(cfg).filter((m) => team === undefined || m.team === team);
  const existing = new Map((await listInstances(ctx)).map((i) => [i.name, i]));
  for (const m of wanted) {
    const instance = existing.get(m.name);
    if (!instance) {
      await provisionMember(ctx, cfg, m);
      continue;
    }
    if (await provisioningMarker(ctx, m.name) !== null) {
      ctx.err(`WARNING: ${m.name} is half-provisioned: left as is. Delete it (incus ... delete) and run converge again.`);
      continue;
    }
    if (instance.status !== "Running") await ensureRunning(ctx, m.name);
    // Le Pilote a une session permanente : elle repart si elle manque.
    if (m.role === "pilot" && await sessionState(ctx, m.name) === "none") await startSession(ctx, m, "-", "");
  }
  for (const t of Object.keys(cfg.teams).filter((x) => team === undefined || x === team)) {
    const r = await refreshTeamMirror(ctx, cfg, t);
    for (const name of r.failed) ctx.err(`WARNING: could not refresh the team mirror from ${name}.`);
  }
  await printMembers(ctx, cfg, wanted, team);
  return 0;
}

// Une ligne par membre déclaré, puis une par container d'équipe que la config
// ne déclare plus : converge ne supprime jamais un container.
async function printMembers(ctx: Context, cfg: ForgeConfig, wanted: Member[], team: string | undefined): Promise<void> {
  const instances = await listInstances(ctx);
  const rows: string[][] = [];
  for (const m of wanted) {
    const busy = await busyState(ctx, m.name);
    rows.push([m.name, m.role, instances.find((i) => i.name === m.name)?.status ?? "Missing", taskLabel(busy)]);
  }
  const widths = columnWidths(rows);
  for (const row of rows) ctx.out(formatRow(row, widths));
  const declared = new Set(members(cfg).map((m) => m.name));
  for (const i of instances) {
    const t = i.config["user.forge.team"];
    if (t !== undefined && !declared.has(i.name) && (team === undefined || t === team)) {
      ctx.out(`${i.name}: not in the config, left as is`);
    }
  }
}

const taskLabel = (busy: Busy) => (busy === null ? "free" : busy.task);

async function assignCommand(
  ctx: Context, cfg: ForgeConfig, to: string | undefined, task: string | undefined, stdin: () => Promise<string>,
): Promise<number> {
  if (to === undefined) throw new ForgeError(`a container name is required.\n${USAGE}`);
  const text = (await stdin()).trim();
  if (text === "") throw new ForgeError("the instruction is empty: give it on stdin (forge team assign <container> <task> < instruction.md).");
  await assign(ctx, cfg, { to, task: task ?? null, text, by: "human" });
  ctx.out(`Assigned ${task ?? "a task"} to ${to}.`);
  return 0;
}

async function releaseCommand(ctx: Context, cfg: ForgeConfig, to: string | undefined): Promise<number> {
  if (to === undefined) throw new ForgeError(`a container name is required.\n${USAGE}`);
  await release(ctx, cfg, { to, by: "human" });
  ctx.out(`Released ${to}.`);
  return 0;
}

type Row = { name: string; team: string | null; role: string; busy: Busy; session: SessionState };

// Le miroir d'équipe se rafraîchit d'abord (§5.5) : un échec est un
// avertissement sur stderr, jamais un échec de status.
async function status(ctx: Context, cfg: ForgeConfig, json: boolean): Promise<number> {
  for (const t of Object.keys(cfg.teams)) {
    try {
      const r = await refreshTeamMirror(ctx, cfg, t);
      for (const name of r.failed) ctx.err(`WARNING: could not refresh the team mirror from ${name}.`);
    } catch (e) {
      ctx.err(`WARNING: could not refresh the team mirror of ${t}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const instances = new Map((await listInstances(ctx)).map((i: Instance) => [i.name, i]));
  const rows: Row[] = [];
  for (const m of members(cfg)) {
    const running = instances.get(m.name)?.status === "Running";
    rows.push({
      name: m.name, team: m.team, role: m.role,
      busy: instances.has(m.name) ? await busyState(ctx, m.name) : null,
      session: running ? await sessionState(ctx, m.name) : "none",
    });
  }
  if (json) {
    ctx.out(JSON.stringify(rows));
    return 0;
  }
  const table = rows.map((r) => [r.name, r.role, taskLabel(r.busy), r.session]);
  const widths = columnWidths([["NAME", "ROLE", "TASK", "SESSION"], ...table]);
  ctx.out(formatRow(["NAME", "ROLE", "TASK", "SESSION"], widths));
  for (const row of table) ctx.out(formatRow(row, widths));
  return 0;
}

// Le miroir d'origine de l'équipe (GitHub, par l'agent SSH transmis), puis le
// miroir d'équipe.
async function sync(ctx: Context, cfg: ForgeConfig, team: string | undefined): Promise<number> {
  const name = requireTeam(cfg, team);
  const origin = await refreshMirror(ctx, originMirrorPath(name), cfg.teams[name].repo);
  if (origin.code !== 0) {
    throw new ForgeError(`refreshing the mirror of ${cfg.teams[name].repo} failed: ${origin.stderr.trim() || `exit code ${origin.code}`}\n` +
      "Is your SSH agent forwarded? Attach with ForwardAgent yes and run the command again.");
  }
  const r = await refreshTeamMirror(ctx, cfg, name);
  for (const failed of r.failed) ctx.err(`WARNING: could not refresh the team mirror from ${failed}.`);
  ctx.out(`Synced ${name}.`);
  return 0;
}
