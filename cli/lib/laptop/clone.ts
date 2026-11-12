// The developer's own clone of a GitHub repository, on the laptop: its root,
// its owner/repo, and the git remote that fetches the agents' branches from the
// team mirror, through the forge host.
import { ForgeError, mustSucceed, type Context } from "../context.ts";
import { sanitizeContainerName, validateRepo } from "../validate.ts";

// scp-like (git@github.com:o/r), ssh:// and https:// forms; `.git` and a
// trailing slash are optional.
const GITHUB = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/;

export function parseGithubUrl(url: string): string | null {
  return GITHUB.exec(url.trim())?.[1] ?? null;
}

export async function openClone(
  ctx: Context,
  cwd: string = process.cwd(),
): Promise<{ root: string; ownerRepo: string }> {
  const top = await ctx.exec(["git", "rev-parse", "--show-toplevel"], { cwd });
  if (top.code !== 0) {
    throw new ForgeError("not inside a git repository: run this from your clone of the GitHub repository");
  }
  const root = top.stdout.trim();
  // The URL as configured, not `git remote get-url`: that one applies the
  // user's url.<base>.insteadOf rewrites, which can hide the GitHub address.
  const origin = await ctx.exec(["git", "config", "--get", "remote.origin.url"], { cwd: root });
  if (origin.code !== 0) {
    throw new ForgeError(`${root} has no "origin" remote: add your GitHub repository with git remote add origin <url>`);
  }
  const url = origin.stdout.trim();
  const ownerRepo = parseGithubUrl(url);
  if (!ownerRepo) {
    throw new ForgeError(`origin is not a GitHub repository (${url}): forge works on GitHub clones, with an origin like git@github.com:<owner>/<repo>.git`);
  }
  validateRepo(ownerRepo);
  return { root, ownerRepo };
}

const configGet = async (ctx: Context, root: string, key: string): Promise<string | null> => {
  const r = await ctx.exec(["git", "config", "--get", key], { cwd: root });
  return r.code === 0 ? r.stdout.trim() : null;
};

// The remote of a team, its URL and the program the host runs for it: the team
// mirror is the host's `team-<team>`, served by `forge team upload-pack <team>`.
export const teamRemote = (team: string): string => `forge-${team}`;
const teamUrl = (alias: string, team: string): string => `${alias}:team-${team}`;

// The SSH aliases that this clone's forge team remotes name: the hosts it has
// fetched from before.
export async function forgeRemoteAliases(ctx: Context, root: string): Promise<string[]> {
  const r = await ctx.exec(["git", "config", "--get-regexp", "^remote\\.forge-.+\\.url$"], { cwd: root });
  if (r.code !== 0) return [];
  const aliases: string[] = [];
  for (const line of r.stdout.split("\n")) {
    const alias = /^remote\.forge-\S+\.url (.+):team-[^:]+$/.exec(line.trim())?.[1];
    if (alias) aliases.push(alias);
  }
  return aliases;
}

// The single-agent remote the clone may still hold from before teams
// (`agent-<owner>-<repo>`): left in place, never fetched.
export async function legacyRemote(ctx: Context, root: string, ownerRepo: string): Promise<string | null> {
  const name = sanitizeContainerName(ownerRepo);
  return (await configGet(ctx, root, `remote.${name}.url`)) === null ? null : name;
}

// Over SSH, git runs `forge team upload-pack <team> '<path>'` on the host.
// No tags: the agent creates them in the container, and a tag named
// origin/main (or forge-<team>/agent/<task>, or main) would take the place of
// that ref wherever git reads a short name, in the developer's review included.
// pruneTags=false as well: the developer's fetch.pruneTags would otherwise add
// refs/tags/*:refs/tags/* to a pruning fetch of this remote, bring the
// container's tags in and delete the developer's own.
export async function ensureForgeRemote(
  ctx: Context,
  root: string,
  team: string,
  alias: string,
): Promise<"added" | "fixed" | "ok"> {
  const remote = teamRemote(team);
  const url = teamUrl(alias, team);
  const wanted: [string, string][] = [
    ["uploadpack", `forge team upload-pack ${team}`], ["tagOpt", "--no-tags"], ["pruneTags", "false"],
  ];
  const key = (name: string) => `remote.${remote}.${name}`;
  const set = (name: string, value: string) =>
    mustSucceed(`git config ${key(name)}`, ctx.exec(["git", "config", key(name), value], { cwd: root }));

  const current = await configGet(ctx, root, key("url"));
  if (current === null) {
    await mustSucceed(`git remote add ${remote}`, ctx.exec(["git", "remote", "add", remote, url], { cwd: root }));
    for (const [name, value] of wanted) await set(name, value);
    return "added";
  }
  let fixed = false;
  if (current !== url) { await set("url", url); fixed = true; }
  for (const [name, value] of wanted) {
    if ((await configGet(ctx, root, key(name))) !== value) { await set(name, value); fixed = true; }
  }
  return fixed ? "fixed" : "ok";
}
