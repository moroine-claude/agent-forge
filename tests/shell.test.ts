// shellQuote lives in its own tiny module, so what needs only it imports
// nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shellQuote } from "../cli/lib/shell.ts";

test("shellQuote single-quotes a value and escapes its single quotes", () => {
  assert.equal(shellQuote("/usr/local/bin/forge"), "'/usr/local/bin/forge'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});
