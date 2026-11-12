// The two helpers every config parser shares (config.ts, team-config.ts):
// one error shape, "<file>: <key> must be …", and one way to read an object
// while refusing the keys forge does not know.
import { ForgeError } from "./context.ts";

// An Incus size: "50GiB", "12GB", "512MiB".
export const SIZE = /^[0-9]+(\.[0-9]+)?(B|[kKMGTPE]i?B)$/;

export type ConfigHelpers = {
  invalid: (key: string, expected: string, got: unknown) => ForgeError;
  fields: (value: unknown, key: string, known: string[]) => Record<string, unknown>;
};

export function configHelpers(path: string): ConfigHelpers {
  const invalid = (key: string, expected: string, got: unknown) =>
    new ForgeError(`${path}: ${key} must be ${expected}, got ${JSON.stringify(got)}`);

  // An object's own keys, after refusing any key forge does not know. `key`
  // is the object's dotted path, "" at the top level.
  const fields = (value: unknown, key: string, known: string[]): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw invalid(key || "the file's content", "a JSON object", value);
    }
    for (const k of Object.keys(value)) {
      if (!known.includes(k)) {
        throw new ForgeError(`${path}: unknown key ${key ? `${key}.${k}` : k} (known: ${known.join(", ")})`);
      }
    }
    return value as Record<string, unknown>;
  };
  return { invalid, fields };
}
