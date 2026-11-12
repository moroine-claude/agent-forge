import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkLocalHc, HC_VERSION } from "../cli/lib/hc.ts";
import { fakeContext } from "./lib/fake-context.ts";
import { repoRoot } from "../cli/lib/paths.ts";

test("the CLI and the image pin the same hc", () => {
  const defaults = readFileSync(join(repoRoot(), "ansible/roles/forge_image/defaults/main.yml"), "utf8");
  const pinned = /^forge_image_hc_version:\s*"([^"]+)"/m.exec(defaults)?.[1];
  assert.equal(pinned, HC_VERSION);
});

test("checkLocalHc accepts the pinned version, refuses another or none, naming the pin", async () => {
  await checkLocalHc(fakeContext({ rules: [{ match: "hc --version", stdout: `hc ${HC_VERSION}\n` }] }));
  for (const rule of [{ match: "hc --version", stdout: "hc 0.1.21\n" }, { match: "hc --version", code: 127, stderr: "not found" }]) {
    await assert.rejects(checkLocalHc(fakeContext({ rules: [rule] })), (e: Error) => e.message.includes(`hc ${HC_VERSION}`));
  }
});
