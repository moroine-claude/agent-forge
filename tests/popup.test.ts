import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeContext } from "./lib/fake-context.ts";
import { ackAfterRun, collectNotices, noticeBody } from "../cli/lib/popup.ts";

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

test("ackAfterRun decides how the run ends", () => {
  const base = { popup: true, attachPane: false, code: 0 as number | null, threw: false, notices: 0 };
  const cases: [string, Partial<typeof base>, string][] = [
    ["success, nothing to read", {}, "close"],
    ["success with notices in the popup", { notices: 2 }, "notify"],
    ["non-zero code in the popup", { code: 2, notices: 2 }, "wait"],
    ["threw after notices in the popup", { code: null, threw: true, notices: 2 }, "wait"],
    ["attach pane, non-zero code", { popup: false, attachPane: true, code: 3 }, "wait"],
    ["attach pane, exit 0", { popup: false, attachPane: true, notices: 1 }, "close"],
    ["outside herdr, non-zero", { popup: false, code: 1, notices: 1 }, "close"],
    ["outside herdr, threw", { popup: false, code: null, threw: true }, "close"],
  ];
  for (const [name, over, want] of cases) assert.equal(ackAfterRun({ ...base, ...over }), want, name);
});
