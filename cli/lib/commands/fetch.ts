// forge fetch: in the developer's clone, fetch the agents' agent/* branches
// from the container through the forge host, refresh origin, and list the tasks.
import { ForgeError, mustSucceed, type Context } from "../context.ts";
import { ensureForgeRemote, forgeRemoteHost, openClone } from "../laptop/clone.ts";
import { remoteExec } from "../laptop/remote.ts";
import { loadHosts, selectHost, type LaptopHost } from "../laptop/state.ts";

export type Fetched = {
  root: string; ownerRepo: string; container: string; host: LaptopHost;
  // task -> the ref it started from, as `forge task-base` records it
  bases: Map<string, string>;
};

export async function fetchAgents(ctx: Context, opts: { host?: string; cwd?: string } = {}): Promise<Fetched> {
  const { root, ownerRepo, container } = await openClone(ctx, opts.cwd);
  // --host wins; else the host the clone's forge remote already names, when
  // hosts.json still lists it; else the usual selection.
  const alias = await forgeRemoteHost(ctx, root, container);
  const known = alias !== null && opts.host === undefined ? loadHosts().find((h) => h.name === alias) : undefined;
  const host = known ?? (await selectHost(ctx, opts.host));
  await ensureForgeRemote(ctx, root, container, host.name);

  await mustSucceed(`git fetch ${container}`, ctx.exec(["git", "fetch", "--prune", container], { cwd: root }));
  // --prune: a branch merged and deleted on GitHub must disappear.
  await mustSucceed("git fetch origin", ctx.exec(["git", "fetch", "--prune", "origin"], { cwd: root }));

  const listed = await remoteExec(ctx, host, ["forge", "task-base", container]);
  if (listed.code !== 0) {
    throw new ForgeError(`forge task-base ${container} failed on ${host.name}: ${listed.stderr.trim() || `exit code ${listed.code}`}`);
  }
  const bases = new Map<string, string>();
  for (const line of listed.stdout.split("\n")) {
    const [task, base] = line.split("\t");
    if (task && base) bases.set(task, base.trim());
  }
  return { root, ownerRepo, container, host, bases };
}

// The ref a recorded base names in the clone: another agent branch lives
// under the container remote, anything else (origin/<b>, or a bare <b>) on origin.
export function baseRef(container: string, base: string): string {
  if (base.startsWith("agent/")) return `${container}/${base}`;
  return base.startsWith("origin/") ? base : `origin/${base}`;
}

export async function cmdFetch(ctx: Context, opts: { host?: string; cwd?: string } = {}): Promise<number> {
  const { root, container, bases } = await fetchAgents(ctx, opts);
  const git = async (...args: string[]) =>
    (await mustSucceed(`git ${args[0]}`, ctx.exec(["git", ...args], { cwd: root }))).stdout;

  const prefix = `refs/remotes/${container}/agent/`;
  const refs = (await git("for-each-ref", "--format=%(refname)", prefix)).split("\n").filter(Boolean);
  if (refs.length === 0) ctx.out("no agent branches yet");
  for (const ref of refs) {
    const task = ref.slice(prefix.length);
    const head = `${container}/agent/${task}`;
    const recorded = bases.get(task);
    const limit = baseRef(container, recorded ?? "main");
    const count = (await git("rev-list", "--count", head, `^${limit}`)).trim();
    let line = `agent/${task}  ${count} commits on ${recorded ?? "main (assumed)"}`;
    // Shipped = a patch-equivalent commit is already on origin/agent/<task>.
    const shipped = `origin/agent/${task}`;
    const exists = await ctx.exec(["git", "rev-parse", "-q", "--verify", `refs/remotes/${shipped}`], { cwd: root });
    if (exists.code === 0) {
      const cherry = await git("cherry", shipped, head, limit);
      line += `, ${cherry.split("\n").filter((l) => l.startsWith("+")).length} not shipped`;
    }
    ctx.out(line);
  }
  return 0;
}
