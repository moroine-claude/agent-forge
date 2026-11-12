import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HC_VERSION } from "../cli/lib/hc.ts";
import { repoRoot } from "../cli/lib/paths.ts";

test("the CLI and the image pin the same hc", () => {
  const defaults = readFileSync(join(repoRoot(), "ansible/roles/forge_image/defaults/main.yml"), "utf8");
  const pinned = /^forge_image_hc_version:\s*"([^"]+)"/m.exec(defaults)?.[1];
  assert.equal(pinned, HC_VERSION);
});
