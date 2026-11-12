import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createContext, ForgeError } from "../cli/lib/context.ts";
import {
  ensureForgeRemote, forgeRemoteAliases, legacyRemote, openClone, parseGithubUrl,
} from "../cli/lib/laptop/clone.ts";
// Imported for its side effect: git ignores the caller's global and system config.
import "./lib/git-layout.ts";

// A real temporary repository.
async function withRepo(origin: string | null, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-clone-")));
  try {
    const ctx = createContext();
    await ctx.exec(["git", "-C", dir, "init", "-q"]);
    if (origin) await ctx.exec(["git", "-C", dir, "remote", "add", "origin", origin]);
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const git = async (dir: string, ...args: string[]): Promise<string> =>
  (await createContext().exec(["git", "-C", dir, ...args])).stdout.trim();

test("parseGithubUrl reads the three GitHub URL forms", () => {
  assert.equal(parseGithubUrl("git@github.com:o/r.git"), "o/r");
  assert.equal(parseGithubUrl("git@github.com:o/r"), "o/r");
  assert.equal(parseGithubUrl("ssh://git@github.com/o/r"), "o/r");
  assert.equal(parseGithubUrl("https://github.com/o/r.git/"), "o/r");
  assert.equal(parseGithubUrl("https://github.com/acme/widgets"), "acme/widgets");
});

test("parseGithubUrl returns null for anything else", () => {
  assert.equal(parseGithubUrl("git@gitlab.com:o/r.git"), null);
  assert.equal(parseGithubUrl("https://github.com/o"), null);
  assert.equal(parseGithubUrl("/some/path"), null);
});

test("openClone returns the root and owner/repo", async () => {
  await withRepo("git@github.com:Acme/Widgets.git", async (dir) => {
    const c = await openClone(createContext(), dir);
    assert.deepEqual(c, { root: dir, ownerRepo: "Acme/Widgets" });
  });
});

test("a non-GitHub origin is refused", async () => {
  await withRepo("git@gitlab.com:o/r.git", async (dir) => {
    await assert.rejects(openClone(createContext(), dir), (e: Error) => e instanceof ForgeError && /GitHub/.test(e.message));
  });
});

test("a repository without origin is refused", async () => {
  await withRepo(null, async (dir) => {
    await assert.rejects(openClone(createContext(), dir), (e: Error) => e instanceof ForgeError && /origin/.test(e.message));
  });
});

test("outside a repository is refused", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forge-norepo-")));
  try {
    await assert.rejects(openClone(createContext(), dir), (e: Error) => e instanceof ForgeError && /repository/.test(e.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureForgeRemote adds the remote, then finds it ok", async () => {
  await withRepo("git@github.com:o/r.git", async (dir) => {
    const ctx = createContext();
    assert.deepEqual(await forgeRemoteAliases(ctx, dir), []);
    assert.equal(await ensureForgeRemote(ctx, dir, "web", "forge-local"), "added");
    assert.equal(await git(dir, "config", "remote.forge-web.url"), "forge-local:team-web");
    assert.equal(await git(dir, "config", "remote.forge-web.uploadpack"), "forge team upload-pack web");
    // The agent's tags never reach the clone, even with the developer's fetch.pruneTags.
    assert.equal(await git(dir, "config", "remote.forge-web.tagOpt"), "--no-tags");
    assert.equal(await git(dir, "config", "remote.forge-web.pruneTags"), "false");
    assert.deepEqual(await forgeRemoteAliases(ctx, dir), ["forge-local"]);
    assert.equal(await ensureForgeRemote(ctx, dir, "web", "forge-local"), "ok");
  });
});

test("ensureForgeRemote fixes a missing or different tagOpt or pruneTags", async () => {
  await withRepo("git@github.com:o/r.git", async (dir) => {
    const ctx = createContext();
    // A remote added by hand, as the manual block of ansible/README.md did before.
    await git(dir, "remote", "add", "forge-web", "forge-local:team-web");
    await git(dir, "config", "remote.forge-web.uploadpack", "forge team upload-pack web");
    assert.equal(await ensureForgeRemote(ctx, dir, "web", "forge-local"), "fixed");
    assert.equal(await git(dir, "config", "remote.forge-web.tagOpt"), "--no-tags");
    assert.equal(await git(dir, "config", "remote.forge-web.pruneTags"), "false");
    await git(dir, "config", "remote.forge-web.tagOpt", "--tags");
    assert.equal(await ensureForgeRemote(ctx, dir, "web", "forge-local"), "fixed");
    assert.equal(await git(dir, "config", "remote.forge-web.tagOpt"), "--no-tags");
    // Set by an earlier forge, before pruneTags: only that one is missing.
    await git(dir, "config", "--unset", "remote.forge-web.pruneTags");
    assert.equal(await ensureForgeRemote(ctx, dir, "web", "forge-local"), "fixed");
    assert.equal(await git(dir, "config", "remote.forge-web.pruneTags"), "false");
    assert.equal(await ensureForgeRemote(ctx, dir, "web", "forge-local"), "ok");
  });
});

test("ensureForgeRemote fixes a different url or uploadpack", async () => {
  await withRepo("git@github.com:o/r.git", async (dir) => {
    const ctx = createContext();
    await ensureForgeRemote(ctx, dir, "web", "old-host");
    assert.equal(await ensureForgeRemote(ctx, dir, "web", "forge-local"), "fixed");
    assert.deepEqual(await forgeRemoteAliases(ctx, dir), ["forge-local"]);
    await git(dir, "config", "remote.forge-web.uploadpack", "git-upload-pack");
    assert.equal(await ensureForgeRemote(ctx, dir, "web", "forge-local"), "fixed");
    assert.equal(await git(dir, "config", "remote.forge-web.uploadpack"), "forge team upload-pack web");
    assert.equal(await ensureForgeRemote(ctx, dir, "web", "forge-local"), "ok");
  });
});

test("a single-agent remote from before teams is found, and left alone", async () => {
  await withRepo("git@github.com:o/r.git", async (dir) => {
    const ctx = createContext();
    assert.equal(await legacyRemote(ctx, dir, "o/r"), null);
    await git(dir, "remote", "add", "agent-o-r", "forge-local:agent-o-r");
    assert.equal(await legacyRemote(ctx, dir, "o/r"), "agent-o-r");
    // It is not a team remote: no alias is read from it.
    assert.deepEqual(await forgeRemoteAliases(ctx, dir), []);
  });
});
