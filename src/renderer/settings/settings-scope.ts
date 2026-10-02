import type { UiProject, UiSession } from "../../shared/contracts";
import type { UiEnvironment } from "../../shared/environments";
import { isFilesystemRoot } from "../../shared/filesystem-root";
import type { SettingsMachine, SettingsProject } from "../../workbench/config-layers-store";

/** A project the scope menu offers; `detail` tells two of the same name apart. */
export interface ScopeProject extends SettingsProject {
  detail?: string;
}

/**
 * The projects a project override can be made for: those of this machine,
 * each once. Another machine's projects have workspace ids this host does not
 * know, a folder opened from the Finder is `/`, and a folder listed twice
 * (by id, or by path) is one project. Two of the same name show their folder.
 */
export function scopeProjects(projects: readonly UiProject[], threads: readonly UiSession[], current?: SettingsProject): ScopeProject[] {
  const foreign = new Set(threads.filter((thread) => thread.machine || thread.backendKind === "machine").map((thread) => thread.workspaceId));
  const known = new Set<string>();
  const list: ScopeProject[] = [];
  const named = new Map<string, number>();
  for (const entry of [current, ...projects.map((project) => ({ workspaceId: project.workspaceId ?? project.path, label: project.name, path: project.displayPath ?? project.path }))]) {
    const where = entry?.path?.replace(/[\\/]+$/u, "");
    if (!entry || !where || isFilesystemRoot(entry.path!) || foreign.has(entry.workspaceId) || known.has(entry.workspaceId) || known.has(where)) continue;
    known.add(entry.workspaceId).add(where);
    list.push({ workspaceId: entry.workspaceId, label: entry.label, path: entry.path! });
    named.set(entry.label.toLowerCase(), (named.get(entry.label.toLowerCase()) ?? 0) + 1);
  }
  for (const project of list) {
    if (named.get(project.label.toLowerCase())! > 1) project.detail = project.path!.replace(/[\\/]+$/u, "").replace(/[\\/][^\\/]*$/u, "").replace(/^\/(?:Users|home)\/[^/]+/u, "~") || "/";
  }
  return list;
}

/**
 * The other machines whose own settings can be edited from here (K170):
 * every saved machine but this window's own, with why a change there is
 * refused (not reachable, paired Read only); its values still show.
 */
export function scopeMachines(environments: readonly UiEnvironment[] | undefined): Array<SettingsMachine & { status: UiEnvironment["status"] }> {
  return (environments ?? []).filter((machine) => !machine.local).map(({ id, name, status, readOnly }) => {
    const blocked = status === "refused" ? `${name} refuses this window.` : status !== "connected" ? `${name} is not reachable right now.` : readOnly ? `${name} paired this window Read only.` : undefined;
    return blocked ? { id, name, status, blocked } : { id, name, status };
  });
}
