// Shell quoting, in a module of its own so that what needs it (the commands
// sent over ssh, Herdr App's transport) imports nothing else.

// A POSIX single-quoted word: the value as it is, a single quote closed,
// escaped and reopened.
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
