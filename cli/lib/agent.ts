// The agent seam. forge v2.0 runs one agent, Claude Code; what identifies its
// process lives here.
export type Agent = {
  // Text that appears in the agent's process command line. Used to tell
  // whether a task's agent is already running (forge list, forge stop).
  marker(container: string, task: string): string;
};

// forge-agent (container/forge-agent) carries the marker in its own command
// line and runs claude as its child.
export const AGENT: Agent = {
  marker: (container, task) => `--forge-task ${container}-${task}`,
};
