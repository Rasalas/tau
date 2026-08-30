import type { DesktopExtension } from "../extension-system";
import { ChangesPanel, FilesPanel } from "./workspace-panels";
import { ObservatoryPanel } from "./observatory-panel";
import { CloneProjectSource, WorkspaceSidebar } from "./project-navigation";
import { titleGeneratorExtension } from "./title-generator";

export const workspaceExtension: DesktopExtension = {
  id: "tau.workspace",
  name: "Workspace Kit",
  activate(plugin) {
    plugin.registerSidebar({ id: "workspace.sidebar", order: 10, Component: WorkspaceSidebar });
    plugin.registerProjectSource({
      id: "workspace.local-folder",
      label: "Local folder",
      description: "Open an existing checkout or any folder on this Mac.",
      glyph: "▱",
      order: 10,
      run: (app) => app.chooseWorkspace(),
    });
    plugin.registerProjectSource({
      id: "workspace.git-clone",
      label: "Clone Git repository",
      description: "Clone an HTTPS or SSH URL, then open it as a project.",
      glyph: "⌘",
      order: 20,
      Component: CloneProjectSource,
    });
    plugin.registerPanel({ id: "files", label: "Files", glyph: "files", order: 10, Component: FilesPanel });
    plugin.registerOptions([
      { id: "group-by-project", kind: "toggle", label: "Group threads by project instead of recency", defaultValue: false },
      { id: "show-settled", kind: "toggle", label: "Show settled shelf", defaultValue: true },
      { id: "compact-rows", kind: "toggle", label: "Compact rows in the thread rail", defaultValue: false },
      { id: "sources", kind: "chips", label: "Add-project sources", values: ["local folder", "git clone"] },
    ]);
    plugin.registerCommand({ id: "workspace.files", label: "Open file index", group: "Project", run: (app) => app.openPanel("files") });
    plugin.registerCommand({ id: "workspace.open-project", label: "Open project…", group: "Project", shortcut: "⌘P", run: (app) => void app.chooseWorkspace() });
    plugin.registerCommand({ id: "workspace.settle", label: "Settle thread", group: "Thread", shortcut: "⌘⇧S", run: (app) => app.settleActiveThread() });
    plugin.registerToolRenderer(
      "workspace.read-renderer",
      (tool) => tool.name === "read" || tool.name === "grep" || tool.name === "find" || tool.name === "ls",
      (tool) => ({
        glyph: "→",
        title: tool.name,
        tone: "read",
        detail: String(tool.args.path ?? tool.args.pattern ?? tool.args.query ?? "workspace"),
      }),
    );
    plugin.registerToolRenderer(
      "workspace.write-renderer",
      (tool) => tool.name === "edit" || tool.name === "write",
      (tool) => ({
        glyph: "±",
        title: tool.name,
        tone: "write",
        detail: String(tool.args.path ?? "file mutation"),
      }),
    );
  },
};

export const reviewExtension: DesktopExtension = {
  id: "tau.review",
  name: "Review Kit",
  activate(plugin) {
    plugin.registerPanel({ id: "changes", label: "Changes", glyph: "changes", order: 20, Component: ChangesPanel });
    plugin.registerOptions([
      { id: "split-diff", kind: "toggle", label: "Open diffs in split view", defaultValue: false },
      { id: "propose-message", kind: "toggle", label: "Propose a commit message from the diff", defaultValue: true },
    ]);
    plugin.registerCommand({ id: "review.open", label: "Review changes", group: "Project", shortcut: "⌘⇧D", run: (app) => app.openReview() });
    plugin.registerCommand({ id: "review.changes", label: "Inspect Git changes", group: "Project", run: (app) => app.openPanel("changes") });
  },
};

export const observatoryExtension: DesktopExtension = {
  id: "tau.observatory",
  name: "Signals",
  activate(plugin) {
    plugin.registerPanel({ id: "observatory", label: "Signals", glyph: "signals", order: 30, Component: ObservatoryPanel });
    plugin.registerCommand({ id: "observatory.open", label: "Open signals panel", group: "Extensions", shortcut: "⌘⇧O", run: (app) => app.openPanel("observatory") });
    plugin.registerToolRenderer(
      "observatory.shell-renderer",
      (tool) => tool.name === "bash" || tool.name === "powershell",
      (tool) => ({
        glyph: "$",
        title: tool.name,
        tone: "shell",
        detail: String(tool.args.command ?? "shell command"),
      }),
    );
  },
};

export const settingsExtension: DesktopExtension = {
  id: "tau.runtime-settings",
  name: "Runtime Controls",
  activate(plugin) {
    plugin.registerCommand({ id: "runtime.settings", label: "Open Settings panel", group: "Runtime", run: (app) => app.openSettings() });
    plugin.registerCommand({ id: "runtime.model", label: "Set model…", group: "Runtime", shortcut: "⌘M", run: (app) => app.openSettings("defaults") });
    plugin.registerCommand({ id: "runtime.thinking", label: "Set thinking level…", group: "Thread", run: (app) => app.openSettings("defaults") });
    plugin.registerCommand({ id: "runtime.new-session", label: "Create new thread", group: "Thread", shortcut: "⌘N", run: (app) => app.newSession() });
    plugin.registerCommand({ id: "runtime.abort", label: "Stop the run", group: "Runtime", shortcut: "Esc", run: (app) => app.abort() });
  },
};

export const bundledExtensions = [
  workspaceExtension,
  reviewExtension,
  observatoryExtension,
  titleGeneratorExtension,
  settingsExtension,
];
