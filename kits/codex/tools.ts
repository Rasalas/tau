/**
 * A thread restricted to some tools (an agent definition's `tools`), as far
 * as Codex lets Tau switch its own tools off. The names are Pi's, the ones
 * Tau's cards give Codex's calls: its shell reads as `read` or `bash`, its
 * patches as `edit` or `write`.
 */
const SHELL = ["bash", "read", "grep", "find", "ls"];
const WRITING = ["bash", "edit", "write"];

/**
 * Codex's own tools no Pi name stands for, off in any restricted thread.
 * Checked against codex-cli 0.154 by asking a thread for its tool list; its
 * sub-agents stay reachable through code mode, which its shell needs, and
 * run under the thread's own configuration.
 */
const NEVER = ["multi_agent", "multi_agent_v2", "image_generation", "apps", "plugins", "goals", "tool_suggest", "browser_use", "computer_use"];

/** Without a tool that writes, the thread runs in Codex's read-only sandbox. */
export function codexToolsWrite(tools: readonly string[]): boolean {
  return WRITING.some((tool) => tools.includes(tool));
}

/** `codex app-server -c` overrides that switch off what the list leaves out. */
export function codexToolArgs(tools: readonly string[]): string[] {
  const has = (tool: string) => tools.includes(tool);
  const off = [
    // Codex reads files through its shell, so any reading tool keeps it.
    ...(SHELL.some(has) ? [] : ["shell_tool", "unified_exec"]),
    ...(has("view_image") ? [] : ["view_image"]),
    ...NEVER,
  ];
  return [
    ...(has("web_search") ? [] : ["-c", 'web_search="disabled"']),
    ...off.flatMap((feature) => ["-c", `features.${feature}=false`]),
  ];
}
