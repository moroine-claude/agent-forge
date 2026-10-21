// La VM Lima locale `forge-local` : création, démarrage, attente de SSH et de
// cloud-init. Reprend le flux de ansible/tests/vm-test.sh (--lima).
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ForgeError, type Context } from "../context.ts";
import { limaHome } from "../paths.ts";
import { knownHostsPath } from "./state.ts";

export const LIMA_NAME = "forge-local";
export const LIMA_DEFAULT_PORT = 60022;

// L'alias sous lequel la clé d'hôte de la VM est enregistrée : l'inventaire
// généré utilise le même, pour que le playbook retrouve la clé vue ici.
const HOST_KEY_ALIAS = "forge-local-admin";
const SSH_TRIES = 60;
const SSH_DELAY_MS = 5000;

export type LimaInstance = { status: string; port: number; user: string };

// null quand l'instance n'existe pas (limactl sort en 1, "No instance matching").
export async function limaInstance(ctx: Context, name: string): Promise<LimaInstance | null> {
  const r = await ctx.exec(["limactl", "list", "--json", name]);
  if (r.code !== 0) {
    if (r.code === 1 && /No instance matching/.test(r.stderr)) return null;
    throw new ForgeError(`limactl list failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  }
  // Un objet JSON par ligne : le premier suffit pour une instance nommée.
  const line = r.stdout.split("\n").find((l) => l.trim() !== "");
  if (!line) return null;
  let data: { status?: unknown; sshLocalPort?: unknown; config?: { user?: { name?: unknown } } };
  try {
    data = JSON.parse(line);
  } catch {
    throw new ForgeError(`limactl list returned something unreadable for ${name}`);
  }
  let user = typeof data.config?.user?.name === "string" ? data.config.user.name : "";
  if (!user) {
    // Comme vm-test.sh : on demande à la VM qui est l'admin.
    const s = await ctx.exec(["limactl", "shell", "--workdir", "/", name, "id", "-un"]);
    if (s.code === 0) user = s.stdout.trim();
  }
  return {
    status: typeof data.status === "string" ? data.status : "",
    port: typeof data.sshLocalPort === "number" ? data.sshLocalPort : 0,
    user,
  };
}

function tryListen(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(null));
    s.listen(port, "127.0.0.1", () => {
      const got = (s.address() as { port: number }).port;
      s.close(() => resolve(got));
    });
  });
}

// `preferred` s'il se lie sur 127.0.0.1, sinon un port libre choisi par l'OS.
// Jamais 0 : Lima en ferait un port tiré au hasard à chaque démarrage.
export async function freePort(preferred: number): Promise<number> {
  const got = (await tryListen(preferred)) ?? (await tryListen(0));
  if (got === null) throw new ForgeError("no free port on 127.0.0.1");
  return got;
}

export type LimaOptions = {
  sleep?: (ms: number) => Promise<void>;
  freePort?: (preferred: number) => Promise<number>;
};

export async function ensureLimaVm(
  ctx: Context,
  template: string,
  opts: LimaOptions = {},
): Promise<{ port: number; admin: string; adminKey: string }> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const pick = opts.freePort ?? freePort;

  const existing = await limaInstance(ctx, LIMA_NAME);
  let expected: number;
  if (!existing) {
    // Port fixé pour la vie de la VM : le "0" de Lima en changerait à chaque
    // démarrage, et known_hosts, indexé par port, accepterait en silence une
    // clé d'hôte changée.
    expected = await pick(LIMA_DEFAULT_PORT);
    await run(ctx, "limactl create", ["limactl", "create", "--tty=false", "--name", LIMA_NAME, "--set", `.ssh.localPort = ${expected}`, template]);
  } else {
    if (existing.port === 0) {
      throw new ForgeError(`${LIMA_NAME} picks a new SSH port at each start: it was not created by forge install`);
    }
    expected = existing.port;
  }
  if (!existing || existing.status !== "Running") {
    await run(ctx, "limactl start", ["limactl", "start", "--tty=false", LIMA_NAME]);
  }

  const vm = await limaInstance(ctx, LIMA_NAME);
  if (!vm) throw new ForgeError(`${LIMA_NAME} disappeared after limactl start`);
  if (vm.port !== expected) {
    throw new ForgeError(`${LIMA_NAME}'s SSH port is ${vm.port || "unknown"}, expected ${expected}`);
  }
  if (!vm.user) throw new ForgeError(`cannot tell which admin user ${LIMA_NAME} has`);

  const adminKey = join(limaHome(), "_config", "user");
  // ssh crée known_hosts mais pas son répertoire.
  mkdirSync(dirname(knownHostsPath()), { recursive: true });
  const ssh = (command: string[]) =>
    ctx.exec([
      "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "IdentitiesOnly=yes",
      "-o", `UserKnownHostsFile=${knownHostsPath()}`, "-o", `HostKeyAlias=${HOST_KEY_ALIAS}`,
      "-o", "StrictHostKeyChecking=accept-new",
      "-i", adminKey, "-p", String(vm.port), `${vm.user}@127.0.0.1`, ...command,
    ]);

  let up = false;
  for (let i = 0; i < SSH_TRIES && !up; i++) {
    if (i > 0) await sleep(SSH_DELAY_MS);
    up = (await ssh(["true"])).code === 0;
  }
  if (!up) throw new ForgeError(`SSH on port ${vm.port} never let ${vm.user} into ${LIMA_NAME}`);

  // cloud-init sort en 2 pour "terminé, avec des erreurs récupérables".
  const ci = await ssh(["cloud-init", "status", "--wait"]);
  if (ci.code !== 0 && ci.code !== 2) {
    throw new ForgeError(`cloud-init failed in ${LIMA_NAME} (exit ${ci.code})`);
  }
  return { port: vm.port, admin: vm.user, adminKey };
}

// Longue et bavarde (téléchargement de l'image à la première création) : elle
// garde le terminal.
async function run(ctx: Context, step: string, argv: string[]): Promise<void> {
  const code = await ctx.attach(argv);
  if (code !== 0) throw new ForgeError(`${step} failed (exit code ${code})`);
}
