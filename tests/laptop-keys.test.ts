import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { fakeContext } from "./lib/fake-context.ts";
import { chooseKey, githubAgent, listAgentKeys } from "../cli/lib/laptop/keys.ts";
import { ForgeError } from "../cli/lib/context.ts";

const KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA alice@laptop";
const KEY_B = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB work key";

test("githubAgent returns the identityagent value of ssh -G github.com", async () => {
  const ctx = fakeContext({ rules: [{ match: "ssh -G github.com", stdout: "host github.com\nidentityagent /tmp/agent.sock\n" }] });
  assert.equal(await githubAgent(ctx), "/tmp/agent.sock");
});

test("githubAgent is undefined without an identityagent line", async () => {
  const ctx = fakeContext({ rules: [{ match: "ssh -G github.com", stdout: "host github.com\nuser git\n" }] });
  assert.equal(await githubAgent(ctx), undefined);
});

test("githubAgent is undefined for SSH_AUTH_SOCK and for the default agent", async () => {
  const a = fakeContext({ rules: [{ match: "ssh -G", stdout: "identityagent SSH_AUTH_SOCK\n" }] });
  assert.equal(await githubAgent(a), undefined);
  const saved = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = "/tmp/default.sock";
  try {
    const b = fakeContext({ rules: [{ match: "ssh -G", stdout: "identityagent /tmp/default.sock\n" }] });
    assert.equal(await githubAgent(b), undefined);
  } finally {
    if (saved === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = saved;
  }
});

test("githubAgent keeps spaces and expands a leading ~/", async () => {
  const a = fakeContext({ rules: [{ match: "ssh -G", stdout: "identityagent /Users/x/a b/agent.sock\n" }] });
  assert.equal(await githubAgent(a), "/Users/x/a b/agent.sock");
  const b = fakeContext({ rules: [{ match: "ssh -G", stdout: "IdentityAgent ~/a b/agent.sock\n" }] });
  assert.equal(await githubAgent(b), `${homedir()}/a b/agent.sock`);
});

test("githubAgent ignores a failed ssh -G", async () => {
  const ctx = fakeContext({ rules: [{ match: "ssh -G", code: 255, stdout: "identityagent /tmp/x.sock\n", stderr: "boom" }] });
  assert.equal(await githubAgent(ctx), undefined);
});

test("keys are listed from the agent ssh uses for github.com", async () => {
  const ctx = fakeContext({
    rules: [
      { match: "ssh -G github.com", stdout: "identityagent /tmp/agent.sock\n" },
      { match: "ssh-add -L", stdout: `${KEY_A}\n${KEY_B}\n` },
    ],
  });
  const agent = await githubAgent(ctx);
  const keys = await listAgentKeys(ctx, agent);
  assert.deepEqual(keys, [KEY_A, KEY_B]);
  const i = ctx.calls.findIndex((c) => c[0] === "ssh-add");
  assert.deepEqual(ctx.calls[i], ["ssh-add", "-L"]);
  assert.equal(ctx.execOptions[i]?.env?.SSH_AUTH_SOCK, "/tmp/agent.sock");
});

test("keys come from the default agent when none is given", async () => {
  const ctx = fakeContext({ rules: [{ match: "ssh-add -L", stdout: `${KEY_A}\n` }] });
  assert.deepEqual(await listAgentKeys(ctx, undefined), [KEY_A]);
  const i = ctx.calls.findIndex((c) => c[0] === "ssh-add");
  assert.equal(ctx.execOptions[i]?.env?.SSH_AUTH_SOCK, undefined);
});

test("an agent without identities lists no key", async () => {
  const ctx = fakeContext({ rules: [{ match: "ssh-add -L", code: 1, stdout: "The agent has no identities.\n" }] });
  assert.deepEqual(await listAgentKeys(ctx, undefined), []);
});

test("a missing agent asks to start one and add the key", async () => {
  const ctx = fakeContext({ rules: [{ match: "ssh-add -L", code: 2, stderr: "Could not open a connection to your authentication agent." }] });
  await assert.rejects(listAgentKeys(ctx, undefined), (e: Error) => e instanceof ForgeError && /start an ssh agent/i.test(e.message) && /ssh-add/.test(e.message));
});

test("one key is chosen without a question", async () => {
  const ctx = fakeContext();
  assert.equal(await chooseKey(ctx, [KEY_A]), KEY_A);
  assert.equal(ctx.err_lines.length, 0);
});

test("several keys ask, labelled with type and comment, and return the full line", async () => {
  const ctx = fakeContext({ answers: [1] });
  assert.equal(await chooseKey(ctx, [KEY_A, KEY_B]), KEY_B);
  assert.equal(ctx.err_lines[0], "Key GitHub accepts> [ssh-ed25519 alice@laptop | ssh-rsa work key]");
});

test("a key without comment is labelled with a short prefix of the key", async () => {
  const bare = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAA";
  const ctx = fakeContext({ answers: [0] });
  await chooseKey(ctx, [bare, KEY_B]);
  assert.match(ctx.err_lines[0], /ssh-ed25519 AAAAC3NzaC1l…/);
});

test("no key, or a cancelled pick, is an error", async () => {
  await assert.rejects(chooseKey(fakeContext(), []), ForgeError);
  await assert.rejects(chooseKey(fakeContext({ answers: [] }), [KEY_A, KEY_B]), ForgeError);
});
