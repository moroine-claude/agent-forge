// Menus numérotés sur node:readline. Contrat : la liste et l'invite vont sur
// stderr, la réponse est rendue à l'appelant, et rien n'est demandé quand on
// ne peut pas demander.
import { createInterface } from "node:readline";
import type { Prompt } from "./context.ts";

type MaybeTTY = NodeJS.ReadableStream & { isTTY?: boolean };

export function createPrompt(
  input: MaybeTTY = process.stdin,
  err: (s: string) => void = (s) => { process.stderr.write(s); },
): Prompt {
  // Une seule interface pour toute la durée de vie du prompt, créée à la
  // première vraie lecture. En recréer une par question ferait perdre les
  // lignes déjà mises en tampon par readline dès qu'un chunk contient
  // plusieurs réponses (le cas normal d'un flux non interactif) : la
  // fermer jette ce tampon, et une nouvelle interface arrive après la fin
  // du flux. readline referme cette interface tout seul quand le flux se
  // termine, donc rien à fermer explicitement ici.
  let lines: AsyncIterator<string> | undefined;
  async function readLine(): Promise<string | null> {
    if (!lines) lines = createInterface({ input, terminal: false })[Symbol.asyncIterator]();
    const { value, done } = await lines.next();
    return done ? null : value;
  }

  return {
    async pick(label, items) {
      // Rien à choisir, ou personne pour répondre : on ne touche pas à stdin.
      // Le lire ici consommerait une entrée destinée à quelqu'un d'autre.
      if (items.length === 0) return null;
      if (!input.isTTY) return null;

      for (;;) {
        items.forEach((item, i) => err(`${String(i + 1).padStart(2)}) ${item}\n`));
        err(`${label}> `);
        const answer = await readLine();
        if (answer === null) return null;
        const n = Number(answer.trim());
        if (Number.isInteger(n) && n >= 1 && n <= items.length) return n;
        err("Invalid choice.\n");
      }
    },

    async ask(label) {
      if (!input.isTTY) return null;
      err(`${label}> `);
      const answer = await readLine();
      if (answer === null) return null;
      const value = answer.trim();
      return value === "" ? null : value;
    },
  };
}
