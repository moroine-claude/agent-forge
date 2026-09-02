import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createPrompt } from "../scripts/lib/prompt.ts";

function stream(text: string, isTTY: boolean) {
  const s = Readable.from([text]) as Readable & { isTTY?: boolean };
  s.isTTY = isTTY;
  return s;
}
const tty = (t: string) => stream(t, true);
const notTty = (t: string) => stream(t, false);

// Un flux TTY qui ne se termine jamais, comme un vrai stdin interactif —
// contrairement à `tty()`, qui vient de Readable.from et finit toujours par
// émettre 'end'. Sert à vérifier que pick()/ask() rendent la main sur stdin
// (rl.close()) une fois résolus, plutôt que de compter sur la fin du flux.
function liveTty(firstLine: string) {
  const s = new Readable({ read() {} }) as Readable & { isTTY?: boolean };
  s.isTTY = true;
  s.push(firstLine);
  return s;
}

test("pick returns the 1-based index of a valid choice", async () => {
  const p = createPrompt(tty("2\n"), () => {});
  assert.equal(await p.pick("Repo", ["alpha", "beta", "gamma"]), 2);
});

test("pick re-asks after an invalid entry", async () => {
  const errs: string[] = [];
  const p = createPrompt(tty("9\nzero\n1\n"), (s) => errs.push(s));
  assert.equal(await p.pick("Repo", ["alpha", "beta"]), 1);
  assert.ok(errs.join("").includes("Invalid choice."));
});

test("pick writes the list and the prompt to stderr", async () => {
  const errs: string[] = [];
  const p = createPrompt(tty("1\n"), (s) => errs.push(s));
  await p.pick("Repo", ["alpha", "gamma"]);
  const all = errs.join("");
  assert.ok(all.includes(" 1) alpha"));
  assert.ok(all.includes(" 2) gamma"));
  assert.ok(all.includes("Repo> "));
});

test("pick returns null on an empty list without asking anything", async () => {
  const errs: string[] = [];
  const p = createPrompt(tty("1\n"), (s) => errs.push(s));
  assert.equal(await p.pick("Repo", []), null);
  assert.equal(errs.length, 0);
});

test("pick returns null with no TTY and leaves a valid answer unconsumed", async () => {
  const stdin = notTty("1\n");
  const p = createPrompt(stdin, () => {});
  assert.equal(await p.pick("Repo", ["alpha", "beta"]), null);
  const rest = await new Promise<string>((r) => {
    let buf = "";
    stdin.on("data", (c) => (buf += c));
    stdin.on("end", () => r(buf));
  });
  assert.equal(rest, "1\n");
});

test("ask returns the typed value, and null on an empty line", async () => {
  assert.equal(await createPrompt(tty("my-task\n"), () => {}).ask("New task name"), "my-task");
  assert.equal(await createPrompt(tty("\n"), () => {}).ask("New task name"), null);
});

test("ask returns null with no TTY", async () => {
  assert.equal(await createPrompt(notTty("x\n"), () => {}).ask("Ref"), null);
});

test("pick releases stdin once resolved, even on a stream that never ends", async () => {
  const stdin = liveTty("2\n");
  const p = createPrompt(stdin, () => {});
  assert.equal(await p.pick("Repo", ["alpha", "beta", "gamma"]), 2);
  assert.equal(stdin.listenerCount("data"), 0);
  assert.equal(stdin.readableFlowing, false);
});

test("ask releases stdin once resolved, even on a stream that never ends", async () => {
  const stdin = liveTty("my-task\n");
  const p = createPrompt(stdin, () => {});
  assert.equal(await p.ask("New task name"), "my-task");
  assert.equal(stdin.listenerCount("data"), 0);
  assert.equal(stdin.readableFlowing, false);
});
