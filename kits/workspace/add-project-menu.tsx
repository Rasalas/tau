import { CornerLeftUp, Folder, FolderOpen, FolderPlus, GitBranch } from "lucide-react";
import { errorMessage, type PaletteItem, type PaletteMenu, type WorkbenchActions, type WorkspaceRef } from "tau";
import type { UiDirectoryListing } from "./protocol.js";

/** What the levels need of the kit: the host's folder listing, the native picker, and where browsing starts. */
export interface AddProjectHost {
  listDirectories(path?: string): Promise<UiDirectoryListing>;
  pickFolder(): Promise<WorkspaceRef | undefined>;
  baseDirectory(): string | undefined;
}

export const CLONE_SOURCE = "workspace.git-clone";

function folderName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

async function open(app: WorkbenchActions, workspace: string): Promise<void> {
  if (!await app.openWorkspace(workspace)) app.notify("That folder could not be opened as a project.");
}

/**
 * One folder as a palette level: add it,
 * go up, or drill into a folder inside it. Each level lists its folder once.
 */
export function folderMenu(host: AddProjectHost, path?: string): PaletteMenu {
  let listing: Promise<UiDirectoryListing> | undefined;
  return {
    title: path ? folderName(path) : "Folders",
    placeholder: "Filter folders…",
    empty: "No folders in here.",
    items: async () => {
      // A base folder that is gone lists the home folder instead of failing.
      listing ??= host.listDirectories(path).catch((error: unknown) => {
        if (path === undefined || path !== host.baseDirectory()) throw error;
        return host.listDirectories();
      });
      const held = await listing;
      const rows: PaletteItem[] = [{
        id: "add",
        label: `Add ${folderName(held.path)}`,
        detail: held.path,
        icon: <FolderPlus size={14} aria-hidden />,
        keywords: ["add", "open", "this folder"],
        run: (app) => open(app, held.workspace.workspaceId),
      }];
      if (held.parent) rows.push({ id: "parent", label: "..", detail: held.parent, icon: <CornerLeftUp size={14} aria-hidden />, keywords: ["up", "parent"], submenu: folderMenu(host, held.parent) });
      for (const directory of held.directories) {
        rows.push({ id: directory.path, label: directory.name, icon: <Folder size={14} aria-hidden />, submenu: folderMenu(host, directory.path) });
      }
      return rows;
    },
  };
}

/** "Add project…": browse the host's folders in the palette, pick one natively, or clone. */
export function addProjectMenu(host: AddProjectHost): PaletteMenu {
  return {
    title: "Add project",
    placeholder: "Create, browse or clone…",
    items: () => [
      { id: "create", label: "New project…", icon: <FolderPlus size={14} aria-hidden />, keywords: ["create", "name"], run: (app) => app.openProjectSources("workspace.new-project") },
      { id: "browse", label: "Browse folders", detail: host.baseDirectory() ?? "~", icon: <FolderOpen size={14} aria-hidden />, keywords: ["local", "folder", "directory"], submenu: folderMenu(host, host.baseDirectory()) },
      {
        id: "pick",
        label: "Choose a folder…",
        icon: <Folder size={14} aria-hidden />,
        keywords: ["local", "finder", "open"],
        run: async (app) => {
          try {
            const picked = await host.pickFolder();
            if (picked) await open(app, picked.workspaceId);
          } catch (error) {
            app.notify(errorMessage(error));
          }
        },
      },
      { id: "clone", label: "Clone Git repository", icon: <GitBranch size={14} aria-hidden />, keywords: ["git", "url", "remote", "repository", "github", "gitlab"], run: (app) => app.openProjectSources(CLONE_SOURCE) },
    ],
  };
}
