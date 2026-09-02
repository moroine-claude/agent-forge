import type { Prompt } from "./context.ts";

export function createPrompt(): Prompt {
  return {
    async pick() { return null; },
    async ask() { return null; },
  };
}
