// forge team up | assign | release | status | sync, on the Mac (DX 5, §5.6):
// each runs the host's own `forge team …` over SSH; `up` then registers every
// container of the teams as a machine in Herdr App.
import type { Context, ExecResult } from "../context.ts";
import { ForgeError } from "../context.ts";
import { checkLocalHc } from "../hc.ts";
import { syncMachines } from "../laptop/machines.ts";
import { remoteAttachForwarding, remoteExec } from "../laptop/remote.ts";
import { selectHost, type LaptopHost } from "../laptop/state.ts";

const USAGE = `Usage: forge team up [<team>] [--host <name>]
       forge team assign <container> [<task>] [--host <name>]   (the instruction is read from stdin)
       forge team release <container> [--host <name>]
       forge team status [--json] [--host <name>]
       forge team sync <team> [--host <name>]`;

const MAX_INSTRUCTION = 64 * 1024;

export type TeamLaptopOptions = { host?: string; json?: boolean; stdin?: () => Promise<string> };

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

// The host command's own output and status, as they are.
function relayed(ctx: Context, r: ExecResult): number {
  if (r.stdout !== "") ctx.out(r.stdout.replace(/\n$/, ""));
  if (r.stderr !== "") ctx.err(r.stderr.replace(/\n$/, ""));
  return r.code;
}

export async function cmdTeamLaptop(ctx: Context, args: string[], opts: TeamLaptopOptions = {}): Promise<number> {
  const [sub, a, b] = args;
  if (opts.json && sub !== "status") throw new ForgeError(`--json only goes with status: forge team status --json\n${USAGE}`);
  switch (sub) {
    case "up": return up(ctx, await selectHost(ctx, opts.host), a);
    case "assign": {
      if (a === undefined) throw new ForgeError(`a container name is required.\n${USAGE}`);
      const text = await (opts.stdin ?? readStdin)();
      const host = await selectHost(ctx, opts.host);
      return relayed(ctx, await remoteExec(ctx, host, ["forge", "team", "assign", a, ...(b ? [b] : [])], text));
    }
    case "release":
      if (a === undefined) throw new ForgeError(`a container name is required.\n${USAGE}`);
      return relayed(ctx, await remoteExec(ctx, await selectHost(ctx, opts.host), ["forge", "team", "release", a]));
    case "status":
      return relayed(ctx, await remoteExec(ctx, await selectHost(ctx, opts.host), ["forge", "team", "status", ...(opts.json ? ["--json"] : [])]));
    case "sync":
      if (a === undefined) throw new ForgeError(`a team name is required.\n${USAGE}`);
      return remoteAttachForwarding(ctx, await selectHost(ctx, opts.host), ["forge", "team", "sync", a]);
    default: throw new ForgeError(USAGE);
  }
}

// hc first: a Mac whose hc is not the pinned version converges nothing, so that
// the host is never changed for machines that cannot be added.
async function up(ctx: Context, host: LaptopHost, team: string | undefined): Promise<number> {
  await checkLocalHc(ctx);
  const converged = await remoteAttachForwarding(ctx, host, ["forge", "team", "converge", ...(team ? [team] : [])]);
  if (converged !== 0) return converged;
  const status = await remoteExec(ctx, host, ["forge", "team", "status", "--json"]);
  if (status.code !== 0) {
    throw new ForgeError(`forge team status failed on ${host.name}: ${status.stderr.trim() || `exit code ${status.code}`}`);
  }
  let containers: string[];
  try {
    containers = (JSON.parse(status.stdout) as { name: string }[]).map((m) => m.name);
  } catch {
    throw new ForgeError(`forge team status on ${host.name} printed something unreadable`);
  }
  const { added, removed } = await syncMachines(ctx, host, containers);
  for (const name of added) ctx.out(`Added Herdr App machine ${name}.`);
  for (const name of removed) ctx.out(`Removed Herdr App machine ${name}.`);
  if (added.length === 0 && removed.length === 0) ctx.out("Herdr App's machines are up to date.");
  return 0;
}
