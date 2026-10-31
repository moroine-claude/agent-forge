// Opens, or finds, the GitHub pull request of agent/<task> with the GitHub CLI.
// Every gh call names its repository: the developer's clone has two remotes
// (origin and the forge one), and gh guessing between them can prompt or pick
// the wrong one.
import { ForgeError, type Context } from "../context.ts";
import { githubRef } from "./ship-plan.ts";

// gh is a laptop prerequisite checked by ship itself, before any other call here.
export async function requireGh(ctx: Context, root: string): Promise<void> {
  // A missing binary exits non-zero as well (127).
  if ((await ctx.exec(["gh", "--version"], { cwd: root })).code !== 0) {
    throw new ForgeError("forge ship needs gh: install the GitHub CLI (https://cli.github.com)");
  }
  if ((await ctx.exec(["gh", "auth", "status"], { cwd: root })).code !== 0) {
    throw new ForgeError("The GitHub CLI is not logged in: run gh auth login");
  }
}

export async function prState(
  ctx: Context, root: string, ownerRepo: string, branch: string,
): Promise<{ open?: string; merged: boolean }> {
  const r = await ctx.exec(
    ["gh", "pr", "list", "--repo", ownerRepo, "--head", branch, "--state", "all", "--json", "url,state"],
    { cwd: root },
  );
  if (r.code !== 0) throw new ForgeError(`gh pr list failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  let prs: { url: string; state: string }[];
  try { prs = JSON.parse(r.stdout || "[]"); } catch { throw new ForgeError(`gh pr list printed something unreadable: ${r.stdout.trim()}`); }
  return { open: prs.find((p) => p.state === "OPEN")?.url, merged: prs.some((p) => p.state === "MERGED") };
}

export async function ensurePr(
  ctx: Context, root: string, ownerRepo: string, branch: string, base: string,
): Promise<{ url: string; created: boolean }> {
  const { open } = await prState(ctx, root, ownerRepo, branch);
  if (open) return { url: open, created: false };

  const { title, body } = await describe(ctx, root, branch, base);
  // No --fill: with --head, gh derives its defaults from a LOCAL branch, which
  // the developer's clone does not have (only origin/<branch>).
  const r = await ctx.exec([
    "gh", "pr", "create", "--repo", ownerRepo, "--base", base, "--head", branch, "--title", title, "--body", body,
  ], { cwd: root });
  if (r.code !== 0) throw new ForgeError(`gh pr create failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  const url = r.stdout.split("\n").map((l) => l.trim()).filter((l) => /^https?:\/\/\S+$/.test(l)).at(-1);
  if (!url) throw new ForgeError(`gh pr create printed no PR URL: ${r.stdout.trim()}`);
  return { url, created: true };
}

// One commit: its subject and body. Several: the task name from the branch and
// one line per commit, oldest first. Reads origin/<branch>, which ship fetched,
// by its full name: a tag named origin/<base> must not change the range.
async function describe(ctx: Context, root: string, branch: string, base: string): Promise<{ title: string; body: string }> {
  // \x1f ends the subject, \x1e ends the commit.
  const r = await ctx.exec(
    ["git", "log", "--no-merges", "--reverse", "--format=%s%x1f%b%x1e", `${githubRef(base)}..${githubRef(branch)}`],
    { cwd: root },
  );
  if (r.code !== 0) throw new ForgeError(`git log failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  const commits = r.stdout.split("\x1e").filter((c) => c.trim() !== "").map((c) => {
    const [subject, body = ""] = c.split("\x1f");
    return { subject: subject.trim(), body: body.trim() };
  });
  if (commits.length === 1) return { title: commits[0].subject, body: commits[0].body };
  return { title: branch.replace(/^agent\//, ""), body: commits.map((c) => `- ${c.subject}`).join("\n") };
}
