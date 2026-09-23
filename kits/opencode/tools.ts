/**
 * A thread restricted to some tools (an agent definition's `tools`), as
 * OpenCode's per-prompt tool switches. The names are Pi's, the ones Tau's
 * cards give OpenCode's calls.
 */
const OPENCODE_TOOLS: Record<string, readonly string[]> = {
  read: ["read"],
  bash: ["bash"],
  edit: ["edit", "multiedit", "patch", "apply_patch"],
  write: ["write"],
  grep: ["grep"],
  find: ["glob"],
  ls: ["list"],
  web_search: ["websearch", "codesearch"],
  fetch: ["webfetch"],
};

/** OpenCode's own tools no Pi name stands for: off in any restricted thread. */
const NEVER = ["task", "batch", "lsp"];
const WRITING = ["bash", "edit", "write"];

export function openCodeToolsWrite(tools: readonly string[]): boolean {
  return WRITING.some((tool) => tools.includes(tool));
}

/** `tools` for a prompt: every OpenCode tool the list leaves out, switched off. */
export function openCodeToolSwitches(tools: readonly string[]): Record<string, boolean> {
  const switches: Record<string, boolean> = {};
  for (const [name, ids] of Object.entries(OPENCODE_TOOLS)) {
    for (const id of ids) switches[id] = tools.includes(name);
  }
  for (const id of NEVER) switches[id] = false;
  return switches;
}
