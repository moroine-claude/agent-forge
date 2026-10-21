// Contract test: the herdr layer against a REAL herdr server, isolated in a
// temporary HOME. Skipped when herdr is absent, except under CI where it fails.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { renderBlock, userSetsToasts } from "../../cli/lib/herdr-config.ts";
import { createContext } from "../../cli/lib/context.ts";
import {
  createWorkspace, listWorkspaces, createTab, listPanes, listTabs, renameTab, closeTab,
  paneRun, paneForeground, classifyPane, showNotification,
} from "../../cli/lib/herdr.ts";

const present = spawnSync("herdr", ["--version"], { stdio: "ignore" }).status === 0;
const ci = process.env.CI === "true";
const skip = !present && !ci;

const h = { bin: "herdr", popup: false };
const ctx = createContext();
let home = "";
let env: NodeJS.ProcessEnv = process.env;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const saved = { home: process.env.HOME, sock: process.env.HERDR_SOCKET_PATH, cfg: process.env.HERDR_CONFIG_PATH };

before(async () => {
  if (skip) return;
  assert.ok(present, "herdr must be installed under CI");
  // Short paths: the socket path must fit in sun_path.
  home = mkdtempSync("/tmp/fh-");
  const sock = `${home}/s.sock`;
  process.env.HOME = home;
  process.env.HERDR_SOCKET_PATH = sock;
  // The server reads this file at start (absent: defaults) and on reload-config.
  process.env.HERDR_CONFIG_PATH = `${home}/config.toml`;
  env = process.env;
  const server = spawn("herdr", ["server"], { env, detached: true, stdio: "ignore" });
  server.unref();
  for (let i = 0; i < 50 && !existsSync(sock); i++) await sleep(100);
  assert.ok(existsSync(sock), "herdr server socket did not appear");
});

after(() => {
  if (skip || !home) return;
  spawnSync("herdr", ["server", "stop"], { env, stdio: "ignore" });
  rmSync(home, { recursive: true, force: true });
  for (const [k, v] of [["HOME", saved.home], ["HERDR_SOCKET_PATH", saved.sock], ["HERDR_CONFIG_PATH", saved.cfg]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("herdr accepts the config block forge setup writes", { skip }, () => {
  const file = `${home}/block.toml`;
  for (const toasts of [false, true]) {
    writeFileSync(file, renderBlock("/usr/local/bin/forge", { toasts }));
    const r = spawnSync("herdr", ["config", "check"], { env: { ...process.env, HERDR_CONFIG_PATH: file }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /config: ok/);
  }
});

test("herdr accepts forge's block after a user ui inline table, without toasts", { skip }, () => {
  const file = `${home}/inline-ui.toml`;
  const user = "ui = { sidebar_width = 30 }\n\n";
  // As ensureHerdrConfig writes it: forge leaves ui alone, so no [ui.toast].
  writeFileSync(file, user + renderBlock("/usr/local/bin/forge", { toasts: !userSetsToasts(user) }));
  const r = spawnSync("herdr", ["config", "check"], { env: { ...process.env, HERDR_CONFIG_PATH: file }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /config: ok/);
});

// Reads the server's config at reload-config, as the real server does after
// `forge setup`, then asks it to show a notification and returns its reason.
function notificationReason(config: string): string {
  writeFileSync(`${home}/config.toml`, config);
  const reload = spawnSync("herdr", ["server", "reload-config"], { env, encoding: "utf8" });
  assert.match(reload.stdout, /"status":"applied"/, reload.stdout + reload.stderr);
  const r = spawnSync("herdr", ["notification", "show", "forge test", "--body", "x"], { env, encoding: "utf8" });
  return JSON.parse(r.stdout).result.reason;
}

test("the toasts block makes real herdr route notifications to a client", { skip }, () => {
  assert.equal(notificationReason(renderBlock("/usr/local/bin/forge", { toasts: false })), "disabled");
  // With delivery = "herdr" the notification is no longer disabled. A headless
  // server has no attached client to draw the toast on, so it still answers
  // shown: false (reason no_foreground_client); `shown: true` cannot be
  // asserted without a client, so the reason is the observable difference.
  assert.equal(notificationReason(renderBlock("/usr/local/bin/forge", { toasts: true })), "no_foreground_client");
  // Leave the shared server as found: no other test depends on this one.
  writeFileSync(`${home}/config.toml`, "");
  const reload = spawnSync("herdr", ["server", "reload-config"], { env, encoding: "utf8" });
  assert.match(reload.stdout, /"status":"applied"/, reload.stdout + reload.stderr);
});

test("tab list, rename and close against real herdr", { skip }, async () => {
  const ws = await createWorkspace(ctx, h, "o/tabs", home);
  const tab = await createTab(ctx, h, ws.workspaceId, "first", home);
  const shown = (tabs: { id: string; label: string; workspaceId: string }[]) => JSON.stringify(tabs);

  let tabs = await listTabs(ctx, h);
  assert.ok(tabs.some((t) => t.id === tab.tabId && t.label === "first" && t.workspaceId === ws.workspaceId), shown(tabs));
  assert.ok(tabs.some((t) => t.id === ws.tabId && t.workspaceId === ws.workspaceId), shown(tabs));

  await renameTab(ctx, h, tab.tabId, "second");
  tabs = await listTabs(ctx, h);
  assert.ok(tabs.some((t) => t.id === tab.tabId && t.label === "second" && t.workspaceId === ws.workspaceId), shown(tabs));
  assert.ok(!tabs.some((t) => t.label === "first"), shown(tabs));

  await closeTab(ctx, h, tab.tabId);
  tabs = await listTabs(ctx, h);
  assert.ok(!tabs.some((t) => t.id === tab.tabId), shown(tabs));
  assert.ok(tabs.some((t) => t.id === ws.tabId), shown(tabs));
});

test("notification show is accepted by real herdr", { skip }, async () => {
  const shown = await showNotification(ctx, h, "forge test", "line one\nline two");
  assert.equal(typeof shown, "boolean");
  // Toasts are off by default ([ui.toast] delivery), so the isolated config
  // reports shown: false, not an error.
  assert.equal(shown, false);
});

test("workspace, tab, pane and process classification against real herdr", { skip }, async () => {
  const ws = await createWorkspace(ctx, h, "o/r", home);
  assert.ok(ws.workspaceId && ws.tabId && ws.paneId);
  assert.ok((await listWorkspaces(ctx, h)).some((w) => w.label === "o/r"));

  const tab = await createTab(ctx, h, ws.workspaceId, "cli", home);
  const panes = await listPanes(ctx, h);
  assert.ok(panes.some((p) => p.id === tab.paneId && p.tabId === tab.tabId));

  // A fresh tab holds a bare shell (the shell may take a moment to start).
  let state = classifyPane(await paneForeground(ctx, h, tab.paneId), "c", "cli");
  for (let i = 0; i < 50 && state !== "shell"; i++) {
    await sleep(100);
    state = classifyPane(await paneForeground(ctx, h, tab.paneId), "c", "cli");
  }
  assert.equal(state, "shell");

  await paneRun(ctx, h, tab.paneId, "exec sleep 30");
  let fg: string[][] = [];
  for (let i = 0; i < 50; i++) {
    fg = await paneForeground(ctx, h, tab.paneId);
    if (fg[0]?.[0] === "sleep" && fg[0]?.[1] === "30") break;
    await sleep(100);
  }
  assert.deepEqual(fg, [["sleep", "30"]]);
  assert.equal(classifyPane(fg, "c", "cli"), "busy");
});
