import { Bot } from "lucide-react";
import { CLAUDE_CODE_BACKEND_KIND, CLAUDE_CODE_HOST_EXTENSION_ID } from "../../shared/claude-code-protocol";
import type { DesktopExtension, RegionProps } from "../extension-system";

/** Names the runtime behind a Claude thread; Pi threads show nothing. */
export function ClaudeCodeStatus({ snapshot }: RegionProps) {
  if (snapshot?.backendKind !== CLAUDE_CODE_BACKEND_KIND) return null;
  return <span className="status-item" title="This thread runs the Claude Code CLI in print mode."><Bot size={12} /> Claude Code</span>;
}

/**
 * Claude Code's desktop half. The backend itself is the host entry; this side
 * only marks Claude threads and gives the package a place in Settings, where
 * the toggle switches both halves.
 */
export const claudeCodeExtension: DesktopExtension = {
  id: CLAUDE_CODE_HOST_EXTENSION_ID,
  name: "Claude Code",
  activate(plugin) {
    plugin.registerStatusItem({ id: "claude-code.runtime", align: "left", order: 40, Component: ClaudeCodeStatus });
  },
};
