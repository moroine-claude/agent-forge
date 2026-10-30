import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createContext, ForgeError } from "../cli/lib/context.ts";
import {
  ensureForgeRemote, forgeRemoteHost, openClone, parseGithubUrl,
} from "../cli/lib/laptop/clone.ts";

// A real temporary repository; the caller's global git config is never used.
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

test("openClone returns the root, owner/repo and container name", async () => {
  await withRepo("git@github.com:Acme/Widgets.git", async (dir) => {
    const c = await openClone(createContext(), dir);
    assert.deepEqual(c, { root: dir, ownerRepo: "Acme/Widgets", container: "agent-acme-widgets" });
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
    assert.equal(await forgeRemoteHost(ctx, dir, "agent-o-r"), null);
    assert.equal(await ensureForgeRemote(ctx, dir, "agent-o-r", "forge-local"), "added");
    assert.equal(await git(dir, "config", "remote.agent-o-r.url"), "forge-local:agent-o-r");
    assert.equal(await git(dir, "config", "remote.agent-o-r.uploadpack"), "forge upload-pack agent-o-r");
    assert.equal(await forgeRemoteHost(ctx, dir, "agent-o-r"), "forge-local");
    assert.equal(await ensureForgeRemote(ctx, dir, "agent-o-r", "forge-local"), "ok");
  });
});

test("ensureForgeRemote fixes a different url or uploadpack", async () => {
  await withRepo("git@github.com:o/r.git", async (dir) => {
    const ctx = createContext();
    await ensureForgeRemote(ctx, dir, "agent-o-r", "old-host");
    assert.equal(await ensureForgeRemote(ctx, dir, "agent-o-r", "forge-local"), "fixed");
    assert.equal(await forgeRemoteHost(ctx, dir, "agent-o-r"), "forge-local");
    await git(dir, "config", "remote.agent-o-r.uploadpack", "git-upload-pack");
    assert.equal(await ensureForgeRemote(ctx, dir, "agent-o-r", "forge-local"), "fixed");
    assert.equal(await git(dir, "config", "remote.agent-o-r.uploadpack"), "forge upload-pack agent-o-r");
    assert.equal(await ensureForgeRemote(ctx, dir, "agent-o-r", "forge-local"), "ok");
  });
});
