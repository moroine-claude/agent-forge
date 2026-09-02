// Le seam injecté : tout ce que le CLI fait au monde extérieur passe par ici,
// ce qui permet aux tests de le remplacer sans pty ni stub sur le PATH.
import { spawn } from "node:child_process";
import { createPrompt } from "./prompt.ts";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecOptions = { input?: string };

export type Prompt = {
  pick(label: string, items: string[]): Promise<number | null>;
  ask(label: string): Promise<string | null>;
  askSecret(label: string): Promise<string | null>;
};

export type Context = {
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>;
  attach(argv: string[]): Promise<number>;
  prompt: Prompt;
  out(line: string): void;
  err(line: string): void;
};

// Erreur métier : le message est affiché tel quel par forge.ts, préfixé une
// seule fois par "Error: ".
export class ForgeError extends Error {}

// Ne rejette jamais sur un code non nul : plusieurs sondes (show-ref, test -e,
// tmux list-sessions) se servent du code de sortie comme réponse. Un binaire
// absent est rapporté de la même façon, par un code non nul.
function run(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

// Hérite du terminal au lieu de capturer : c'est le cas tmux. Voir §4 de la
// spec — tmux doit rester la cible directe de `lxc exec`, sinon SIGWINCH
// n'atteint jamais le client au redimensionnement.
function attach(argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 0));
  });
}

export function createContext(): Context {
  return {
    exec: run,
    attach,
    prompt: createPrompt(),
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
  };
}
