import type { DesktopExtension, ToolPresentation } from "../extension-system";

const READ_OPERATIONS = new Set([
  "list_apps",
  "list_windows",
  "get_window_state",
  "get_screen_size",
  "get_desktop_state",
  "get_cursor_position",
  "get_agent_cursor_state",
  "health_report",
  "get_config",
  "get_accessibility_tree",
  "zoom",
  "get_browser_state",
  "get_recording_state",
  "get_session_state",
  "check_for_update",
]);

function operationName(toolName: string): string {
  return toolName.slice("computer_use_".length);
}

function titleFor(operation: string): string {
  const title = operation.replace(/^get_/, "").replaceAll("_", " ");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function detailFor(args: Record<string, unknown>): string {
  const app = args.name ?? args.app_name ?? args.bundle_id;
  if (typeof app === "string" && app.length > 0) return app;
  if (typeof args.url === "string" && args.url.length > 0) return args.url;

  const parts: string[] = [];
  if (typeof args.action === "string") parts.push(String(args.action).replaceAll("_", " "));
  if (typeof args.window_id === "number") parts.push(`window ${args.window_id}`);
  if (typeof args.pid === "number") parts.push(`pid ${args.pid}`);
  if (typeof args.session === "string") parts.push(args.session);
  return parts.join(" · ") || "desktop";
}

export function presentComputerUse(toolName: string, args: Record<string, unknown>): ToolPresentation {
  const operation = operationName(toolName);
  return {
    glyph: READ_OPERATIONS.has(operation) ? "◉" : "↗",
    title: titleFor(operation),
    tone: READ_OPERATIONS.has(operation) ? "read" : "write",
    detail: detailFor(args),
    // Cua Driver returns structured JSON plus screenshots. The model needs that
    // payload, but printing it as prose in the transcript is not useful.
    output: "hidden",
  };
}

export const computerUsePresentationExtension: DesktopExtension = {
  id: "tau.computer-use-presentation",
  name: "Computer Use",
  activate(plugin) {
    plugin.registerToolRenderer(
      "computer-use.renderer",
      (tool) => tool.name.startsWith("computer_use_"),
      (tool) => presentComputerUse(tool.name, tool.args),
    );
  },
};
