import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ForgeError } from "../cli/lib/context.ts";
import { ensurePr, prState, requireGh } from "../cli/lib/laptop/pr.ts";
import { createLayout, git, hybridContext, type Layout } from "./lib/git-layout.ts";
import { fakeContext } from "./lib/fake-context.ts";

const OR = "acme/widgets";
const LIST = `gh pr list --repo ${OR} --head agent/t --state all --json url,state`;
const url = "https://github.com/acme/widgets/pull/7";
const json = (...prs: [string, string][]) => JSON.stringify(prs.map(([u, state]) => ({ url: u, state })));

let layout: Layout;
beforeEach(() => { layout = createLayout("agent-acme-widgets"); });
afterEach(() => layout.cleanup());

// Puts agent/t on origin with the given commit messages, fetched into the clone.
function branch(...messages: string[]) {
  const c = layout.clone;
  git(c, "checkout", "-q", "-b", "agent/t", "main");
  for (const m of messages) git(c, "commit", "-q", "--allow-empty", "-m", m);
  git(c, "push", "-q", "origin", "agent/t");
  git(c, "checkout", "-q", "main");
  git(c, "branch", "-q", "-D", "agent/t");
  git(c, "fetch", "-q", "origin");
}

test("requireGh: gh missing", async () => {
  const ctx = fakeContext({ rules: [{ match: "gh --version", code: 127 }] });
  await assert.rejects(requireGh(ctx, "/r"), (e: Error) => e instanceof ForgeError && /install the GitHub CLI/.test(e.message));
});

test("requireGh: not logged in", async () => {
  const ctx = fakeContext({ rules: [{ match: "gh auth status", code: 1 }] });
  await assert.rejects(requireGh(ctx, "/r"), (e: Error) => e instanceof ForgeError && /gh auth login/.test(e.message));
});

test("requireGh: ok", async () => {
  await requireGh(fakeContext(), "/r");
});

test("prState: an open PR", async () => {
  const ctx = fakeContext({ rules: [{ match: LIST, stdout: json([url, "OPEN"]) }] });
  assert.deepEqual(await prState(ctx, "/r", OR, "agent/t"), { open: url, merged: false });
  assert.equal(ctx.execOptions[0]?.cwd, "/r");
});

test("prState: merged only", async () => {
  const ctx = fakeContext({ rules: [{ match: LIST, stdout: json([url, "MERGED"]) }] });
  assert.deepEqual(await prState(ctx, "/r", OR, "agent/t"), { open: undefined, merged: true });
});

test("prState: none, and closed unmerged", async () => {
  const none = fakeContext({ rules: [{ match: LIST, stdout: "[]" }] });
  assert.deepEqual(await prState(none, "/r", OR, "agent/t"), { open: undefined, merged: false });
  const closed = fakeContext({ rules: [{ match: LIST, stdout: json([url, "CLOSED"]) }] });
  assert.deepEqual(await prState(closed, "/r", OR, "agent/t"), { open: undefined, merged: false });
});

test("prState: gh failure", async () => {
  const ctx = fakeContext({ rules: [{ match: LIST, code: 1, stderr: "boom" }] });
  await assert.rejects(prState(ctx, "/r", OR, "agent/t"), /boom/);
});

test("ensurePr: reuses the open PR", async () => {
  const ctx = fakeContext({ rules: [{ match: LIST, stdout: json([url, "OPEN"]) }] });
  assert.deepEqual(await ensurePr(ctx, "/r", OR, "agent/t", "main"), { url, created: false });
  assert.ok(!ctx.calls.some((c) => c.includes("create")));
});

test("ensurePr: one commit gives its subject and body", async () => {
  branch("feat: add widget\n\nLonger explanation.");
  const ctx = hybridContext({ rules: [
    { match: "gh pr list", stdout: "[]" },
    { match: "gh pr create", stdout: `Creating pull request...\n${url}\n` },
  ] });
  assert.deepEqual(await ensurePr(ctx, layout.clone, OR, "agent/t", "main"), { url, created: true });
  const create = ctx.calls.find((c) => c.includes("create"))!;
  assert.deepEqual(create, [
    "gh", "pr", "create", "--repo", OR, "--base", "main", "--head", "agent/t",
    "--title", "feat: add widget", "--body", "Longer explanation.",
  ]);
});

test("ensurePr: one commit without body", async () => {
  branch("fix: tiny");
  const ctx = hybridContext({ rules: [{ match: "gh pr list", stdout: "[]" }, { match: "gh pr create", stdout: url }] });
  await ensurePr(ctx, layout.clone, OR, "agent/t", "main");
  const create = ctx.calls.find((c) => c.includes("create"))!;
  assert.deepEqual(create.slice(-4), ["--title", "fix: tiny", "--body", ""]);
});

test("ensurePr: several commits give the task name and a list, oldest first", async () => {
  branch("feat: one", "fix: two", "docs: three");
  const ctx = hybridContext({ rules: [{ match: "gh pr list", stdout: "[]" }, { match: "gh pr create", stdout: url }] });
  await ensurePr(ctx, layout.clone, OR, "agent/t", "main");
  const create = ctx.calls.find((c) => c.includes("create"))!;
  assert.deepEqual(create.slice(-4), ["--title", "t", "--body", "- feat: one\n- fix: two\n- docs: three"]);
  assert.ok(!create.includes("--fill"));
});

test("ensurePr: a failing create carries gh's stderr", async () => {
  branch("fix: tiny");
  const ctx = hybridContext({ rules: [
    { match: "gh pr list", stdout: "[]" },
    { match: "gh pr create", code: 1, stderr: "GraphQL: no commits between" },
  ] });
  await assert.rejects(ensurePr(ctx, layout.clone, OR, "agent/t", "main"),
    (e: Error) => e instanceof ForgeError && /no commits between/.test(e.message));
});
