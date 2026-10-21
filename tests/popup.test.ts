import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { collectNotices, noticeBody } from "../cli/lib/popup.ts";

test("collectNotices keeps warnings, notices and notify lines, in order", () => {
  const base = fakeContext();
  const { ctx, notices } = collectNotices(base);
  ctx.err("WARNING: a"); ctx.err("plain"); ctx.notify("resumed x"); ctx.err("NOTICE: b"); ctx.out("progress");
  assert.deepEqual(notices, ["WARNING: a", "resumed x", "NOTICE: b"]);
  assert.deepEqual(base.err_lines, ["WARNING: a", "plain", "NOTICE: b"]);
  assert.deepEqual(base.out_lines, ["resumed x", "progress"]);
});

test("noticeBody cuts after ten lines", () => {
  assert.equal(noticeBody(["a", "b"]), "a\nb");
  const twelve = Array.from({ length: 12 }, (_, i) => `l${i}`);
  assert.equal(noticeBody(twelve), [...twelve.slice(0, 9), "…and 3 more"].join("\n"));
});

// No command of the e2e fakes warns and then throws, so the "error after a
// warning" rule is covered here: notices stay collected even when the run
// ends in an exception, and main only notifies after a normal return.
test("collectNotices still holds the warnings when the run then throws", () => {
  const { ctx, notices } = collectNotices(fakeContext());
  assert.throws(() => { ctx.err("WARNING: a"); throw new Error("boom"); }, /boom/);
  assert.deepEqual(notices, ["WARNING: a"]);
});
